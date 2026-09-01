import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_CONNECTOR_DEFAULT_PORT,
  LOCAL_CONNECTOR_ID,
  LOCAL_CONNECTOR_PROTOCOL_VERSION,
  LOCAL_CONNECTOR_VERSION,
  PUBLICLY_SUPPORTED_CODEX_VERSIONS
} from "../lib/agent-exchange/local-connector-protocol.ts";

const EXPECTED_BUN_VERSION = "1.3.12";
const FIXED_MTIME_SECONDS = 1_577_836_800;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const outputDirectory = resolve(options.outputDirectory);
assertOutsideRepository(outputDirectory);
validateOrigin(options.allowedOrigin, options.qualificationLoopback);
if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("This package command is qualified only on macOS Apple silicon.");
}

const bunExecutable = findBunExecutable();
const bunVersion = run(bunExecutable, ["--version"]).stdout.trim();
if (bunVersion !== EXPECTED_BUN_VERSION) {
  fail(`Bun ${EXPECTED_BUN_VERSION} is required; found ${bunVersion || "unknown"}.`);
}

const qualifier = options.qualificationLoopback ? "-qualification" : "";
const packageName = `Patchmark Connector ${LOCAL_CONNECTOR_VERSION} macOS arm64${qualifier}`;
const archiveName = `patchmark-connector-${LOCAL_CONNECTOR_VERSION}-macos-arm64${qualifier}.tar.gz`;
const packageDirectory = join(outputDirectory, packageName);
const applicationDirectory = join(packageDirectory, "app");
const runtimeDirectory = join(packageDirectory, "runtime");
const applicationPath = join(applicationDirectory, "connector.js");
const runtimePath = join(runtimeDirectory, "bun");
const archivePath = join(outputDirectory, archiveName);
const uncompressedArchivePath = archivePath.slice(0, -3);

await rm(packageDirectory, { force: true, recursive: true });
await rm(archivePath, { force: true });
await rm(uncompressedArchivePath, { force: true });
await mkdir(applicationDirectory, { recursive: true, mode: 0o755 });
await mkdir(runtimeDirectory, { recursive: true, mode: 0o755 });

run(bunExecutable, [
  "build",
  "--target=bun",
  "--minify",
  "--reject-unresolved",
  `--define=PATCHMARK_PACKAGED_ALLOWED_ORIGIN=${JSON.stringify(options.allowedOrigin)}`,
  `--define=PATCHMARK_PACKAGED_ALLOW_INSECURE_LOOPBACK_ORIGIN=${options.qualificationLoopback}`,
  `--define=PATCHMARK_PACKAGED_QUALIFICATION_DIAGNOSTICS=${options.qualificationLoopback}`,
  `--outfile=${applicationPath}`,
  join(repoRoot, "local-connector", "packaged-entry.ts")
]);

await cp(bunExecutable, runtimePath);
await chmod(applicationPath, 0o644);
await chmod(runtimePath, 0o755);
await writeFile(
  join(packageDirectory, "Patchmark Connector.command"),
  launcherText(),
  { mode: 0o755 }
);
await writeFile(join(packageDirectory, "README.txt"), readmeText(options), {
  mode: 0o644
});
await writeFile(
  join(packageDirectory, "THIRD_PARTY_NOTICES.txt"),
  thirdPartyNotices(),
  { mode: 0o644 }
);

const packagedFiles = await listFiles(packageDirectory);
const fileEntries = [];
for (const path of packagedFiles) {
  fileEntries.push({
    path: relative(packageDirectory, path),
    sha256: await sha256(path),
    size_bytes: (await stat(path)).size
  });
}
const manifest = {
  artifact_format: 1,
  connector: {
    id: LOCAL_CONNECTOR_ID,
    version: LOCAL_CONNECTOR_VERSION
  },
  endpoint: `http://127.0.0.1:${LOCAL_CONNECTOR_DEFAULT_PORT}`,
  files: fileEntries,
  origin_policy: options.qualificationLoopback
    ? "qualification_loopback"
    : "exact_https",
  qualification_diagnostics: options.qualificationLoopback,
  protocol_version: LOCAL_CONNECTOR_PROTOCOL_VERSION,
  runtime: {
    builder: "bun",
    builder_version: EXPECTED_BUN_VERSION,
    embedded: true
  },
  signature_status: "unsigned",
  supported_codex_versions: PUBLICLY_SUPPORTED_CODEX_VERSIONS,
  target: "darwin-arm64"
};
await writeFile(
  join(packageDirectory, "package-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 }
);

await normalizeMetadata(packageDirectory);
run("/usr/bin/tar", [
  "-cf",
  uncompressedArchivePath,
  "--format",
  "ustar",
  "--uid",
  "0",
  "--gid",
  "0",
  "--numeric-owner",
  "--no-xattrs",
  packageName
], {
  cwd: outputDirectory,
  env: { ...process.env, COPYFILE_DISABLE: "1" }
});
run("/usr/bin/gzip", ["-n", "-9", uncompressedArchivePath], {
  cwd: outputDirectory
});

const archiveMetadata = await stat(archivePath);
process.stdout.write(
  `${JSON.stringify(
    {
      archive: archivePath,
      package_directory: packageDirectory,
      runtime: `embedded Bun ${EXPECTED_BUN_VERSION}`,
      sha256: await sha256(archivePath),
      signature_status: "unsigned",
      size_bytes: archiveMetadata.size,
      target: "macOS arm64"
    },
    null,
    2
  )}\n`
);

function parseArguments(args) {
  let allowedOrigin = null;
  let outputDirectory = null;
  let qualificationLoopback = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-origin") {
      allowedOrigin = args[++index] ?? null;
    } else if (argument === "--output") {
      outputDirectory = args[++index] ?? null;
    } else if (argument === "--qualification-loopback") {
      qualificationLoopback = true;
    } else {
      fail(`Unknown package argument: ${argument}`);
    }
  }
  if (!allowedOrigin || !outputDirectory) {
    fail(
      "Usage: npm run package:agent-exchange-connector -- --output /absolute/output --allow-origin https://patchmark.example [--qualification-loopback]"
    );
  }
  return { allowedOrigin, outputDirectory, qualificationLoopback };
}

function validateOrigin(origin, qualificationLoopback) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail("--allow-origin must be an exact URL origin.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const safeProtocol = parsed.protocol === "https:" ||
    (qualificationLoopback && parsed.protocol === "http:" && loopback);
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !safeProtocol
  ) {
    fail("The package origin must be exact HTTPS; HTTP loopback requires --qualification-loopback.");
  }
}

function assertOutsideRepository(path) {
  const location = relative(repoRoot, path);
  if (location === "" || (location !== ".." && !location.startsWith(`..${sep}`))) {
    fail("Package output must be outside the repository.");
  }
}

function findBunExecutable() {
  const candidates = [
    join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun"
  ];
  for (const candidate of candidates) {
    try {
      if (run(candidate, ["--version"], { quiet: true }).status === 0) return candidate;
    } catch {
      // Try the next fixed build-tool path.
    }
  }
  fail(`Bun ${EXPECTED_BUN_VERSION} was not found in a fixed build-tool location.`);
}

function run(executable, args, input = {}) {
  const result = spawnSync(executable, args, {
    cwd: input.cwd ?? repoRoot,
    encoding: "utf8",
    env: input.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    stdio: input.quiet ? "pipe" : ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !input.quiet) {
    process.stderr.write(result.stderr ?? "");
    fail(`${basename(executable)} failed with exit code ${result.status}.`);
  }
  return result;
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function normalizeMetadata(directory) {
  const date = new Date(FIXED_MTIME_SECONDS * 1000);
  const paths = [directory, ...(await listAll(directory))].sort().reverse();
  for (const path of paths) await utimes(path, date, date);
}

async function listAll(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(path);
    if (entry.isDirectory()) result.push(...(await listAll(path)));
  }
  return result;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function launcherText() {
  return `#!/bin/sh
set -eu
connector_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unset BUN_BE_BUN BUN_OPTIONS
cd "$connector_dir"
exec "$connector_dir/runtime/bun" --no-env-file "$connector_dir/app/connector.js"
`;
}

function readmeText(settings) {
  return `Patchmark Connector ${LOCAL_CONNECTOR_VERSION}

Target: macOS on Apple silicon
Browser: Chrome 152 qualification target
Protocol: ${LOCAL_CONNECTOR_PROTOCOL_VERSION}
Supported Codex: exactly ${PUBLICLY_SUPPORTED_CODEX_VERSIONS.join(", ")}
Patchmark origin: ${settings.allowedOrigin}

Launch
1. Install Codex ${PUBLICLY_SUPPORTED_CODEX_VERSIONS[0]} using an official standalone, Homebrew, npm, Codex app, or ChatGPT app installation.
2. Double-click “Patchmark Connector.command”. Keep its Terminal window open.
3. In Patchmark, choose “Send to agent”. Enter the one-time pairing code shown in Terminal.
4. When finished, return to Terminal and press Control-C. The connector stops, cancels its owned provider process, and forgets pairing/session state.

The connector binds only 127.0.0.1:${LOCAL_CONNECTOR_DEFAULT_PORT}, starts no Codex process until an authenticated exchange, stores no provider credentials, installs no daemon or login item, performs no automatic update, and does not remember pairing after quit. If the port belongs to another program, it exits without stopping that program.

Recovery
- “Codex not found”: install exact Codex ${PUBLICLY_SUPPORTED_CODEX_VERSIONS[0]}, then quit and relaunch the connector.
- “Codex unsupported”: install exact Codex ${PUBLICLY_SUPPORTED_CODEX_VERSIONS[0]}; nearby, prerelease, older, and newer versions are rejected.
- “Connector needs an update”: quit it and use the connector package supplied for the current Patchmark build.
- Pairing lost or connector restarted: choose Send to agent and enter the newly displayed code.
- Any connector failure: use Patchmark’s exact manual export instead. Patchmark never auto-retries a provider turn.

Distribution status
The Patchmark package is not Developer ID signed or notarized. macOS Gatekeeper may block or warn. This is qualification evidence, not a public distribution artifact. Public distribution requires Developer ID signing, hardened runtime review, notarization, stapling, and clean-machine verification.
`;
}

function thirdPartyNotices() {
  return `This package embeds the Bun runtime (https://bun.sh/), version ${EXPECTED_BUN_VERSION}.

MIT License

Copyright (c) 2021-present Jarred Sumner and Bun contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function fail(message) {
  throw new Error(message);
}
