import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_CONNECTOR_MAX_RESPONSE_BYTES,
  QUALIFIED_CODEX_VERSION,
  type LocalConnectorErrorCode
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

  constructor(code: LocalConnectorErrorCode, message: string) {
    super(message);
    this.name = "CodexAdapterError";
    this.code = code;
  }
}

export type CodexExecAdapterOptions = Readonly<{
  executable: string;
  environment?: Readonly<Record<string, string>>;
  fixedArguments?: readonly string[];
  operationTimeoutMs?: number;
  qualifiedVersion?: string;
}>;

export class CodexExecAdapter {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #executable: string;
  readonly #fixedArguments: readonly string[];
  readonly #operationTimeoutMs: number;
  readonly #qualifiedVersion: string;

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
    this.#qualifiedVersion =
      options.qualifiedVersion ?? QUALIFIED_CODEX_VERSION;
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
          version === this.#qualifiedVersion ? "supported" : "unsupported"
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
        signal: input.signal,
        timeoutMs: this.#operationTimeoutMs
      });
      if (input.signal.aborted) throw cancelledError();
      if (result.overflow === "stdout") {
        throw new CodexAdapterError(
          "response_too_large",
          "The Codex event stream exceeded its connector limit."
        );
      }
      if (result.overflow === "stderr") {
        throw new CodexAdapterError(
          "provider_failed",
          "Codex diagnostics exceeded their connector limit."
        );
      }
      const parsed = extractFinalAgentMessage(result.stdout);
      if (result.code !== 0 || result.signal) {
        throw new CodexAdapterError(
          parsed.failureCode ?? "provider_failed",
          "Codex did not complete the exchange cleanly."
        );
      }
      if (parsed.failureCode) {
        throw new CodexAdapterError(
          parsed.failureCode,
          "Codex reported a failed turn."
        );
      }
      if (!parsed.completed || parsed.finalMessage === null) {
        throw new CodexAdapterError(
          "connector_protocol_error",
          "Codex did not emit an authoritative completed response."
        );
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
        "Codex failed before a response could be returned."
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

export function extractFinalAgentMessage(stdout: Uint8Array): ParsedCodexStream {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new CodexAdapterError(
      "connector_protocol_error",
      "Codex emitted non-UTF-8 output."
    );
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim() === "")) {
    throw streamProtocolError();
  }
  let threadStarted = false;
  let turnStarted = false;
  let completed = false;
  let failureCode: LocalConnectorErrorCode | null = null;
  let finalMessage: string | null = null;

  for (const line of lines) {
    if (completed || failureCode) throw streamProtocolError();
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
    switch (record.type) {
      case "thread.started":
        if (threadStarted || turnStarted) throw streamProtocolError();
        threadStarted = true;
        break;
      case "turn.started":
        if (!threadStarted || turnStarted) throw streamProtocolError();
        turnStarted = true;
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (!turnStarted) throw streamProtocolError();
        const item = record.item;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw streamProtocolError();
        }
        const itemRecord = item as Record<string, unknown>;
        if (isForbiddenItemType(itemRecord.type)) {
          throw new CodexAdapterError(
            "connector_protocol_error",
            "Codex attempted a tool-bearing item in the zero-tool profile."
          );
        }
        if (itemRecord.type !== "reasoning" && itemRecord.type !== "agent_message") {
          throw streamProtocolError();
        }
        if (record.type === "item.completed" && itemRecord.type === "agent_message") {
          if (typeof itemRecord.text !== "string") throw streamProtocolError();
          finalMessage = itemRecord.text;
        }
        break;
      }
      case "turn.completed":
        if (!threadStarted || !turnStarted) throw streamProtocolError();
        completed = true;
        break;
      case "turn.failed":
      case "error":
        if (!threadStarted) throw streamProtocolError();
        failureCode = classifyTypedFailure(record);
        break;
      default:
        throw streamProtocolError();
    }
  }
  return { completed, failureCode, finalMessage };
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

function isForbiddenItemType(value: unknown): boolean {
  return (
    typeof value === "string" &&
    [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
      "todo_list",
      "image_generation"
    ].includes(value)
  );
}

function classifyTypedFailure(
  event: Record<string, unknown>
): LocalConnectorErrorCode {
  const error = event.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (code === "authentication_required" || code === "unauthorized") {
      return "authentication_required";
    }
  }
  return "provider_failed";
}

function streamProtocolError(): CodexAdapterError {
  return new CodexAdapterError(
    "connector_protocol_error",
    "Codex emitted an invalid or ambiguous event stream."
  );
}

function cancelledError(): CodexAdapterError {
  return new CodexAdapterError("cancelled", "The Codex exchange was cancelled.");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type ChildResult = Readonly<{
  code: number | null;
  overflow: "stderr" | "stdout" | null;
  signal: NodeJS.Signals | null;
  stderr: Buffer;
  stdout: Buffer;
}>;

async function runBoundedChild(input: Readonly<{
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  executable: string;
  input?: Buffer;
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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminating = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      forceKillTimer = terminateProcessTree(child);
    };
    const onAbort = () => terminate();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) terminate();
    const timeout = setTimeout(terminate, input.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > input.maxStdoutBytes) {
        overflow = "stdout";
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > input.maxStderrBytes) {
        overflow = "stderr";
        terminate();
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
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        overflow,
        signal,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout)
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
