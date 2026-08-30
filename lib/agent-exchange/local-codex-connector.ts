"use client";

import type {
  AgentExchangeAvailability,
  AgentExchangeConnector,
  AgentExchangeConnectorResponse,
  AgentExchangeConnectorSubmission
} from "./contracts.ts";
import {
  base64ToBytes,
  bytesToBase64,
  isExactRecord,
  LOCAL_CONNECTOR_DEFAULT_URL,
  LOCAL_CONNECTOR_ID,
  LOCAL_CONNECTOR_MAX_REQUEST_BYTES,
  LOCAL_CONNECTOR_MAX_RESPONSE_BYTES,
  LOCAL_CONNECTOR_PROTOCOL_VERSION,
  LOCAL_CONNECTOR_VERSION,
  LocalConnectorError,
  type LocalConnectorErrorCode,
  type LocalConnectorExchangeResponse,
  type LocalConnectorStatus
} from "./local-connector-protocol.ts";

export type LocalCodexPairingStatus = LocalConnectorStatus;

export interface LocalCodexPairableConnector extends AgentExchangeConnector {
  checkPairingStatus(input: Readonly<{
    signal: AbortSignal;
  }>): Promise<LocalCodexPairingStatus>;
  pair(input: Readonly<{
    pairing_code: string;
    signal: AbortSignal;
  }>): Promise<void>;
}

export function isLocalCodexPairableConnector(
  value: unknown
): value is LocalCodexPairableConnector {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalCodexPairableConnector>;
  return (
    typeof candidate.checkPairingStatus === "function" &&
    typeof candidate.pair === "function"
  );
}

export class LocalCodexConnectorSession {
  readonly #endpoint: string;
  #instanceId: string | null = null;
  #token: string | null = null;

  constructor(endpoint = LOCAL_CONNECTOR_DEFAULT_URL) {
    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("The local connector endpoint must be an exact loopback URL.");
    }
    this.#endpoint = parsed.origin;
  }

  createConnector(): LocalCodexPairableConnector {
    return new LocalCodexAgentExchangeConnector(this);
  }

  async status(signal: AbortSignal): Promise<LocalConnectorStatus> {
    const response = await this.#request("/v1/status", {
      method: "GET",
      signal
    });
    const value = await readJson(response, 16 * 1024);
    if (
      !isExactRecord(value, [
        "busy",
        "codex_version",
        "compatibility",
        "instance_id",
        "paired",
        "protocol_version"
      ]) ||
      value.protocol_version !== LOCAL_CONNECTOR_PROTOCOL_VERSION ||
      typeof value.busy !== "boolean" ||
      (value.codex_version !== null && typeof value.codex_version !== "string") ||
      !["supported", "unavailable", "unsupported"].includes(
        value.compatibility as string
      ) ||
      typeof value.instance_id !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(value.instance_id) ||
      typeof value.paired !== "boolean"
    ) {
      throw protocolError();
    }
    const status = value as LocalConnectorStatus;
    if (this.#instanceId && status.instance_id !== this.#instanceId) {
      this.#token = null;
    }
    this.#instanceId = status.instance_id;
    if (!status.paired) this.#token = null;
    return status;
  }

  async pair(pairingCode: string, signal: AbortSignal): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(pairingCode)) {
      throw new LocalConnectorError(
        "invalid_request",
        "Enter the exact one-time pairing code shown by the local connector."
      );
    }
    const response = await this.#request("/v1/pair", {
      body: JSON.stringify({
        pairing_code: pairingCode,
        protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal
    });
    const value = await readJson(response, 16 * 1024);
    if (
      !isExactRecord(value, ["instance_id", "protocol_version", "session_token"]) ||
      value.protocol_version !== LOCAL_CONNECTOR_PROTOCOL_VERSION ||
      typeof value.instance_id !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(value.instance_id) ||
      typeof value.session_token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.session_token)
    ) {
      throw protocolError();
    }
    this.#instanceId = value.instance_id;
    this.#token = value.session_token;
  }

  async submit(
    input: AgentExchangeConnectorSubmission
  ): Promise<AgentExchangeConnectorResponse> {
    if (!this.#token) {
      throw new LocalConnectorError("not_paired", "The local connector is not paired.");
    }
    const { binding, request_bytes: requestBytes, signal } = input;
    if (
      requestBytes.byteLength === 0 ||
      requestBytes.byteLength > LOCAL_CONNECTOR_MAX_REQUEST_BYTES ||
      requestBytes.byteLength !== binding.request_byte_length
    ) {
      throw new LocalConnectorError(
        "request_too_large",
        "The prepared request is outside the local connector limit."
      );
    }
    const cancel = () => {
      void this.#request(
        `/v1/exchanges/${encodeURIComponent(binding.operation_id)}`,
        { method: "DELETE" }
      ).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await this.#request("/v1/exchanges", {
        body: JSON.stringify({
          expected_response_protocol: binding.expected_response_protocol,
          expected_response_protocol_version:
            binding.expected_response_protocol_version,
          max_response_bytes: Math.min(
            binding.max_response_bytes,
            LOCAL_CONNECTOR_MAX_RESPONSE_BYTES
          ),
          operation_id: binding.operation_id,
          protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
          request_base64: bytesToBase64(requestBytes),
          request_byte_length: requestBytes.byteLength,
          request_sha256: binding.request_sha256
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal
      });
      const value = await readJson(
        response,
        Math.ceil(
          (Math.min(
            binding.max_response_bytes,
            LOCAL_CONNECTOR_MAX_RESPONSE_BYTES
          ) * 4) /
            3
        ) + 4096
      );
      if (!isExchangeResponse(value, binding.operation_id)) {
        throw protocolError();
      }
      const responseBytes = base64ToBytes(value.response_base64);
      if (responseBytes.byteLength !== value.response_byte_length) {
        throw protocolError();
      }
      return {
        binding: {
          ...binding,
          response_byte_length: responseBytes.byteLength,
          response_protocol: binding.expected_response_protocol,
          response_protocol_version: binding.expected_response_protocol_version
        },
        response_bytes: responseBytes
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.#token) headers.set("Authorization", `Patchmark ${this.#token}`);
    let response: Response;
    try {
      response = await fetch(`${this.#endpoint}${path}`, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        headers,
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
    } catch {
      if (init.signal?.aborted) {
        throw new LocalConnectorError("cancelled", "The connector request was cancelled.");
      }
      throw new LocalConnectorError(
        "codex_unavailable",
        "The local connector could not be reached."
      );
    }
    if (!response.ok) {
      const value = await readJson(response, 16 * 1024).catch(() => null);
      const code = readErrorCode(value) ?? "connector_protocol_error";
      if (response.status === 401 || code === "not_paired") this.#token = null;
      throw new LocalConnectorError(code, userMessageFor(code), response.status);
    }
    return response;
  }
}

class LocalCodexAgentExchangeConnector implements LocalCodexPairableConnector {
  readonly descriptor = Object.freeze({
    id: LOCAL_CONNECTOR_ID,
    version: LOCAL_CONNECTOR_VERSION
  });
  readonly #session: LocalCodexConnectorSession;

  constructor(session: LocalCodexConnectorSession) {
    this.#session = session;
  }

  checkPairingStatus(input: Readonly<{ signal: AbortSignal }>) {
    return this.#session.status(input.signal);
  }

  pair(input: Readonly<{ pairing_code: string; signal: AbortSignal }>) {
    return this.#session.pair(input.pairing_code, input.signal);
  }

  async checkAvailability(input: Readonly<{
    signal: AbortSignal;
  }>): Promise<AgentExchangeAvailability> {
    const status = await this.#session.status(input.signal);
    if (status.compatibility === "unsupported") {
      return { status: "unavailable", reason: "connector_unsupported" };
    }
    if (
      status.compatibility !== "supported" ||
      !status.paired ||
      status.busy
    ) {
      return { status: "unavailable", reason: "connector_not_ready" };
    }
    return { status: "available" };
  }

  submit(input: AgentExchangeConnectorSubmission) {
    return this.#session.submit(input);
  }

  close(): void {
    // The operation connector is single-use; the in-memory pairing session is not.
  }
}

function isExchangeResponse(
  value: unknown,
  operationId: string
): value is LocalConnectorExchangeResponse {
  return (
    isExactRecord(value, [
      "operation_id",
      "protocol_version",
      "response_base64",
      "response_byte_length"
    ]) &&
    value.protocol_version === LOCAL_CONNECTOR_PROTOCOL_VERSION &&
    value.operation_id === operationId &&
    typeof value.response_base64 === "string" &&
    Number.isSafeInteger(value.response_byte_length) &&
    (value.response_byte_length as number) >= 0 &&
    (value.response_byte_length as number) <= LOCAL_CONNECTOR_MAX_RESPONSE_BYTES
  );
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") throw protocolError();
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new LocalConnectorError(
      "response_too_large",
      "The local connector response exceeded its browser limit."
    );
  }
  if (!response.body) throw protocolError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new LocalConnectorError(
          "response_too_large",
          "The local connector response exceeded its browser limit."
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw protocolError();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw protocolError();
  }
}

function readErrorCode(value: unknown): LocalConnectorErrorCode | null {
  if (
    !isExactRecord(value, ["error", "protocol_version"]) ||
    value.protocol_version !== LOCAL_CONNECTOR_PROTOCOL_VERSION ||
    !isExactRecord(value.error, ["code"]) ||
    typeof value.error.code !== "string"
  ) {
    return null;
  }
  const known: LocalConnectorErrorCode[] = [
    "authentication_required",
    "busy",
    "cancelled",
    "codex_unavailable",
    "codex_unsupported",
    "connector_protocol_error",
    "forbidden",
    "invalid_request",
    "not_found",
    "not_paired",
    "provider_failed",
    "request_too_large",
    "response_too_large"
  ];
  return known.includes(value.error.code as LocalConnectorErrorCode)
    ? (value.error.code as LocalConnectorErrorCode)
    : null;
}

function protocolError(): LocalConnectorError {
  return new LocalConnectorError(
    "connector_protocol_error",
    "The local connector returned an invalid response."
  );
}

function userMessageFor(code: LocalConnectorErrorCode): string {
  switch (code) {
    case "authentication_required":
      return "Codex needs you to sign in locally before sending.";
    case "busy":
      return "The local connector is already handling another request.";
    case "codex_unsupported":
      return "The installed Codex version has not been qualified for this connector.";
    case "not_paired":
      return "The local connector must be paired again.";
    case "request_too_large":
    case "response_too_large":
      return "The connector exchange exceeded its safe size limit.";
    case "cancelled":
      return "The connector request was cancelled.";
    default:
      return "The local Codex exchange failed safely.";
  }
}
