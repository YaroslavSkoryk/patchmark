#!/usr/bin/env node

import { CodexExecAdapter } from "./codex-exec-adapter.ts";
import { createPatchmarkLocalConnector } from "./server.ts";

const parsed = parseArguments(process.argv.slice(2));
const adapter = new CodexExecAdapter({
  executable: parsed.codexExecutable ?? defaultCodexExecutable()
});
const connector = createPatchmarkLocalConnector({
  adapter,
  allowInsecureLoopbackOriginsForTests: parsed.allowInsecureLoopbackOrigin,
  allowedOrigins: parsed.allowedOrigins,
  onPairingCode(pairingCode) {
    // This is the one intentional local display of the one-time secret.
    process.stdout.write(`Patchmark pairing code: ${pairingCode}\n`);
  },
  port: parsed.port
});

const origin = await connector.start();
process.stdout.write(`Patchmark Connector listening on ${origin}\n`);
process.stdout.write("No Codex process starts until an authenticated exchange is sent.\n");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await connector.stop();
};
process.once("SIGINT", () => void stop().then(() => process.exit(0)));
process.once("SIGTERM", () => void stop().then(() => process.exit(0)));

function parseArguments(args: string[]): Readonly<{
  allowInsecureLoopbackOrigin: boolean;
  allowedOrigins: string[];
  codexExecutable: string | null;
  port: number | undefined;
}> {
  const allowedOrigins: string[] = [];
  let allowInsecureLoopbackOrigin = false;
  let codexExecutable: string | null = null;
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-origin") {
      const value = args[index + 1];
      if (!value) usage("--allow-origin needs an exact origin.");
      allowedOrigins.push(value);
      index += 1;
    } else if (argument === "--codex-executable") {
      const value = args[index + 1];
      if (!value || value.includes("\0")) usage("--codex-executable needs a path.");
      codexExecutable = value;
      index += 1;
    } else if (argument === "--port") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) usage("--port needs an integer.");
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        usage("--port is outside the TCP port range.");
      }
      index += 1;
    } else if (argument === "--allow-insecure-loopback-origin") {
      allowInsecureLoopbackOrigin = true;
    } else {
      usage(`Unknown argument: ${argument}`);
    }
  }
  if (allowedOrigins.length === 0) {
    usage("At least one --allow-origin is required.");
  }
  return {
    allowInsecureLoopbackOrigin,
    allowedOrigins,
    codexExecutable,
    port
  };
}

function defaultCodexExecutable(): string {
  return process.platform === "darwin"
    ? "/Applications/ChatGPT.app/Contents/Resources/codex"
    : "codex";
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: patchmark-connector --allow-origin https://patchmark.example [--codex-executable /path/to/codex] [--port 43187]\n"
  );
  process.exit(2);
}
