import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_CONNECTOR_MAX_RESPONSE_BYTES,
  PUBLICLY_SUPPORTED_CODEX_VERSIONS,
  type LocalConnectorErrorCode,
  type LocalConnectorProtocolDiagnostic,
  type LocalConnectorProtocolDiagnosticCategory
} from "../lib/agent-exchange/local-connector-protocol.ts";

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const TERMINATION_GRACE_MS = 2_000;

export const CODEX_EXEC_FIXED_ARGUMENTS = Object.freeze([
  "exec",
  "--strict-config",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "--json",
  "-c",
  'web_search="disabled"',
  "-c",
  "tools.update_plan.enabled=false",
  "-c",
  "tools.experimental_request_user_input.enabled=false",
  ...[
    "shell_tool",
    "unified_exec",
    "view_image",
    "multi_agent",
    "multi_agent_v2",
    "apps",
    "plugins",
    "tool_suggest",
    "recommended_plugins",
    "remote_plugin",
    "plugin_sharing",
    "enable_mcp_apps",
    "standalone_web_search",
    "browser_use",
    "browser_use_full_cdp_access",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "hooks",
    "in_app_browser",
    "memories",
    "external_agent_memory_import",
    "chronicle",
    "code_mode"
  ].flatMap((feature) => ["-c", `features.${feature}=false`])
]);

export type CodexCompatibility = Readonly<{
  codex_version: string | null;
  compatibility: "supported" | "unavailable" | "unsupported";
}>;

export class CodexAdapterError extends Error {
  readonly code: LocalConnectorErrorCode;
  readonly diagnostic: LocalConnectorProtocolDiagnostic | null;
  readonly qualificationDiagnostic: CodexProviderFailureDiagnostic | null;

  constructor(
    code: LocalConnectorErrorCode,
    message: string,
    diagnostic: LocalConnectorProtocolDiagnostic | null = null,
    qualificationDiagnostic: CodexProviderFailureDiagnostic | null = null
  ) {
    super(message);
    this.name = "CodexAdapterError";
    this.code = code;
    this.diagnostic = diagnostic;
    this.qualificationDiagnostic = qualificationDiagnostic;
  }
}

export const CODEX_PROVIDER_FAILURE_SOURCES = Object.freeze([
  "adapter_exception",
  "item_error",
  "operation_timeout",
  "process_exit",
  "process_signal",
  "stderr_overflow",
  "stream_integrity",
  "top_level_error",
  "turn_failed"
] as const);

export type CodexProviderFailureSource =
  (typeof CODEX_PROVIDER_FAILURE_SOURCES)[number];

export type CodexProviderFailureDiagnostic = Readonly<{
  error_message_byte_length: number | null;
  error_message_fingerprints_match: boolean | null;
  error_message_present: boolean;
  error_message_sha256: string | null;
  exit_code: number | null;
  failure_source: CodexProviderFailureSource;
  final_response_seen: boolean;
  item_error_count: number;
  item_error_phase: "in_turn" | "mixed" | "pre_turn" | null;
  item_error_seen: boolean;
  item_type: string | null;
  signal_name: string | null;
  stderr_byte_length: number;
  stderr_present: boolean;
  stderr_sha256: string | null;
  stream_integrity_compromised: boolean;
  terminal_event_seen: boolean;
  timeout_fired: boolean;
  top_level_error_seen: boolean;
  top_level_event_type: string | null;
  turn_failed_seen: boolean;
  turn_status: string | null;
  typed_error_code: string | null;
}>;

export function isCodexProviderFailureDiagnostic(
  value: unknown
): value is CodexProviderFailureDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "error_message_byte_length",
    "error_message_fingerprints_match",
    "error_message_present",
    "error_message_sha256",
    "exit_code",
    "failure_source",
    "final_response_seen",
    "item_error_count",
    "item_error_phase",
    "item_error_seen",
    "item_type",
    "signal_name",
    "stderr_byte_length",
    "stderr_present",
    "stderr_sha256",
    "stream_integrity_compromised",
    "terminal_event_seen",
    "timeout_fired",
    "top_level_error_seen",
    "top_level_event_type",
    "turn_failed_seen",
    "turn_status",
    "typed_error_code"
  ].sort();
  const actualKeys = Object.keys(record).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    typeof record.failure_source === "string" &&
    CODEX_PROVIDER_FAILURE_SOURCES.some(
      (source) => source === record.failure_source
    ) &&
    isSafeOptionalInteger(record.error_message_byte_length) &&
    (record.error_message_fingerprints_match === null ||
      typeof record.error_message_fingerprints_match === "boolean") &&
    typeof record.error_message_present === "boolean" &&
    (record.error_message_sha256 === null ||
      (typeof record.error_message_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(record.error_message_sha256))) &&
    isSafeOptionalInteger(record.exit_code) &&
    typeof record.final_response_seen === "boolean" &&
    Number.isSafeInteger(record.item_error_count) &&
    (record.item_error_count as number) >= 0 &&
    (record.item_error_phase === null ||
      record.item_error_phase === "in_turn" ||
      record.item_error_phase === "mixed" ||
      record.item_error_phase === "pre_turn") &&
    typeof record.item_error_seen === "boolean" &&
    safeDiagnosticToken(record.item_type) === record.item_type &&
    (record.signal_name === null ||
      (typeof record.signal_name === "string" &&
        /^[A-Z][A-Z0-9]{1,15}$/.test(record.signal_name))) &&
    Number.isSafeInteger(record.stderr_byte_length) &&
    (record.stderr_byte_length as number) >= 0 &&
    typeof record.stderr_present === "boolean" &&
    (record.stderr_sha256 === null ||
      (typeof record.stderr_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(record.stderr_sha256))) &&
    typeof record.stream_integrity_compromised === "boolean" &&
    typeof record.terminal_event_seen === "boolean" &&
    typeof record.timeout_fired === "boolean" &&
    typeof record.top_level_error_seen === "boolean" &&
    safeDiagnosticToken(record.top_level_event_type) ===
      record.top_level_event_type &&
    typeof record.turn_failed_seen === "boolean" &&
    safeDiagnosticToken(record.turn_status) === record.turn_status &&
    safeDiagnosticToken(record.typed_error_code) === record.typed_error_code
  );
}

export type CodexExecAdapterOptions = Readonly<{
  executable: string;
  environment?: Readonly<Record<string, string>>;
  fixedArguments?: readonly string[];
  operationTimeoutMs?: number;
  qualifiedVersions?: readonly string[];
}>;

export class CodexExecAdapter {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #executable: string;
  readonly #fixedArguments: readonly string[];
  readonly #operationTimeoutMs: number;
  readonly #qualifiedVersions: ReadonlySet<string>;

  constructor(options: CodexExecAdapterOptions) {
    if (!options.executable || options.executable.includes("\0")) {
      throw new Error("A locally configured Codex executable is required.");
    }
    this.#executable = options.executable;
    this.#fixedArguments = Object.freeze(
      [...(options.fixedArguments ?? CODEX_EXEC_FIXED_ARGUMENTS)]
    );
    this.#environment = Object.freeze(
      options.environment
        ? { ...options.environment }
        : createCodexEnvironment(process.env)
    );
    this.#operationTimeoutMs =
      options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
    const qualifiedVersions =
      options.qualifiedVersions ?? PUBLICLY_SUPPORTED_CODEX_VERSIONS;
    if (qualifiedVersions.length === 0) {
      throw new Error("At least one exact qualified Codex version is required.");
    }
    this.#qualifiedVersions = new Set(qualifiedVersions);
  }

  async inspectCompatibility(
    signal?: AbortSignal
  ): Promise<CodexCompatibility> {
    if (signal?.aborted) throw cancelledError();
    try {
      if (this.#executable.includes("/") || this.#executable.includes("\\")) {
        await access(this.#executable, fsConstants.X_OK);
      }
    } catch {
      return { codex_version: null, compatibility: "unavailable" };
    }

    try {
      const result = await runBoundedChild({
        args: ["--version"],
        cwd: tmpdir(),
        environment: this.#environment,
        executable: this.#executable,
        maxStderrBytes: MAX_STDERR_BYTES,
        maxStdoutBytes: 1024,
        signal,
        timeoutMs: VERSION_TIMEOUT_MS
      });
      if (signal?.aborted) throw cancelledError();
      if (result.code !== 0 || result.signal) {
        return { codex_version: null, compatibility: "unavailable" };
      }
      const match = /^(?:codex-cli|codex)\s+([^\s]+)\s*$/.exec(
        result.stdout.toString("utf8")
      );
      if (!match) {
        return { codex_version: null, compatibility: "unsupported" };
      }
      const version = match[1];
      return {
        codex_version: version,
        compatibility:
          this.#qualifiedVersions.has(version) ? "supported" : "unsupported"
      };
    } catch (error) {
      if (
        signal?.aborted ||
        isAbortError(error) ||
        (error instanceof CodexAdapterError && error.code === "cancelled")
      ) {
        throw cancelledError();
      }
      return { codex_version: null, compatibility: "unavailable" };
    }
  }

  async exchange(input: Readonly<{
    maxResponseBytes: number;
    requestBytes: Uint8Array;
    signal: AbortSignal;
  }>): Promise<Uint8Array> {
    if (input.signal.aborted) throw cancelledError();
    if (
      !Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes <= 0 ||
      input.maxResponseBytes > LOCAL_CONNECTOR_MAX_RESPONSE_BYTES
    ) {
      throw new CodexAdapterError(
        "invalid_request",
        "The response ceiling is outside the connector policy."
      );
    }
    const canonicalText = decodeCanonicalUtf8(input.requestBytes);
    const compatibility = await this.inspectCompatibility(input.signal);
    if (compatibility.compatibility === "unavailable") {
      throw new CodexAdapterError(
        "codex_unavailable",
        "The configured Codex executable is unavailable."
      );
    }
    if (compatibility.compatibility !== "supported") {
      throw new CodexAdapterError(
        "codex_unsupported",
        "The configured Codex version is outside the qualified allowlist."
      );
    }

    const operationDirectory = await mkdtemp(
      join(tmpdir(), "patchmark-codex-exchange-")
    );
    try {
      await chmod(operationDirectory, 0o700);
      const streamCeiling = Math.min(
        MAX_STDOUT_BYTES,
        Math.max(1024 * 1024, input.maxResponseBytes * 8)
      );
      const result = await runBoundedChild({
        args: this.#fixedArguments,
        cwd: operationDirectory,
        environment: this.#environment,
        executable: this.#executable,
        input: Buffer.from(canonicalText, "utf8"),
        maxStderrBytes: MAX_STDERR_BYTES,
        maxStdoutBytes: streamCeiling,
        inspectStdoutLine: createCodexJsonlLineInspector(),
        signal: input.signal,
        timeoutMs: this.#operationTimeoutMs
      });
      if (input.signal.aborted) throw cancelledError();
      if (result.inspectionError) throw result.inspectionError;
      if (result.overflow === "stdout") {
        throw new CodexAdapterError(
          "response_too_large",
          "The Codex event stream exceeded its connector limit."
        );
      }
      if (result.overflow === "stderr") {
        throw new CodexAdapterError(
          "provider_failed",
          "Codex diagnostics exceeded their connector limit.",
          null,
          createProviderFailureDiagnostic({
            failureSource: "stderr_overflow",
            parsed: tryExtractCodexStream(result.stdout),
            result
          })
        );
      }
      if (
        result.stdout.byteLength === 0 &&
        (result.code !== 0 || result.signal)
      ) {
        throw new CodexAdapterError(
          "provider_failed",
          "Codex exited before emitting a machine event.",
          null,
          createProviderFailureDiagnostic({
            failureSource: classifyProcessFailureSource(result),
            parsed: null,
            result
          })
        );
      }
      const parsed = extractCodexStream(result.stdout);
      if (result.code !== 0 || result.signal) {
        throw new CodexAdapterError(
          parsed.failureCode ?? "provider_failed",
          "Codex did not complete the exchange cleanly.",
          null,
          createProviderFailureDiagnostic({
            failureSource: classifyProviderFailureSource(parsed, result),
            parsed,
            result
          })
        );
      }
      if (parsed.failureCode) {
        throw new CodexAdapterError(
          parsed.failureCode,
          "Codex reported a failed turn.",
          null,
          createProviderFailureDiagnostic({
            failureSource: classifyProviderFailureSource(parsed, result),
            parsed,
            result
          })
        );
      }
      if (!parsed.completed || parsed.finalMessage === null) {
        throw streamProtocolError("ambiguous_final_response");
      }
      const responseBytes = new TextEncoder().encode(parsed.finalMessage);
      if (responseBytes.byteLength > input.maxResponseBytes) {
        throw new CodexAdapterError(
          "response_too_large",
          "The Codex response exceeded the requested response ceiling."
        );
      }
      return responseBytes;
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) throw cancelledError();
      if (error instanceof CodexAdapterError) throw error;
      throw new CodexAdapterError(
        "provider_failed",
        "Codex failed before a response could be returned.",
        null,
        createProviderFailureDiagnostic({
          failureSource: "adapter_exception",
          parsed: null,
          result: null
        })
      );
    } finally {
      await rm(operationDirectory, { force: true, recursive: true });
    }
  }
}

export function createCodexEnvironment(
  source: NodeJS.ProcessEnv
): Readonly<Record<string, string>> {
  const allowed = [
    "APPDATA",
    "CODEX_HOME",
    "ComSpec",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME"
  ];
  const environment: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === "string" && !value.includes("\0")) {
      environment[key] = value;
    }
  }
  return environment;
}

type ParsedCodexStream = Readonly<{
  completed: boolean;
  failureCode: LocalConnectorErrorCode | null;
  finalMessage: string | null;
}>;

type ErrorMessageFingerprint = Readonly<{
  byteLength: number;
  sha256: string;
}>;

type CodexFailureObservation = Readonly<{
  finalResponseSeen: boolean;
  itemErrorCount: number;
  itemErrorPhase: "in_turn" | "mixed" | "pre_turn" | null;
  itemErrorSeen: boolean;
  itemType: string | null;
  itemErrorMessage: ErrorMessageFingerprint | null;
  streamIntegrityCompromised: boolean;
  terminalEventSeen: boolean;
  topLevelErrorSeen: boolean;
  topLevelEventType: string | null;
  topLevelErrorMessage: ErrorMessageFingerprint | null;
  turnFailedSeen: boolean;
  turnStatus: string | null;
  turnFailedMessage: ErrorMessageFingerprint | null;
  typedErrorCode: string | null;
}>;

type ParsedCodexStreamInternal = ParsedCodexStream & Readonly<{
  failureObservation: CodexFailureObservation;
}>;

type CodexItemClassification =
  | "authoritative"
  | "forbidden_authority"
  | "inert_metadata"
  | "non_fatal_diagnostic";

type CodexItemEventType =
  | "item.completed"
  | "item.started"
  | "item.updated";

type CodexItemDecode = Readonly<{
  classification: CodexItemClassification;
  item: Record<string, unknown>;
}>;

type StructuralIssue = Readonly<{
  expectedFields?: readonly string[];
  invalidFieldKind?: string;
  invalidFieldName?: string;
  missingRequiredFields?: readonly string[];
}>;

export const CODEX_EXEC_ITEM_CLASSIFICATIONS = Object.freeze({
  agent_message: "authoritative",
  collab_tool_call: "forbidden_authority",
  command_execution: "forbidden_authority",
  error: "non_fatal_diagnostic",
  file_change: "forbidden_authority",
  mcp_tool_call: "forbidden_authority",
  reasoning: "inert_metadata",
  todo_list: "inert_metadata",
  web_search: "forbidden_authority"
} as const satisfies Readonly<Record<string, CodexItemClassification>>);

export const CODEX_0_151_0_ITEM_LIFECYCLE = Object.freeze({
  agent_message: Object.freeze(["item.completed"]),
  collab_tool_call: Object.freeze(["item.started", "item.completed"]),
  command_execution: Object.freeze(["item.started", "item.completed"]),
  error: Object.freeze(["item.completed"]),
  file_change: Object.freeze(["item.completed"]),
  mcp_tool_call: Object.freeze(["item.started", "item.completed"]),
  reasoning: Object.freeze(["item.completed"]),
  todo_list: Object.freeze([
    "item.started",
    "item.updated",
    "item.completed"
  ]),
  web_search: Object.freeze(["item.started", "item.completed"])
} as const);

const CODEX_0_151_0_ITEM_FIELDS = Object.freeze({
  agent_message: Object.freeze(["id", "text", "type"]),
  collab_tool_call: Object.freeze([
    "agents_states",
    "id",
    "prompt",
    "receiver_thread_ids",
    "sender_thread_id",
    "status",
    "tool",
    "type"
  ]),
  command_execution: Object.freeze([
    "aggregated_output",
    "command",
    "exit_code",
    "id",
    "status",
    "type"
  ]),
  error: Object.freeze(["id", "message", "type"]),
  file_change: Object.freeze(["changes", "id", "status", "type"]),
  mcp_tool_call: Object.freeze([
    "arguments",
    "error",
    "id",
    "result",
    "server",
    "status",
    "tool",
    "type"
  ]),
  reasoning: Object.freeze(["id", "text", "type"]),
  todo_list: Object.freeze(["id", "items", "type"]),
  web_search: Object.freeze(["action", "id", "query", "type"])
} as const);

const CODEX_0_151_0_STREAM_INTEGRITY_WARNING =
  /^in-process app-server event stream lagged; dropped (?:0|[1-9][0-9]*) events$/;

export function isCodex01510StreamIntegrityWarning(
  message: string
): boolean {
  return CODEX_0_151_0_STREAM_INTEGRITY_WARNING.test(message);
}

export function extractFinalAgentMessage(stdout: Uint8Array): ParsedCodexStream {
  const parsed = extractCodexStream(stdout);
  return {
    completed: parsed.completed,
    failureCode: parsed.failureCode,
    finalMessage: parsed.finalMessage
  };
}

function extractCodexStream(stdout: Uint8Array): ParsedCodexStreamInternal {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw streamProtocolError();
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim() === "")) {
    throw streamProtocolError();
  }
  let threadStarted = false;
  let turnStarted = false;
  let completed = false;
  let turnFailed = false;
  let failureCode: LocalConnectorErrorCode | null = null;
  let finalMessage: string | null = null;
  let finalResponseSeen = false;
  let itemErrorCount = 0;
  let itemErrorPhase: "in_turn" | "mixed" | "pre_turn" | null = null;
  let itemErrorSeen = false;
  let itemType: string | null = null;
  let itemErrorMessage: ErrorMessageFingerprint | null = null;
  let streamIntegrityCompromised = false;
  let terminalEventSeen = false;
  let topLevelErrorSeen = false;
  let topLevelEventType: string | null = null;
  let topLevelErrorMessage: ErrorMessageFingerprint | null = null;
  let turnFailedSeen = false;
  let turnStatus: string | null = null;
  let turnFailedMessage: ErrorMessageFingerprint | null = null;
  let typedErrorCode: string | null = null;

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw streamProtocolError();
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw streamProtocolError();
    }
    const record = event as Record<string, unknown>;
    if (completed || turnFailed) {
      const diagnosticItem =
        record.item &&
        typeof record.item === "object" &&
        !Array.isArray(record.item)
          ? (record.item as Record<string, unknown>)
          : undefined;
      throw streamProtocolError(
        "ambiguous_final_response",
        record,
        diagnosticItem
      );
    }
    switch (record.type) {
      case "thread.started":
        if (threadStarted || turnStarted) {
          throw streamProtocolError("invalid_event_stream", record);
        }
        validateThreadStarted(record);
        threadStarted = true;
        break;
      case "turn.started":
        if (!threadStarted || turnStarted) {
          throw streamProtocolError("invalid_event_stream", record);
        }
        turnStarted = true;
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const eventType = record.type;
        const decoded = decodeCodexItemEvent(record, eventType);
        const itemRecord = decoded.item;
        const classification = decoded.classification;
        const validPreTurnDiagnostic =
          threadStarted &&
          !turnStarted &&
          eventType === "item.completed" &&
          classification === "non_fatal_diagnostic";
        if (!turnStarted && !validPreTurnDiagnostic) {
          throw streamProtocolError(
            "invalid_event_stream",
            record,
            itemRecord,
            { invalidFieldKind: "invalid_lifecycle_phase" }
          );
        }
        if (classification === "non_fatal_diagnostic") {
          const phase = turnStarted ? "in_turn" : "pre_turn";
          itemErrorCount += 1;
          itemErrorPhase =
            itemErrorPhase === null || itemErrorPhase === phase
              ? phase
              : "mixed";
          itemErrorSeen = true;
          itemType = safeDiagnosticToken(itemRecord.type);
          itemErrorMessage ??= fingerprintErrorMessage(itemRecord);
          if (
            isCodex01510StreamIntegrityWarning(itemRecord.message as string)
          ) {
            streamIntegrityCompromised = true;
            failureCode = mergeFailureCode(failureCode, "provider_failed");
          }
          break;
        }
        if (
          classification === "authoritative" &&
          eventType === "item.completed"
        ) {
          finalMessage = itemRecord.text as string;
          finalResponseSeen = true;
        }
        break;
      }
      case "turn.completed":
        if (!threadStarted || !turnStarted) {
          throw streamProtocolError("invalid_event_stream", record);
        }
        validateTurnCompleted(record);
        completed = true;
        terminalEventSeen = true;
        turnStatus = safeDiagnosticToken(record.status) ?? "completed";
        break;
      case "turn.failed":
        if (!threadStarted || !turnStarted) {
          throw streamProtocolError("invalid_event_stream", record);
        }
        validateTurnFailed(record);
        turnFailed = true;
        turnFailedSeen = true;
        terminalEventSeen = true;
        topLevelEventType = "turn.failed";
        turnStatus = safeDiagnosticToken(record.status) ?? "failed";
        turnFailedMessage ??= fingerprintErrorMessage(record);
        typedErrorCode ??= readTypedErrorCode(record);
        failureCode = mergeFailureCode(
          failureCode,
          classifyTypedFailure(record)
        );
        break;
      case "error":
        validateTopLevelError(record);
        topLevelErrorSeen = true;
        topLevelEventType = "error";
        topLevelErrorMessage ??= fingerprintErrorMessage(record);
        typedErrorCode ??= readTypedErrorCode(record);
        failureCode = mergeFailureCode(
          failureCode,
          classifyTypedFailure(record)
        );
        break;
      default:
        throw streamProtocolError("unsupported_event_type", record);
    }
  }
  return {
    completed,
    failureCode,
    failureObservation: {
      finalResponseSeen,
      itemErrorCount,
      itemErrorPhase,
      itemErrorMessage,
      itemErrorSeen,
      itemType,
      streamIntegrityCompromised,
      terminalEventSeen,
      topLevelErrorMessage,
      topLevelErrorSeen,
      topLevelEventType,
      turnFailedMessage,
      turnFailedSeen,
      turnStatus,
      typedErrorCode
    },
    finalMessage
  };
}

function decodeCanonicalUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
      throw new Error("non-canonical");
    }
    return text;
  } catch {
    throw new CodexAdapterError(
      "invalid_request",
      "The canonical request is not strict UTF-8."
    );
  }
}

function classifyItem(value: unknown): CodexItemClassification | null {
  if (
    typeof value !== "string" ||
    !Object.hasOwn(CODEX_EXEC_ITEM_CLASSIFICATIONS, value)
  ) {
    return null;
  }
  return CODEX_EXEC_ITEM_CLASSIFICATIONS[
    value as keyof typeof CODEX_EXEC_ITEM_CLASSIFICATIONS
  ];
}

function decodeCodexItemEvent(
  event: Record<string, unknown>,
  eventType: CodexItemEventType
): CodexItemDecode {
  if (!Object.hasOwn(event, "item")) {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: "missing_required_field",
      invalidFieldName: "item",
      missingRequiredFields: ["item"]
    });
  }
  const itemValue = event.item;
  if (!isJsonObject(itemValue)) {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: "non_object",
      invalidFieldName: "item"
    });
  }
  const item = itemValue;
  if (!Object.hasOwn(item, "type")) {
    throw streamProtocolError("invalid_event_stream", event, item, {
      invalidFieldKind: "missing_required_field",
      invalidFieldName: "type",
      missingRequiredFields: ["type"]
    });
  }
  if (typeof item.type !== "string") {
    throw streamProtocolError("invalid_event_stream", event, item, {
      invalidFieldKind: "non_string",
      invalidFieldName: "type"
    });
  }
  const classification = classifyItem(item.type);
  if (classification === null) {
    throw streamProtocolError("unsupported_item_type", event, item);
  }
  if (classification === "forbidden_authority") {
    throw forbiddenItemError(event, item);
  }

  const itemType = item.type as keyof typeof CODEX_0_151_0_ITEM_FIELDS;
  const allowedLifecycle = CODEX_0_151_0_ITEM_LIFECYCLE[itemType];
  if (!(allowedLifecycle as readonly string[]).includes(eventType)) {
    throw streamProtocolError("invalid_event_stream", event, item, {
      expectedFields: CODEX_0_151_0_ITEM_FIELDS[itemType],
      invalidFieldKind: "invalid_lifecycle_phase"
    });
  }

  requireNonEmptyStringField(event, item, "id", itemType);
  switch (itemType) {
    case "agent_message":
    case "reasoning":
      requireStringField(event, item, "text", itemType);
      break;
    case "error":
      requireStringField(event, item, "message", itemType);
      break;
    case "todo_list":
      validateTodoItems(event, item);
      break;
    default:
      break;
  }
  return { classification, item };
}

function validateThreadStarted(event: Record<string, unknown>): void {
  requireTopLevelNonEmptyString(event, "thread_id");
}

function validateTurnCompleted(event: Record<string, unknown>): void {
  if (!isJsonObject(event.usage)) {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: Object.hasOwn(event, "usage")
        ? "non_object"
        : "missing_required_field",
      invalidFieldName: "usage",
      missingRequiredFields: Object.hasOwn(event, "usage") ? [] : ["usage"]
    });
  }
  for (const field of [
    "cached_input_tokens",
    "cache_write_input_tokens",
    "input_tokens",
    "output_tokens",
    "reasoning_output_tokens"
  ]) {
    if (!Object.hasOwn(event.usage, field)) {
      throw streamProtocolError("invalid_event_stream", event, undefined, {
        invalidFieldKind: "missing_required_field",
        invalidFieldName: field,
        missingRequiredFields: [field]
      });
    }
    if (!Number.isSafeInteger(event.usage[field]) || (event.usage[field] as number) < 0) {
      throw streamProtocolError("invalid_event_stream", event, undefined, {
        invalidFieldKind: "non_integer",
        invalidFieldName: field
      });
    }
  }
}

function validateTurnFailed(event: Record<string, unknown>): void {
  if (!isJsonObject(event.error)) {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: Object.hasOwn(event, "error")
        ? "non_object"
        : "missing_required_field",
      invalidFieldName: "error",
      missingRequiredFields: Object.hasOwn(event, "error") ? [] : ["error"]
    });
  }
  if (!Object.hasOwn(event.error, "message")) {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: "missing_required_field",
      invalidFieldName: "message",
      missingRequiredFields: ["message"]
    });
  }
  if (typeof event.error.message !== "string") {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: "non_string",
      invalidFieldName: "message"
    });
  }
}

function validateTopLevelError(event: Record<string, unknown>): void {
  requireTopLevelString(event, "message");
}

function requireTopLevelNonEmptyString(
  event: Record<string, unknown>,
  field: string
): void {
  requireTopLevelString(event, field);
  if ((event[field] as string).length === 0) {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: "empty_string",
      invalidFieldName: field
    });
  }
}

function requireTopLevelString(
  event: Record<string, unknown>,
  field: string
): void {
  if (!Object.hasOwn(event, field)) {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: "missing_required_field",
      invalidFieldName: field,
      missingRequiredFields: [field]
    });
  }
  if (typeof event[field] !== "string") {
    throw streamProtocolError("invalid_event_stream", event, undefined, {
      invalidFieldKind: "non_string",
      invalidFieldName: field
    });
  }
}

function requireNonEmptyStringField(
  event: Record<string, unknown>,
  item: Record<string, unknown>,
  field: string,
  itemType: keyof typeof CODEX_0_151_0_ITEM_FIELDS
): void {
  requireStringField(event, item, field, itemType);
  if ((item[field] as string).length === 0) {
    throw streamProtocolError("invalid_event_stream", event, item, {
      expectedFields: CODEX_0_151_0_ITEM_FIELDS[itemType],
      invalidFieldKind: "empty_string",
      invalidFieldName: field
    });
  }
}

function requireStringField(
  event: Record<string, unknown>,
  item: Record<string, unknown>,
  field: string,
  itemType: keyof typeof CODEX_0_151_0_ITEM_FIELDS
): void {
  if (!Object.hasOwn(item, field)) {
    throw streamProtocolError("invalid_event_stream", event, item, {
      expectedFields: CODEX_0_151_0_ITEM_FIELDS[itemType],
      invalidFieldKind: "missing_required_field",
      invalidFieldName: field,
      missingRequiredFields: [field]
    });
  }
  if (typeof item[field] !== "string") {
    throw streamProtocolError("invalid_event_stream", event, item, {
      expectedFields: CODEX_0_151_0_ITEM_FIELDS[itemType],
      invalidFieldKind: "non_string",
      invalidFieldName: field
    });
  }
}

function validateTodoItems(
  event: Record<string, unknown>,
  item: Record<string, unknown>
): void {
  if (!Object.hasOwn(item, "items")) {
    throw streamProtocolError("invalid_event_stream", event, item, {
      expectedFields: CODEX_0_151_0_ITEM_FIELDS.todo_list,
      invalidFieldKind: "missing_required_field",
      invalidFieldName: "items",
      missingRequiredFields: ["items"]
    });
  }
  if (!Array.isArray(item.items)) {
    throw streamProtocolError("invalid_event_stream", event, item, {
      expectedFields: CODEX_0_151_0_ITEM_FIELDS.todo_list,
      invalidFieldKind: "non_array",
      invalidFieldName: "items"
    });
  }
  for (const todo of item.items) {
    if (!isJsonObject(todo)) {
      throw streamProtocolError("invalid_event_stream", event, item, {
        expectedFields: CODEX_0_151_0_ITEM_FIELDS.todo_list,
        invalidFieldKind: "non_object",
        invalidFieldName: "items"
      });
    }
    for (const [field, kind] of [
      ["completed", "boolean"],
      ["text", "string"]
    ] as const) {
      if (!Object.hasOwn(todo, field)) {
        throw streamProtocolError("invalid_event_stream", event, item, {
          expectedFields: CODEX_0_151_0_ITEM_FIELDS.todo_list,
          invalidFieldKind: "missing_required_field",
          invalidFieldName: field,
          missingRequiredFields: [field]
        });
      }
      if (typeof todo[field] !== kind) {
        throw streamProtocolError("invalid_event_stream", event, item, {
          expectedFields: CODEX_0_151_0_ITEM_FIELDS.todo_list,
          invalidFieldKind: `non_${kind}`,
          invalidFieldName: field
        });
      }
    }
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classifyTypedFailure(
  event: Record<string, unknown>
): LocalConnectorErrorCode {
  const code = readTypedErrorCode(event);
  if (code === "authentication_required" || code === "unauthorized") {
    return "authentication_required";
  }
  return "provider_failed";
}

function mergeFailureCode(
  current: LocalConnectorErrorCode | null,
  next: LocalConnectorErrorCode
): LocalConnectorErrorCode {
  return current === "authentication_required" || next === "authentication_required"
    ? "authentication_required"
    : "provider_failed";
}

function readTypedErrorCode(event: Record<string, unknown>): string | null {
  const direct = safeDiagnosticToken(event.code);
  if (direct) return direct;
  const error = event.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return safeDiagnosticToken((error as Record<string, unknown>).code);
}

function fingerprintErrorMessage(
  event: Record<string, unknown>
): ErrorMessageFingerprint | null {
  const error = event.error;
  const nested =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>).message
      : null;
  const message =
    typeof event.message === "string"
      ? event.message
      : typeof nested === "string"
        ? nested
        : null;
  if (message === null) return null;
  const bytes = Buffer.from(message, "utf8");
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function createCodexJsonlLineInspector(): (line: Uint8Array) => void {
  let terminal = false;
  return (line) => {
    let event: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      if (text.trim() === "") throw new Error("blank event");
      event = JSON.parse(text);
    } catch {
      throw streamProtocolError();
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw streamProtocolError();
    }
    const record = event as Record<string, unknown>;
    const item =
      record.item &&
      typeof record.item === "object" &&
      !Array.isArray(record.item)
        ? (record.item as Record<string, unknown>)
        : undefined;
    if (terminal) {
      throw streamProtocolError("ambiguous_final_response", record, item);
    }
    switch (record.type) {
      case "thread.started":
        validateThreadStarted(record);
        return;
      case "turn.started":
        return;
      case "turn.completed":
        validateTurnCompleted(record);
        terminal = true;
        return;
      case "turn.failed":
        validateTurnFailed(record);
        terminal = true;
        return;
      case "error":
        validateTopLevelError(record);
        return;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        decodeCodexItemEvent(record, record.type);
        return;
      }
      default:
        throw streamProtocolError("unsupported_event_type", record);
    }
  };
}

function forbiddenItemError(
  event: Record<string, unknown>,
  item: Record<string, unknown>
): CodexAdapterError {
  return new CodexAdapterError(
    "connector_protocol_error",
    "Codex attempted a tool-bearing item in the zero-tool profile.",
    createProtocolDiagnostic("forbidden_tool_event", event, item)
  );
}

function streamProtocolError(
  category: LocalConnectorProtocolDiagnosticCategory = "invalid_event_stream",
  event?: Record<string, unknown>,
  item?: Record<string, unknown>,
  issue?: StructuralIssue
): CodexAdapterError {
  return new CodexAdapterError(
    "connector_protocol_error",
    "Codex emitted an invalid or ambiguous event stream.",
    createProtocolDiagnostic(category, event, item, issue)
  );
}

function createProtocolDiagnostic(
  category: LocalConnectorProtocolDiagnosticCategory,
  event?: Record<string, unknown>,
  item?: Record<string, unknown>,
  issue: StructuralIssue = {}
): LocalConnectorProtocolDiagnostic {
  const itemPresent = Boolean(event && Object.hasOwn(event, "item"));
  const itemIsObject = isJsonObject(event?.item);
  const itemTypePresent = Boolean(item && Object.hasOwn(item, "type"));
  const itemKeys = item ? safeSortedFieldNames(Object.keys(item)) : [];
  const expected = issue.expectedFields ?? [];
  return Object.freeze({
    category,
    invalid_field_kind: safeDiagnosticToken(issue.invalidFieldKind),
    invalid_field_name: safeDiagnosticFieldName(issue.invalidFieldName),
    item_is_object: itemIsObject,
    item_present: itemPresent,
    item_type_present: itemTypePresent,
    item_type_string: itemTypePresent && typeof item?.type === "string",
    missing_required_field_names: safeSortedFieldNames(
      issue.missingRequiredFields ?? []
    ),
    sorted_item_key_names: itemKeys,
    top_level_type: safeDiagnosticToken(event?.type),
    unexpected_field_names: safeSortedFieldNames(
      expected.length > 0
        ? itemKeys.filter((field) => !expected.includes(field))
        : []
    )
  });
}

function safeDiagnosticFieldName(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^_?[a-z][a-z0-9_]*$/.test(value)
    ? value
    : null;
}

function safeSortedFieldNames(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values)]
      .map((value) => safeDiagnosticFieldName(value))
      .filter((value): value is string => value !== null)
      .sort()
      .slice(0, 32)
  );
}

function safeDiagnosticToken(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-z][a-z0-9._-]*$/.test(value)
    ? value
    : null;
}

function isSafeOptionalInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function tryExtractCodexStream(
  stdout: Uint8Array
): ParsedCodexStreamInternal | null {
  if (stdout.byteLength === 0) return null;
  try {
    return extractCodexStream(stdout);
  } catch {
    return null;
  }
}

function classifyProcessFailureSource(
  result: ChildResult
): CodexProviderFailureSource {
  if (result.terminationCause === "timeout") return "operation_timeout";
  if (result.signal) return "process_signal";
  return "process_exit";
}

function classifyProviderFailureSource(
  parsed: ParsedCodexStreamInternal,
  result: ChildResult
): CodexProviderFailureSource {
  if (result.terminationCause === "timeout") return "operation_timeout";
  const observation = parsed.failureObservation;
  if (observation.turnFailedSeen) return "turn_failed";
  if (observation.topLevelErrorSeen) return "top_level_error";
  if (observation.streamIntegrityCompromised) return "stream_integrity";
  if (result.signal) return "process_signal";
  return "process_exit";
}

function createProviderFailureDiagnostic(input: Readonly<{
  failureSource: CodexProviderFailureSource;
  parsed: ParsedCodexStreamInternal | null;
  result: ChildResult | null;
}>): CodexProviderFailureDiagnostic {
  const observation = input.parsed?.failureObservation ?? null;
  const preferredMessage =
    observation?.turnFailedMessage ??
    observation?.topLevelErrorMessage ??
    observation?.itemErrorMessage ??
    null;
  const topLevelAndTurnMessagesPresent = Boolean(
    observation?.topLevelErrorMessage && observation.turnFailedMessage
  );
  return Object.freeze({
    error_message_byte_length: preferredMessage?.byteLength ?? null,
    error_message_fingerprints_match: topLevelAndTurnMessagesPresent
      ? observation!.topLevelErrorMessage!.byteLength ===
          observation!.turnFailedMessage!.byteLength &&
        observation!.topLevelErrorMessage!.sha256 ===
          observation!.turnFailedMessage!.sha256
      : null,
    error_message_present: preferredMessage !== null,
    error_message_sha256: preferredMessage?.sha256 ?? null,
    exit_code: input.result?.code ?? null,
    failure_source: input.failureSource,
    final_response_seen: observation?.finalResponseSeen ?? false,
    item_error_count: observation?.itemErrorCount ?? 0,
    item_error_phase: observation?.itemErrorPhase ?? null,
    item_error_seen: observation?.itemErrorSeen ?? false,
    item_type: observation?.itemType ?? null,
    signal_name: input.result?.signal ?? null,
    stderr_byte_length: input.result?.stderrByteLength ?? 0,
    stderr_present: (input.result?.stderrByteLength ?? 0) > 0,
    stderr_sha256: input.result?.stderrSha256 ?? null,
    stream_integrity_compromised:
      observation?.streamIntegrityCompromised ?? false,
    terminal_event_seen: observation?.terminalEventSeen ?? false,
    timeout_fired: input.result?.terminationCause === "timeout",
    top_level_error_seen: observation?.topLevelErrorSeen ?? false,
    top_level_event_type: observation?.topLevelEventType ?? null,
    turn_failed_seen: observation?.turnFailedSeen ?? false,
    turn_status: observation?.turnStatus ?? null,
    typed_error_code: observation?.typedErrorCode ?? null
  });
}

function cancelledError(): CodexAdapterError {
  return new CodexAdapterError("cancelled", "The Codex exchange was cancelled.");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type ChildResult = Readonly<{
  code: number | null;
  inspectionError: Error | null;
  overflow: "stderr" | "stdout" | null;
  signal: NodeJS.Signals | null;
  stderr: Buffer;
  stderrByteLength: number;
  stderrSha256: string | null;
  stdout: Buffer;
  terminationCause:
    | "abort"
    | "inspection_error"
    | "stderr_overflow"
    | "stdout_overflow"
    | "timeout"
    | null;
}>;

async function runBoundedChild(input: Readonly<{
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  executable: string;
  input?: Buffer;
  inspectStdoutLine?: (line: Uint8Array) => void;
  maxStderrBytes: number;
  maxStdoutBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let overflow: ChildResult["overflow"] = null;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: { ...input.environment } as NodeJS.ProcessEnv,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stderrHash = createHash("sha256");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let inspectionError: Error | null = null;
    let pendingStdoutLine: Buffer[] = [];
    let terminating = false;
    let terminationCause: ChildResult["terminationCause"] = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const terminate = (cause: Exclude<ChildResult["terminationCause"], null>) => {
      if (terminating) return;
      terminating = true;
      terminationCause = cause;
      forceKillTimer = terminateProcessTree(child);
    };
    const onAbort = () => terminate("abort");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) terminate("abort");
    const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > input.maxStdoutBytes) {
        overflow = "stdout";
        terminate("stdout_overflow");
        return;
      }
      stdout.push(chunk);
      if (!input.inspectStdoutLine || inspectionError) return;
      let offset = 0;
      let newlineIndex = chunk.indexOf(0x0a, offset);
      while (newlineIndex >= 0) {
        pendingStdoutLine.push(chunk.subarray(offset, newlineIndex));
        const line = Buffer.concat(pendingStdoutLine);
        pendingStdoutLine = [];
        try {
          input.inspectStdoutLine(line);
        } catch (error) {
          inspectionError =
            error instanceof Error ? error : streamProtocolError();
          terminate("inspection_error");
          return;
        }
        offset = newlineIndex + 1;
        newlineIndex = chunk.indexOf(0x0a, offset);
      }
      if (offset < chunk.byteLength) {
        pendingStdoutLine.push(chunk.subarray(offset));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stderrBytes += chunk.byteLength;
      stderrHash.update(chunk);
      if (stderrBytes > input.maxStderrBytes) {
        overflow = "stderr";
        terminate("stderr_overflow");
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (
        input.inspectStdoutLine &&
        !inspectionError &&
        !overflow &&
        pendingStdoutLine.length > 0
      ) {
        try {
          input.inspectStdoutLine(Buffer.concat(pendingStdoutLine));
        } catch (error) {
          inspectionError =
            error instanceof Error ? error : streamProtocolError();
        }
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        inspectionError,
        overflow,
        signal,
        stderr: Buffer.concat(stderr),
        stderrByteLength: stderrBytes,
        stderrSha256: stderrBytes > 0 ? stderrHash.digest("hex") : null,
        stdout: Buffer.concat(stdout),
        terminationCause
      });
    });
    child.stdin.once("error", () => undefined);
    child.stdin.end(input.input);
  });
}

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams
): NodeJS.Timeout | null {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return null;
  }
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { shell: false, stdio: "ignore", windowsHide: true }
    );
    killer.unref();
    return null;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, TERMINATION_GRACE_MS);
  force.unref();
  return force;
}
