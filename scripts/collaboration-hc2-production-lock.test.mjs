import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const productionRoots = ["app", "components", "lib"];
const violations = [];
for (const productionRoot of productionRoots) {
  for (const file of await sourceFiles(join(root, productionRoot))) {
    if (file.includes(`${join("lib", "collaboration", "hc2")}/`) || file.includes(`${join("lib", "collaboration", "hc2")}\\`)) continue;
    const source = await readFile(file, "utf8");
    if (/from\s+["'][^"']*collaboration\/hc2|import\s*\(\s*["'][^"']*collaboration\/hc2/.test(source)) {
      violations.push(relative(root, file));
    }
  }
}
assert.deepEqual(violations, [], "HC-2 modules entered a production import path");

const collaborationIndex = await readFile(join(root, "lib", "collaboration", "index.ts"), "utf8");
assert(!collaborationIndex.includes("./hc2/"));

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
  const source = await readFile(file, "utf8");
  for (const pattern of forbiddenImportTimeOperations) {
    assert(!pattern.test(source), `${relative(root, file)} contains forbidden Slice 1 activity ${pattern}`);
  }
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
