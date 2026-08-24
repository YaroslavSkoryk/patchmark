import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const productionRoots = ["app", "components", "lib"];
const violations = [];
for (const productionRoot of productionRoots) {
  for (const file of await sourceFiles(join(root, productionRoot))) {
    const source = await readFile(file, "utf8");
    const isHc2Implementation = file.includes(`${join("lib", "collaboration", "hc2")}/`) || file.includes(`${join("lib", "collaboration", "hc2")}\\`);
    if (!isHc2Implementation && /from\s+["'][^"']*collaboration\/hc2|import\s*\(\s*["'][^"']*collaboration\/hc2/.test(source)) {
      violations.push(relative(root, file));
    }
    if (!file.includes(`${join("lib", "collaboration", "hc2", "providers")}/`) &&
        /from\s+["'][^"']*hc2\/providers|import\s*\(\s*["'][^"']*hc2\/providers/.test(source)) {
      violations.push(relative(root, file));
    }
  }
}
assert.deepEqual(violations, [], "HC-2 modules entered a production import path");

const collaborationIndex = await readFile(join(root, "lib", "collaboration", "index.ts"), "utf8");
assert(!collaborationIndex.includes("./hc2/"));
const hc2Index = await readFile(join(root, "lib", "collaboration", "hc2", "index.ts"), "utf8");
const providerBarrelExports = Array.from(hc2Index.matchAll(/export\s+\*\s+from\s+["'](\.\/providers\/[^"']+)["']/g), (match) => match[1]);
assert.deepEqual(providerBarrelExports, ["./providers/root-recovery-provider.ts"], "HC-2 barrel must expose only the bounded root-ceremony provider");
assert(!/root-recovery-(?:worker|payload)|native-key-handles/.test(hc2Index), "Secret-bearing or generic native-key internals entered the HC-2 barrel");

const forbiddenImportTimeOperations = [
  /indexedDB\.open\s*\(/,
  /showDirectoryPicker\s*\(/,
  /navigator\.locks\.request\s*\(/,
  /navigator\.storage\.persist\s*\(/,
  /crypto\.getRandomValues\s*\(/,
  /new\s+Worker\s*\(/,
  /setTimeout\s*\(/,
  /fetch\s*\(/
];
const hc2Files = await sourceFiles(join(root, "lib", "collaboration", "hc2"));
for (const file of hc2Files) {
  if (file.includes(`${join("hc2", "providers")}/`)) continue;
  const source = await readFile(file, "utf8");
  for (const pattern of forbiddenImportTimeOperations) {
    assert(!pattern.test(source), `${relative(root, file)} contains forbidden Slice 1 activity ${pattern}`);
  }
}

const portableAuthorityFiles = [
  "lib/collaboration/hc2/portable-folder.ts",
  "lib/collaboration/hc2/records.ts",
  "lib/collaboration/hc2/opfs-cache.ts",
  "lib/collaboration/hc2/storage-observations.ts"
];
for (const path of portableAuthorityFiles) {
  const source = await readFile(join(root, path), "utf8");
  assert(!/recovery_kit_bytes|project_root_recovery_kit|root_seed|password_material|custody_completion_marker/.test(source), `${path} can carry custody/recovery secret state`);
}
const rootSeedImplementationFiles = [];
for (const file of hc2Files) {
  const source = await readFile(file, "utf8");
  if (/\broot_seed\b/.test(source)) rootSeedImplementationFiles.push(relative(root, file));
}
assert.deepEqual(rootSeedImplementationFiles.sort(), [
  "lib/collaboration/hc2/providers/root-recovery-payload.ts",
  "lib/collaboration/hc2/providers/root-recovery-worker.ts"
], "Offline root seed handling escaped the worker-private payload boundary");
for (const path of [
  "lib/collaboration/hc2/device-vault.ts",
  "lib/collaboration/hc2/providers/root-recovery-provider.ts",
  "lib/collaboration/hc2/providers/root-recovery-worker.ts"
]) {
  const source = await readFile(join(root, path), "utf8");
  assert(!/console\.|telemetry|diagnostic|logger\.|JSON\.stringify/.test(source), `${path} contains a secret-boundary logging or diagnostic path`);
}

const frozenFixtureHashes = {
  "scripts/fixtures/collaboration-canonical-v1.json": "f178eb0510471ef9a9ed6835840b75c1bf9b21a22b445c3ce00275582182726b",
  "scripts/fixtures/collaboration-roots-v1.json": "42189802cee24766e73e974fd09b6e1bd9f612c90da184399a82bea91a1e211e",
  "scripts/fixtures/collaboration-review-response-evidence-v1.json": "7b9dc41a3407549167286aaed20f32c967db5878f2705d219627b08d4ba30e67",
  "scripts/fixtures/collaboration-hc2-slice1-v1.json": "534ec34c32cd208759c135c77d69dcd7cab6fa7cfac93ba6f7680c03171f9cbc"
};
for (const [path, expected] of Object.entries(frozenFixtureHashes)) {
  const bytes = await readFile(join(root, path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${path} changed`);
}

process.stdout.write(`${JSON.stringify({
  production_hc2_imports: violations,
  hc2_contract_modules_scanned: hc2Files.length,
  hc2_bounded_provider_exports: providerBarrelExports,
  root_seed_worker_private_files: rootSeedImplementationFiles,
  portable_secret_exclusion_files: portableAuthorityFiles.length,
  existing_frozen_fixtures_unchanged: Object.keys(frozenFixtureHashes).length,
  production_collaboration_state: "disabled"
}, null, 2)}\n`);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}
