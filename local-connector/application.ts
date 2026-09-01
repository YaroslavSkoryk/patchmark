import { request } from "node:http";

import {
  isExactRecord,
  LOCAL_CONNECTOR_DEFAULT_PORT,
  LOCAL_CONNECTOR_ID,
  LOCAL_CONNECTOR_PROTOCOL_VERSION,
  LOCAL_CONNECTOR_VERSION,
  PUBLICLY_SUPPORTED_CODEX_VERSIONS
} from "../lib/agent-exchange/local-connector-protocol.ts";
import { CodexExecAdapter } from "./codex-exec-adapter.ts";
import {
  discoverCodexExecutable,
  supportedCodexVersionSummary,
  type CodexDiscovery
} from "./codex-discovery.ts";
import {
  createPatchmarkLocalConnector,
  type PatchmarkLocalConnector
} from "./server.ts";

const PROBE_TIMEOUT_MS = 1_500;

export type PackagedConnectorSettings = Readonly<{
  allowInsecureLoopbackOrigin: boolean;
  allowedOrigin: string;
  qualificationDiagnostics?: boolean;
}>;

export type RunningConnector = Readonly<{
  connector: PatchmarkLocalConnector;
  discovery: CodexDiscovery;
  origin: string;
}>;

export async function startUserLaunchedConnector(
  settings: PackagedConnectorSettings,
  input: Readonly<{
    candidates?: readonly string[];
    onOutput?: (line: string) => void;
    port?: number;
  }> = {}
): Promise<Readonly<{ kind: "already_running" }> | Readonly<{
  kind: "running";
  value: RunningConnector;
}>> {
  const output = input.onOutput ?? ((line: string) => process.stdout.write(`${line}\n`));
  const port = input.port ?? LOCAL_CONNECTOR_DEFAULT_PORT;
  const discovery = await discoverCodexExecutable({ candidates: input.candidates });
  const unavailableExecutable = "/var/empty/patchmark-codex-unavailable";
  const adapter = new CodexExecAdapter({
    executable: discovery.executable ?? unavailableExecutable
  });
  const connector = createPatchmarkLocalConnector({
    adapter,
    allowInsecureLoopbackOriginsForTests: settings.allowInsecureLoopbackOrigin,
    allowedOrigins: [settings.allowedOrigin],
    includeQualificationDiagnostics:
      settings.qualificationDiagnostics === true,
    onPairingCode(pairingCode) {
      output(`Patchmark pairing code: ${pairingCode}`);
    },
    port
  });

  let origin: string;
  try {
    origin = await connector.start();
  } catch (error) {
    if (!isAddressInUseError(error)) throw error;
    const existing = await probeExistingConnector({
      allowedOrigin: settings.allowedOrigin,
      port
    });
    if (existing) {
      output("Patchmark Connector is already running. Use its current pairing code.");
      return { kind: "already_running" };
    }
    throw new Error(
      `Port ${port} is in use by another application. Patchmark Connector did not start and did not stop the other application.`,
      { cause: error }
    );
  }

  output(`Patchmark Connector ${LOCAL_CONNECTOR_VERSION}`);
  output(`Protocol: ${LOCAL_CONNECTOR_PROTOCOL_VERSION}`);
  output(`Supported Codex: ${supportedCodexVersionSummary()}`);
  output(`Detected Codex: ${formatDiscovery(discovery)}`);
  output(`Status: running on ${origin}`);
  output("No Codex process starts until an authenticated exchange is sent.");
  output("Press Ctrl+C to quit. Pairing and browser authorization are memory-only.");
  return { kind: "running", value: { connector, discovery, origin } };
}

export async function runPackagedConnector(
  settings: PackagedConnectorSettings
): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This Patchmark Connector package supports macOS on Apple silicon only.");
  }
  const started = await startUserLaunchedConnector(settings);
  if (started.kind === "already_running") return;
  await waitForShutdown(started.value.connector);
}

export async function probeExistingConnector(input: Readonly<{
  allowedOrigin: string;
  port?: number;
}>): Promise<boolean> {
  const port = input.port ?? LOCAL_CONNECTOR_DEFAULT_PORT;
  return new Promise<boolean>((resolve) => {
    const probe = request(
      {
        headers: {
          Accept: "application/json",
          Origin: input.allowedOrigin
        },
        host: "127.0.0.1",
        method: "GET",
        path: "/v1/status",
        port,
        timeout: PROBE_TIMEOUT_MS
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length <= 16 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200 || length > 16 * 1024) {
            resolve(false);
            return;
          }
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(isExpectedConnectorIdentity(value));
          } catch {
            resolve(false);
          }
        });
      }
    );
    probe.once("error", () => resolve(false));
    probe.once("timeout", () => {
      probe.destroy();
      resolve(false);
    });
    probe.end();
  });
}

function isExpectedConnectorIdentity(value: unknown): boolean {
  return (
    isExactRecord(value, [
      "busy",
      "codex_version",
      "compatibility",
      "connector_id",
      "connector_version",
      "instance_id",
      "paired",
      "protocol_version",
      "supported_codex_versions"
    ]) &&
    value.connector_id === LOCAL_CONNECTOR_ID &&
    value.connector_version === LOCAL_CONNECTOR_VERSION &&
    value.protocol_version === LOCAL_CONNECTOR_PROTOCOL_VERSION &&
    Array.isArray(value.supported_codex_versions) &&
    value.supported_codex_versions.length === PUBLICLY_SUPPORTED_CODEX_VERSIONS.length &&
    value.supported_codex_versions.every(
      (version, index) => version === PUBLICLY_SUPPORTED_CODEX_VERSIONS[index]
    )
  );
}

function formatDiscovery(discovery: CodexDiscovery): string {
  if (discovery.compatibility === "supported") {
    const suffix = discovery.candidates_found > 1
      ? ` (${discovery.candidates_found} installations checked)`
      : "";
    return `${discovery.version} — supported${suffix}`;
  }
  if (discovery.compatibility === "unsupported") {
    return `${discovery.version} — unsupported; exact ${supportedCodexVersionSummary()} is required`;
  }
  if (discovery.candidates_found > 0) {
    return "not usable; install exact Codex 0.151.0 and relaunch";
  }
  return "not found; install exact Codex 0.151.0 and relaunch";
}

function isAddressInUseError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EADDRINUSE"
  );
}

async function waitForShutdown(connector: PatchmarkLocalConnector): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      void connector.stop().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
