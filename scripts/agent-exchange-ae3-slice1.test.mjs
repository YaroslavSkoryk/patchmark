import assert from "node:assert/strict";

import {
  CODEX_EXEC_FIXED_ARGUMENTS,
  CodexAdapterError,
  CodexExecAdapter,
  createCodexEnvironment
} from "../local-connector/codex-exec-adapter.ts";
import {
  classifyCodexVersion,
  DEVELOPMENT_QUALIFIED_CODEX_VERSIONS,
  PUBLICLY_SUPPORTED_CODEX_VERSIONS
} from "../lib/agent-exchange/local-connector-protocol.ts";

const fakeCodex = new URL(
  "./fixtures/agent-exchange/fake-codex.mjs",
  import.meta.url
).pathname;
const checks = [];

assert.deepEqual([...PUBLICLY_SUPPORTED_CODEX_VERSIONS], ["0.151.0"]);
assert.deepEqual(
  [...DEVELOPMENT_QUALIFIED_CODEX_VERSIONS],
  ["0.148.0-alpha.15"]
);
checks.push("the release policy uses exact, disjoint public and legacy lists");

for (const [version, expected] of [
  ["0.151.0", "publicly_supported"],
  ["0.148.0-alpha.15", "development_qualified"],
  ["0.150.1", "unsupported"],
  ["0.152.0-alpha.1", "unsupported"],
  ["0.152.0", "unsupported"],
  ["0.151", "unsupported"],
  ["1.0.0", "unsupported"]
]) {
  assert.equal(classifyCodexVersion(version), expected, version);
}
checks.push("nearby, prerelease, malformed, and future versions fail closed");

assert.deepEqual(await inspectVersion("0.151.0"), {
  codex_version: "0.151.0",
  compatibility: "supported"
});
assert.deepEqual(await inspectVersion("0.148.0-alpha.15"), {
  codex_version: "0.148.0-alpha.15",
  compatibility: "unsupported"
});
assert.deepEqual(await inspectVersion("0.152.0-alpha.1"), {
  codex_version: "0.152.0-alpha.1",
  compatibility: "unsupported"
});
assert.deepEqual(await inspectVersion("0.151"), {
  codex_version: "0.151",
  compatibility: "unsupported"
});
checks.push("the default connector accepts only the public exact allowlist");

await assert.rejects(
  adapterFor("0.148.0-alpha.15").exchange({
    maxResponseBytes: 1024,
    requestBytes: new TextEncoder().encode("legacy qualification evidence"),
    signal: new AbortController().signal
  }),
  (error) =>
    error instanceof CodexAdapterError && error.code === "codex_unsupported"
);
checks.push("the legacy alpha cannot authorize a public connector exchange");

for (const required of [
  "--strict-config",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--skip-git-repo-check",
  "read-only",
  "--json",
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.apps=false",
  "features.plugins=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.image_generation=false",
  "features.hooks=false"
]) {
  assert.ok(
    CODEX_EXEC_FIXED_ARGUMENTS.includes(required),
    `fixed stable profile is missing ${required}`
  );
}
assert.equal(
  CODEX_EXEC_FIXED_ARGUMENTS.some(
    (argument) =>
      argument === "-m" ||
      argument === "--model" ||
      argument === "--dangerously-bypass-approvals-and-sandbox"
  ),
  false
);
checks.push("the exact stable allowlist does not weaken the AE-2 zero-tool profile");

process.stdout.write(
  `${JSON.stringify(
    {
      checks,
      development_qualified: DEVELOPMENT_QUALIFIED_CODEX_VERSIONS,
      publicly_supported: PUBLICLY_SUPPORTED_CODEX_VERSIONS,
      status: "ok"
    },
    null,
    2
  )}\n`
);

function adapterFor(version) {
  return new CodexExecAdapter({
    environment: {
      ...createCodexEnvironment(process.env),
      PATCHMARK_FAKE_CODEX_VERSION: version
    },
    executable: fakeCodex
  });
}

function inspectVersion(version) {
  return adapterFor(version).inspectCompatibility();
}
