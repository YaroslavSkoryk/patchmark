#!/usr/bin/env bun

import { runPackagedConnector } from "./application.ts";

declare const PATCHMARK_PACKAGED_ALLOWED_ORIGIN: string;
declare const PATCHMARK_PACKAGED_ALLOW_INSECURE_LOOPBACK_ORIGIN: boolean;
declare const PATCHMARK_PACKAGED_QUALIFICATION_DIAGNOSTICS: boolean;

try {
  await runPackagedConnector({
    allowInsecureLoopbackOrigin:
      PATCHMARK_PACKAGED_ALLOW_INSECURE_LOOPBACK_ORIGIN,
    allowedOrigin: PATCHMARK_PACKAGED_ALLOWED_ORIGIN,
    qualificationDiagnostics: PATCHMARK_PACKAGED_QUALIFICATION_DIAGNOSTICS
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Patchmark Connector failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
