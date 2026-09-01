import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CODEX_EXEC_FIXED_ARGUMENTS } from "../local-connector/codex-exec-adapter.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "patchmark-ae3-slice2-packaged-fake-browser-")
);
const packageOutput = join(temporaryRoot, "package");
const fakeCodex = join(
  root,
  "scripts/fixtures/agent-exchange/fake-codex.mjs"
);

try {
  const packageResult = await run(process.execPath, [
    "--experimental-strip-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    join(root, "scripts/package-agent-exchange-connector.mjs"),
    "--output",
    packageOutput,
    "--allow-origin",
    "http://127.0.0.1:3120",
    "--qualification-loopback"
  ]);
  const packageJson = /\{\n  "archive":[\s\S]+\n\}/.exec(packageResult.stdout);
  assert.ok(packageJson, packageResult.stdout);
  const packaged = JSON.parse(packageJson[0]);
  const scenarios = {};
  for (const qualification of [
    {
      expectedErrorCode: null,
      expectedFailureSource: null,
      expectedPhase: "ready",
      fakeScenario: "patchmark-item-warning-success",
      label: "item-warning-success",
      status: "ok"
    },
    {
      expectedErrorCode: "provider_failed",
      expectedFailureSource: "turn_failed",
      expectedPhase: "failed",
      fakeScenario: "item-warning-turn-failed",
      label: "item-warning-turn-failed",
      status: "expected_failure"
    },
    {
      expectedErrorCode: "connector_protocol_error",
      expectedFailureSource: null,
      expectedPhase: "failed",
      fakeScenario: "item-warning-forbidden-tool",
      label: "item-warning-forbidden-tool",
      status: "expected_failure"
    },
    {
      expectedErrorCode: "provider_failed",
      expectedFailureSource: "stream_integrity",
      expectedPhase: "failed",
      fakeScenario: "stream-integrity-warning",
      label: "stream-integrity-warning",
      status: "expected_failure"
    }
  ]) {
    scenarios[qualification.label] = await runPackagedBrowserScenario(
      packaged,
      qualification
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      artifact_sha256: packaged.sha256,
      scenarios,
      status: "ok"
    }, null, 2)}\n`
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function runPackagedBrowserScenario(packaged, qualification) {
  const scenarioRoot = join(temporaryRoot, qualification.label);
  const evidenceDirectory = join(scenarioRoot, "evidence");
  const qualificationHome = join(scenarioRoot, "home");
  const codexHome = join(scenarioRoot, "codex-home");
  const installedCodex = join(qualificationHome, ".local/bin/codex");
  const codexCapturePath = join(scenarioRoot, "codex-stdin-capture.json");
  await Promise.all([
    mkdir(evidenceDirectory, { recursive: true }),
    mkdir(dirname(installedCodex), { recursive: true }),
    mkdir(codexHome, { recursive: true })
  ]);
  await writeFile(
    installedCodex,
    [
      "#!/bin/sh",
      `PATCHMARK_FAKE_CODEX_SCENARIO=${shellQuote(qualification.fakeScenario)} \\`,
      "PATCHMARK_FAKE_DELAY_MS=10 \\",
      `PATCHMARK_FAKE_CAPTURE_PATH=${shellQuote(codexCapturePath)} \\`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(fakeCodex)} "$@"`,
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  await chmod(installedCodex, 0o755);

  const browserResult = await run(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      join(root, "scripts/agent-exchange-ae3-slice2-packaged-browser.mjs")
    ],
    {
      ...process.env,
      CODEX_HOME: codexHome,
      PATCHMARK_AE3_SLICE2_EVIDENCE_DIR: evidenceDirectory,
      PATCHMARK_AE3_SLICE2_EXPECTED_PHASE: qualification.expectedPhase,
      PATCHMARK_AE3_SLICE2_PROVIDER_MODE: "fake",
      PATCHMARK_PACKAGED_CONNECTOR: join(
        packaged.package_directory,
        "Patchmark Connector.command"
      ),
      PATCHMARK_QUALIFICATION_HOME: qualificationHome
    }
  );
  const result = JSON.parse(
    await readFile(join(evidenceDirectory, "FAKE_PROVIDER_RESULT.json"), "utf8")
  );
  const requestBytes = await readFile(
    join(evidenceDirectory, "FAKE_PROVIDER_REQUEST.md")
  );
  const codexCapture = JSON.parse(await readFile(codexCapturePath, "utf8"));
  assert.equal(result.status, qualification.status);
  assert.equal(result.provider_kind, "fake");
  assert.equal(result.provider_turn_count, 0);
  assert.equal(result.synthetic_fixture_only, true);
  assert.equal(result.private_project_data_sent, false);
  assert.equal(result.credentials_in_payload, false);
  assert.deepEqual(codexCapture.argv, CODEX_EXEC_FIXED_ARGUMENTS);
  assert.match(codexCapture.cwd, /\/patchmark-codex-exchange-[^/]+$/);
  assert.equal(existsSync(codexCapture.cwd), false);
  assert.deepEqual(
    Buffer.from(codexCapture.stdinBase64, "base64"),
    requestBytes,
    "Prepared Exchange, loopback HTTP decoding, and packaged Codex stdin must be byte-identical"
  );
  assert.equal(result.prompt_byte_length, requestBytes.byteLength);
  assert.equal(result.prompt_sha256, sha256(requestBytes));
  const exchangeResponse = result.connector_responses.find(
    (response) => response.status !== 204
  );
  assert.ok(exchangeResponse, JSON.stringify(result.connector_responses));
  assert.equal(exchangeResponse.error_code, qualification.expectedErrorCode);
  assert.equal(
    exchangeResponse.qualification_diagnostic?.failure_source ?? null,
    qualification.expectedFailureSource
  );
  if (qualification.expectedPhase === "ready") {
    assert.equal(exchangeResponse.status, 200);
    assert.equal(result.imported_replies, 1);
    assert.equal(result.provider_tool_events, 0);
  } else {
    assert.ok(exchangeResponse.status >= 400);
    assert.equal(result.imported_replies, 0);
    assert.equal(result.imported_patch_proposals, 0);
  }
  if (qualification.fakeScenario === "item-warning-forbidden-tool") {
    assert.equal(
      exchangeResponse.qualification_structural_diagnostic?.category,
      "forbidden_tool_event"
    );
  }
  return {
    browser_output_present: browserResult.stdout.length > 0,
    connector_response: exchangeResponse,
    imported_patch_proposals: result.imported_patch_proposals,
    imported_replies: result.imported_replies,
    packaged_stdin_sha256: sha256(
      Buffer.from(codexCapture.stdinBase64, "base64")
    ),
    status: result.status,
    ui_terminal_phase: result.ui_terminal_phase
  };
}

function run(executable, args, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveRun({ stderr, stdout });
        return;
      }
      rejectRun(
        new Error(
          `${executable} failed with ${signal ?? code}: ${stderr || stdout}`
        )
      );
    });
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
