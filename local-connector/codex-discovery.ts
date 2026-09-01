import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import {
  PUBLICLY_SUPPORTED_CODEX_VERSIONS
} from "../lib/agent-exchange/local-connector-protocol.ts";
import {
  CodexExecAdapter,
  type CodexCompatibility
} from "./codex-exec-adapter.ts";

export type CodexCandidateInspection = Readonly<{
  compatibility: CodexCompatibility["compatibility"] | "inaccessible" | "invalid";
  executable: string;
  version: string | null;
}>;

export type CodexDiscovery = Readonly<{
  candidates_found: number;
  compatibility: CodexCompatibility["compatibility"];
  executable: string | null;
  inspections: readonly CodexCandidateInspection[];
  version: string | null;
}>;

export function defaultCodexCandidates(
  homeDirectory = readHomeDirectory()
): readonly string[] {
  const candidates = [
    join(homeDirectory, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex"
  ];
  return Object.freeze([...new Set(candidates)]);
}

export async function discoverCodexExecutable(input: Readonly<{
  candidates?: readonly string[];
  createAdapter?: (executable: string) => Pick<CodexExecAdapter, "inspectCompatibility">;
}> = {}): Promise<CodexDiscovery> {
  const candidates = input.candidates ?? defaultCodexCandidates();
  const createAdapter = input.createAdapter ??
    ((executable: string) => new CodexExecAdapter({ executable }));
  const inspections: CodexCandidateInspection[] = [];

  for (const executable of candidates) {
    if (!isAbsoluteMacPath(executable)) continue;
    let exists = false;
    try {
      const metadata = await stat(executable);
      exists = metadata.isFile();
    } catch {
      // A missing fixed candidate is expected and is not exposed to the browser.
    }
    if (!exists) continue;
    try {
      await access(executable, fsConstants.X_OK);
    } catch {
      inspections.push({
        compatibility: "inaccessible",
        executable,
        version: null
      });
      continue;
    }
    const result = await createAdapter(executable).inspectCompatibility();
    inspections.push({
      compatibility:
        result.compatibility === "unsupported" && result.codex_version === null
          ? "invalid"
          : result.compatibility,
      executable,
      version: result.codex_version
    });
  }

  const supported = inspections.find(
    (inspection) => inspection.compatibility === "supported"
  );
  const recognized = inspections.find(
    (inspection) =>
      inspection.compatibility === "unsupported" && inspection.version !== null
  );
  const selected = supported ?? recognized ?? null;
  return Object.freeze({
    candidates_found: inspections.length,
    compatibility: selected?.compatibility === "supported"
      ? "supported"
      : selected?.compatibility === "unsupported"
        ? "unsupported"
        : "unavailable",
    executable: selected?.executable ?? null,
    inspections: Object.freeze(inspections.map((inspection) => Object.freeze(inspection))),
    version: selected?.version ?? null
  });
}

export function supportedCodexVersionSummary(): string {
  return PUBLICLY_SUPPORTED_CODEX_VERSIONS.join(", ");
}

function readHomeDirectory(): string {
  try {
    const configured = process.env.HOME;
    if (configured && isAbsoluteMacPath(configured)) return configured;
    return userInfo().homedir;
  } catch {
    return "/var/empty";
  }
}

function isAbsoluteMacPath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0");
}
