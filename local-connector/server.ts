import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";

import {
  isExactRecord,
  isLocalConnectorProtocolDiagnostic,
  isSafeOperationId,
  LOCAL_CONNECTOR_DEFAULT_PORT,
  LOCAL_CONNECTOR_ID,
  LOCAL_CONNECTOR_MAX_REQUEST_BYTES,
  LOCAL_CONNECTOR_MAX_RESPONSE_BYTES,
  LOCAL_CONNECTOR_PROTOCOL_VERSION,
  LOCAL_CONNECTOR_VERSION,
  PUBLICLY_SUPPORTED_CODEX_VERSIONS,
  LocalConnectorError,
  type LocalConnectorErrorCode,
  type LocalConnectorExchangeRequest,
  type LocalConnectorProtocolDiagnostic
} from "../lib/agent-exchange/local-connector-protocol.ts";
import {
  CodexAdapterError,
  isCodexProviderFailureDiagnostic,
  type CodexProviderFailureDiagnostic,
  type CodexExecAdapter
} from "./codex-exec-adapter.ts";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_PAIR_BODY_BYTES = 1024;
const MAX_EXCHANGE_BODY_BYTES = Math.ceil(
  (LOCAL_CONNECTOR_MAX_REQUEST_BYTES * 4) / 3
) + 4096;
const MAX_PAIR_FAILURES = 8;
const QUALIFICATION_DIAGNOSTIC_HEADER =
  "X-Patchmark-Qualification-Diagnostic";
const QUALIFICATION_STRUCTURAL_DIAGNOSTIC_HEADER =
  "X-Patchmark-Qualification-Structural-Diagnostic";

export type LocalConnectorCodexAdapter = Pick<
  CodexExecAdapter,
  "exchange" | "inspectCompatibility"
>;

export type PatchmarkLocalConnectorOptions = Readonly<{
  adapter: LocalConnectorCodexAdapter;
  allowInsecureLoopbackOriginsForTests?: boolean;
  allowedOrigins: readonly string[];
  includeQualificationDiagnostics?: boolean;
  onPairingCode?: (pairingCode: string) => void;
  port?: number;
}>;

export type PatchmarkLocalConnector = Readonly<{
  readonly origin: string | null;
  start(): Promise<string>;
  stop(): Promise<void>;
}>;

type Session = Readonly<{
  origin: string;
  token: Buffer;
}>;

type ActiveExchange = Readonly<{
  abortController: AbortController;
  operationId: string;
  origin: string;
  sessionToken: Buffer;
  settled: Promise<void>;
}>;

export function createPatchmarkLocalConnector(
  options: PatchmarkLocalConnectorOptions
): PatchmarkLocalConnector {
  const allowedOrigins = normalizeAllowedOrigins(
    options.allowedOrigins,
    options.allowInsecureLoopbackOriginsForTests === true
  );
  const instanceId = randomBytes(16).toString("base64url");
  let pairingCode: Buffer | null = randomBytes(32);
  let pairFailures = 0;
  let session: Session | null = null;
  let active: ActiveExchange | null = null;
  let server: Server | null = null;
  let connectorOrigin: string | null = null;
  let expectedHost: string | null = null;
  let stopping = false;

  const announcePairingCode = () => {
    if (pairingCode) options.onPairingCode?.(pairingCode.toString("base64url"));
  };

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    let origin: string;
    try {
      if (!expectedHost || request.headers.host !== expectedHost) {
        throw new HttpError(403, "forbidden");
      }
      rejectDuplicateSecurityHeaders(request);
      origin = readAllowedRequestOrigin(request, allowedOrigins);
      setSecurityHeaders(response, origin);
      if (request.method === "OPTIONS") {
        handlePreflight(request, response);
        return;
      }
      if (stopping) throw new HttpError(503, "codex_unavailable");

      if (request.method === "GET" && request.url === "/v1/status") {
        const authenticated = authenticateOptional(request, origin, session);
        const compatibility = await options.adapter.inspectCompatibility();
        sendJson(response, 200, {
          busy: active !== null,
          codex_version: compatibility.codex_version,
          compatibility: compatibility.compatibility,
          connector_id: LOCAL_CONNECTOR_ID,
          connector_version: LOCAL_CONNECTOR_VERSION,
          instance_id: instanceId,
          paired: authenticated,
          protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
          supported_codex_versions: PUBLICLY_SUPPORTED_CODEX_VERSIONS
        });
        return;
      }

      if (request.method === "POST" && request.url === "/v1/pair") {
        requireJsonContentType(request);
        if (!pairingCode) throw new HttpError(409, "forbidden");
        if (active) throw new HttpError(409, "busy");
        if (pairFailures >= MAX_PAIR_FAILURES) {
          throw new HttpError(429, "forbidden");
        }
        const value = await readJsonBody(request, MAX_PAIR_BODY_BYTES);
        if (
          !isExactRecord(value, ["pairing_code", "protocol_version"]) ||
          value.protocol_version !== LOCAL_CONNECTOR_PROTOCOL_VERSION ||
          typeof value.pairing_code !== "string"
        ) {
          throw new HttpError(400, "invalid_request");
        }
        const candidate = decodeBase64UrlSecret(value.pairing_code);
        if (
          !candidate ||
          candidate.byteLength !== pairingCode.byteLength ||
          !timingSafeEqual(candidate, pairingCode)
        ) {
          pairFailures += 1;
          throw new HttpError(403, "forbidden");
        }
        pairingCode.fill(0);
        pairFailures = 0;
        session?.token.fill(0);
        session = { origin, token: randomBytes(32) };
        sendJson(response, 200, {
          instance_id: instanceId,
          protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
          session_token: session.token.toString("base64url")
        });
        pairingCode = randomBytes(32);
        announcePairingCode();
        return;
      }

      if (request.method === "POST" && request.url === "/v1/exchanges") {
        requireJsonContentType(request);
        const authenticatedSession = authenticate(request, origin, session);
        if (active) throw new HttpError(409, "busy");
        const value = await readJsonBody(request, MAX_EXCHANGE_BODY_BYTES);
        const exchange = validateExchangeRequest(value);
        const requestBytes = decodeCanonicalBase64(exchange.request_base64);
        if (requestBytes.byteLength !== exchange.request_byte_length) {
          throw new HttpError(400, "invalid_request");
        }
        const expectedDigest = Buffer.from(exchange.request_sha256, "hex");
        const actualDigest = createHash("sha256").update(requestBytes).digest();
        if (!timingSafeEqual(actualDigest, expectedDigest)) {
          throw new HttpError(400, "invalid_request");
        }

        const abortController = new AbortController();
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const owned: ActiveExchange = {
          abortController,
          operationId: exchange.operation_id,
          origin,
          sessionToken: Buffer.from(authenticatedSession.token),
          settled
        };
        active = owned;
        let responseFinished = false;
        const cancelOnDisconnect = () => {
          if (!responseFinished && active === owned) abortController.abort();
        };
        request.once("aborted", cancelOnDisconnect);
        response.once("close", cancelOnDisconnect);
        try {
          const responseBytes = await options.adapter.exchange({
            maxResponseBytes: exchange.max_response_bytes,
            requestBytes,
            signal: abortController.signal
          });
          if (abortController.signal.aborted) {
            throw new CodexAdapterError("cancelled", "The exchange was cancelled.");
          }
          if (responseBytes.byteLength > exchange.max_response_bytes) {
            throw new CodexAdapterError(
              "response_too_large",
              "The response exceeded the browser-owned ceiling."
            );
          }
          responseFinished = true;
          sendJson(response, 200, {
            operation_id: exchange.operation_id,
            protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
            response_base64: Buffer.from(responseBytes).toString("base64"),
            response_byte_length: responseBytes.byteLength
          });
        } finally {
          request.removeListener("aborted", cancelOnDisconnect);
          response.removeListener("close", cancelOnDisconnect);
          if (active === owned) active = null;
          settle();
        }
        return;
      }

      const cancelMatch = /^\/v1\/exchanges\/([A-Za-z0-9._:-]{1,128})$/.exec(
        request.url ?? ""
      );
      if (request.method === "DELETE" && cancelMatch) {
        const authenticatedSession = authenticate(request, origin, session);
        if (
          !active ||
          active.operationId !== cancelMatch[1] ||
          active.origin !== origin ||
          active.sessionToken.byteLength !== authenticatedSession.token.byteLength ||
          !timingSafeEqual(active.sessionToken, authenticatedSession.token)
        ) {
          throw new HttpError(404, "not_found");
        }
        active.abortController.abort();
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method === "POST" && request.url === "/v1/revoke") {
        const authenticatedSession = authenticate(request, origin, session);
        session = null;
        if (
          active &&
          active.sessionToken.byteLength === authenticatedSession.token.byteLength &&
          timingSafeEqual(active.sessionToken, authenticatedSession.token)
        ) {
          active.abortController.abort();
        }
        pairingCode = randomBytes(32);
        pairFailures = 0;
        announcePairingCode();
        response.statusCode = 204;
        response.end();
        return;
      }

      throw new HttpError(404, "not_found");
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.destroy();
        return;
      }
      const mapped = mapError(error);
      if (request.headers.origin && allowedOrigins.has(request.headers.origin)) {
        setSecurityHeaders(response, request.headers.origin);
      }
      sendError(
        response,
        mapped.status,
        mapped.code,
        options.includeQualificationDiagnostics ? mapped.diagnostic : null,
        options.includeQualificationDiagnostics
          ? mapped.qualificationDiagnostic
          : null
      );
    }
  };

  return {
    get origin() {
      return connectorOrigin;
    },
    async start() {
      if (server) throw new Error("The local connector is already running.");
      stopping = false;
      const nextServer = createServer(
        {
          headersTimeout: 10_000,
          keepAliveTimeout: 5_000,
          maxHeaderSize: 8 * 1024,
          requestTimeout: 0
        },
        (request, response) => void handler(request, response)
      );
      server = nextServer;
      await new Promise<void>((resolve, reject) => {
        const rejectStart = (error: Error) => {
          server = null;
          reject(error);
        };
        nextServer.once("error", rejectStart);
        nextServer.listen(
          { host: LOOPBACK_HOST, port: options.port ?? LOCAL_CONNECTOR_DEFAULT_PORT },
          () => {
            nextServer.removeListener("error", rejectStart);
            resolve();
          }
        );
      });
      const address = nextServer.address();
      if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
        await stopServer(nextServer);
        server = null;
        throw new Error("The connector did not bind to the required loopback address.");
      }
      expectedHost = `${LOOPBACK_HOST}:${address.port}`;
      connectorOrigin = `http://${expectedHost}`;
      announcePairingCode();
      return connectorOrigin;
    },
    async stop() {
      if (!server) return;
      stopping = true;
      const closingServer = server;
      server = null;
      const owned = active;
      owned?.abortController.abort();
      await Promise.all([
        stopServer(closingServer),
        owned?.settled ?? Promise.resolve()
      ]);
      if (pairingCode) pairingCode.fill(0);
      pairingCode = null;
      session?.token.fill(0);
      session = null;
      connectorOrigin = null;
      expectedHost = null;
      active = null;
    }
  };
}

function normalizeAllowedOrigins(
  origins: readonly string[],
  allowInsecureLoopbackOrigins: boolean
): ReadonlySet<string> {
  if (origins.length === 0) throw new Error("At least one allowed Patchmark origin is required.");
  const normalized = new Set<string>();
  for (const origin of origins) {
    const parsed = new URL(origin);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol !== "https:" &&
        !(allowInsecureLoopbackOrigins && parsed.protocol === "http:" && loopback))
    ) {
      throw new Error(`Rejected unsafe allowed origin: ${origin}`);
    }
    normalized.add(origin);
  }
  return normalized;
}

function readAllowedRequestOrigin(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
): string {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
    throw new HttpError(403, "forbidden");
  }
  return origin;
}

function setSecurityHeaders(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function handlePreflight(
  request: IncomingMessage,
  response: ServerResponse
): void {
  const route = request.url;
  const requestedMethod = request.headers["access-control-request-method"];
  const allowedMethods =
    route === "/v1/status"
      ? ["GET"]
      : route === "/v1/pair"
        ? ["POST"]
        : route === "/v1/exchanges" || route === "/v1/revoke"
          ? ["POST"]
          : /^\/v1\/exchanges\/[A-Za-z0-9._:-]{1,128}$/.test(route ?? "")
            ? ["DELETE"]
            : [];
  if (!requestedMethod || !allowedMethods.includes(requestedMethod)) {
    throw new HttpError(403, "forbidden");
  }
  const requestedHeaders = String(
    request.headers["access-control-request-headers"] ?? ""
  )
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (
    requestedHeaders.some(
      (header) => !["authorization", "content-type"].includes(header)
    )
  ) {
    throw new HttpError(403, "forbidden");
  }
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", allowedMethods.join(", "));
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  response.statusCode = 204;
  response.end();
}

function rejectDuplicateSecurityHeaders(request: IncomingMessage): void {
  for (const name of ["authorization", "content-type", "host", "origin"]) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === name) count += 1;
    }
    if (count > 1) throw new HttpError(400, "invalid_request");
  }
}

function authenticateOptional(
  request: IncomingMessage,
  origin: string,
  session: Session | null
): boolean {
  if (!request.headers.authorization) return false;
  try {
    authenticate(request, origin, session);
    return true;
  } catch {
    return false;
  }
}

function authenticate(
  request: IncomingMessage,
  origin: string,
  session: Session | null
): Session {
  if (!session || session.origin !== origin) {
    throw new HttpError(401, "not_paired");
  }
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string"
    ? /^Patchmark ([A-Za-z0-9_-]{43})$/.exec(authorization)
    : null;
  const token = match ? decodeBase64UrlSecret(match[1]) : null;
  if (
    !token ||
    token.byteLength !== session.token.byteLength ||
    !timingSafeEqual(token, session.token)
  ) {
    throw new HttpError(401, "not_paired");
  }
  return session;
}

function requireJsonContentType(request: IncomingMessage): void {
  if (
    request.headers["content-type"] !== "application/json" ||
    (request.headers["content-encoding"] &&
      request.headers["content-encoding"] !== "identity")
  ) {
    throw new HttpError(415, "invalid_request");
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new HttpError(413, "request_too_large");
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > maxBytes) throw new HttpError(413, "request_too_large");
    chunks.push(bytes);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, "invalid_request");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request");
  }
}

function validateExchangeRequest(value: unknown): LocalConnectorExchangeRequest {
  if (
    !isExactRecord(value, [
      "expected_response_protocol",
      "expected_response_protocol_version",
      "max_response_bytes",
      "operation_id",
      "protocol_version",
      "request_base64",
      "request_byte_length",
      "request_sha256"
    ]) ||
    value.protocol_version !== LOCAL_CONNECTOR_PROTOCOL_VERSION ||
    value.expected_response_protocol !== "patchmark.comment_reply_import" ||
    value.expected_response_protocol_version !== 2 ||
    !isSafeOperationId(value.operation_id) ||
    typeof value.request_base64 !== "string" ||
    !Number.isSafeInteger(value.request_byte_length) ||
    (value.request_byte_length as number) <= 0 ||
    (value.request_byte_length as number) > LOCAL_CONNECTOR_MAX_REQUEST_BYTES ||
    typeof value.request_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.request_sha256) ||
    !Number.isSafeInteger(value.max_response_bytes) ||
    (value.max_response_bytes as number) <= 0 ||
    (value.max_response_bytes as number) > LOCAL_CONNECTOR_MAX_RESPONSE_BYTES
  ) {
    throw new HttpError(400, "invalid_request");
  }
  return value as LocalConnectorExchangeRequest;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new HttpError(400, "invalid_request");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new HttpError(400, "invalid_request");
  }
  return bytes;
}

function decodeBase64UrlSecret(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.statusCode = status;
  response.setHeader("Content-Length", String(body.byteLength));
  response.setHeader("Content-Type", "application/json");
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: LocalConnectorErrorCode,
  structuralDiagnostic: LocalConnectorProtocolDiagnostic | null,
  qualificationDiagnostic: CodexProviderFailureDiagnostic | null
): void {
  if (structuralDiagnostic) {
    response.setHeader(
      QUALIFICATION_STRUCTURAL_DIAGNOSTIC_HEADER,
      Buffer.from(JSON.stringify(structuralDiagnostic), "utf8").toString(
        "base64url"
      )
    );
  }
  if (qualificationDiagnostic) {
    response.setHeader(
      QUALIFICATION_DIAGNOSTIC_HEADER,
      Buffer.from(JSON.stringify(qualificationDiagnostic), "utf8").toString(
        "base64url"
      )
    );
  }
  sendJson(response, status, {
    error: { code },
    protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION
  });
}

class HttpError extends Error {
  readonly code: LocalConnectorErrorCode;
  readonly status: number;

  constructor(status: number, code: LocalConnectorErrorCode) {
    super(code);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
  }
}

function mapError(error: unknown): Readonly<{
  code: LocalConnectorErrorCode;
  diagnostic: LocalConnectorProtocolDiagnostic | null;
  qualificationDiagnostic: CodexProviderFailureDiagnostic | null;
  status: number;
}> {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      diagnostic: null,
      qualificationDiagnostic: null,
      status: error.status
    };
  }
  if (error instanceof CodexAdapterError || error instanceof LocalConnectorError) {
    const statuses: Partial<Record<LocalConnectorErrorCode, number>> = {
      authentication_required: 401,
      busy: 409,
      cancelled: 409,
      codex_unavailable: 503,
      codex_unsupported: 412,
      invalid_request: 400,
      request_too_large: 413,
      response_too_large: 413
    };
    return {
      code: error.code,
      diagnostic:
        error instanceof CodexAdapterError &&
        isLocalConnectorProtocolDiagnostic(error.diagnostic)
          ? error.diagnostic
          : null,
      qualificationDiagnostic:
        error instanceof CodexAdapterError &&
        isCodexProviderFailureDiagnostic(error.qualificationDiagnostic)
          ? error.qualificationDiagnostic
          : null,
      status: statuses[error.code] ?? 502
    };
  }
  return {
    code: "provider_failed",
    diagnostic: null,
    qualificationDiagnostic: null,
    status: 502
  };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}
