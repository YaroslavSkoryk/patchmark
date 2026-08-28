import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const productionRoots = ["app", "components", "lib"];
const productionImports = [];
const slice6QualificationImports = [];
const agentGuidanceSourceHits = [];
for (const productionRoot of productionRoots) {
  for (const file of await sourceFiles(join(root, productionRoot))) {
    const source = await readFile(file, "utf8");
    const isHc3 = relative(root, file).startsWith(`lib${join("/", "collaboration", "hc3")}`) || relative(root, file).startsWith("lib/collaboration/hc3/");
    if (!isHc3 && /(?:from\s+|import\s*\()["'][^"']*collaboration\/hc3/.test(source)) {
      productionImports.push(relative(root, file));
    }
    if (/PATCHMARK_HC3_SLICE6_EXTERNAL_RUNNER_TEST_ONLY_V1|collaboration-hc3-slice6-external-runner|hc3_slice6_external_qualification_evidence/.test(source)) {
      slice6QualificationImports.push(relative(root, file));
    }
    if (/BEGIN:nextjs-agent-rules|This is NOT the Next\.js you know|@AGENTS\.md/.test(source)) {
      agentGuidanceSourceHits.push(relative(root, file));
    }
  }
}
assert.deepEqual(
  productionImports,
  ["components/collaboration/collaboration-qualification-workspace.tsx"],
  "Only the gated lazy qualification workspace may import HC-3"
);
assert.deepEqual(slice6QualificationImports, [], "Slice 6 external qualification infrastructure entered a production source graph");
assert.deepEqual(agentGuidanceSourceHits, [], "Repository agent guidance entered a production source graph");
const reviewManifest = JSON.parse(await readFile(join(root, "docs", "hc3", "review-manifest-slice6.json"), "utf8"));
assert.deepEqual(
  reviewManifest.covered_files
    .filter((entry) => entry.path === "AGENTS.md" || entry.path === "CLAUDE.md")
    .map(({ path, category }) => ({ path, category })),
  [
    { path: "AGENTS.md", category: "covered_source" },
    { path: "CLAUDE.md", category: "covered_source" }
  ],
  "Agent guidance must remain reviewed repository source rather than a deployable category"
);
const productLoader = await readFile(join(root, "lib", "collaboration-shadow", "product-qualification-loader.ts"), "utf8");
assert(productLoader.includes("collaboration-qualification-workspace.tsx"), "The accepted gate must own the only product-workspace load edge");
const productEntrypoint = await readFile(join(root, "lib", "collaboration-shadow", "entrypoint.ts"), "utf8");
assert(productEntrypoint.includes('import("./product-qualification-loader.ts")'), "Product qualification must remain behind the shadow production gate");

const collaborationIndex = await readFile(join(root, "lib", "collaboration", "index.ts"), "utf8");
assert(!collaborationIndex.includes("./hc3/"), "HC-3 entered the production collaboration barrel");

const hc3Files = await sourceFiles(join(root, "lib", "collaboration", "hc3"));
const forbiddenCapabilities = [
  /\bfetch\s*\(/, /\bWebSocket\b/, /\bRTCPeerConnection\b/, /\bEventSource\b/,
  /\bnavigator\.locks\b/, /\bindexedDB\b/, /\bshow(?:Open|Save)FilePicker\b/,
  /\bgetRandomValues\b/, /\bMath\.random\b/, /\bnew\s+Worker\b/,
  /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bdynamic\s*import\b/
];
for (const file of hc3Files) {
  const source = await readFile(file, "utf8");
  for (const pattern of forbiddenCapabilities) {
    if (
      relative(root, file) === "lib/collaboration/hc3/product-capabilities.ts" &&
      /RTCPeerConnection|indexedDB|show\(\?:Open\|Save\)FilePicker/.test(pattern.source)
    ) continue;
    assert(!pattern.test(source), `${relative(root, file)} contains forbidden HC-3 capability ${pattern}`);
  }
}

const routeFiles = (await sourceFiles(join(root, "app"))).filter((file) => /(?:route|page)\.(?:ts|tsx|js|mjs)$/.test(file));
for (const file of routeFiles) {
  const source = await readFile(file, "utf8");
  assert(!/hc3|handoff|pmhc3|\.pmcb/.test(source), `${relative(root, file)} exposes an HC-3 production route or handler`);
}

const frozenFixtureHashes = {
  "scripts/fixtures/collaboration-canonical-v1.json": "f178eb0510471ef9a9ed6835840b75c1bf9b21a22b445c3ce00275582182726b",
  "scripts/fixtures/collaboration-roots-v1.json": "42189802cee24766e73e974fd09b6e1bd9f612c90da184399a82bea91a1e211e",
  "scripts/fixtures/collaboration-review-response-evidence-v1.json": "7b9dc41a3407549167286aaed20f32c967db5878f2705d219627b08d4ba30e67",
  "scripts/fixtures/collaboration-hc2-slice1-v1.json": "534ec34c32cd208759c135c77d69dcd7cab6fa7cfac93ba6f7680c03171f9cbc",
  "scripts/fixtures/collaboration-hc2-slice3-v1.json": "a74b3f3f171f1b23a6b8b60c5131e0d15a5a36ecd589d0d5d5b8f5997c47bb73",
  "scripts/fixtures/collaboration-hc2-slice4-v1.json": "81b5babfff1faa4092a27ccab598dc78eb47c4ba6609baac59132ef9730a4e50",
  "scripts/fixtures/collaboration-hc2-slice5-v1.json": "6cbb2877156de12b54d976e100cb94de0b1f85d1f4b20f8c8c7284df0a4d4e89",
  "scripts/fixtures/collaboration-hc2-slice6-v2.json": "4400b16f1de78f3ae49f04844f85c7278dbc28291dd772bdfad1c6ea0b69eb4c",
  "scripts/fixtures/collaboration-hc2-slice7-v3.json": "98450f518c9827ec0e310aa2a7a66d99fb4ba5c33f0b0aa3fddb75b4f95a5df1",
  "scripts/fixtures/collaboration-hc2-slice8-qualification-template.json": "735fdbb8df9b93367d5907592e78e7e3e00050740da312e3b6227bc260f5dc46",
  "scripts/fixtures/collaboration-hc3-slice1-v1.json": "fd4aaa38af60d0f12054c475a3ce86b71ad9bc85aa4f1f2f9b24f085f3c370fe",
  "scripts/fixtures/collaboration-hc3-slice3-v1.json": "6defdcb1e2578fa3aa0767c9a009d994046191006db715b7df46fda84221ae8a",
  "scripts/fixtures/collaboration-hc3-slice4-v1.json": "ec123fb2dce2eedc4e55f0e82db5ff6d0f18896352ff51ebbafd606f88475ca6"
};
for (const [path, expected] of Object.entries(frozenFixtureHashes)) {
  const bytes = await readFile(join(root, path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${path} changed`);
}

let productionBuildGraphChecked = false;
let hc3InInitialPageGraph = false;
const slice6DeployableHits = [];
const agentGuidanceDeployableHits = [];
try {
  const manifest = JSON.parse(await readFile(join(root, ".next", "build-manifest.json"), "utf8"));
  productionBuildGraphChecked = true;
  const initialFiles = [...new Set(Object.values(manifest.pages ?? {}).flat())];
  for (const path of initialFiles) {
    if (!path.endsWith(".js")) continue;
    const source = await readFile(join(root, ".next", path), "utf8");
    if (/pmhc3|connection-offer-commitment|\.pmcb/.test(source)) hc3InInitialPageGraph = true;
  }
  assert(!hc3InInitialPageGraph, "HC-3 code entered the initial production page graph");
  for (const file of await deployableFiles(join(root, ".next"))) {
    const source = await readFile(file, "utf8");
    if (/PATCHMARK_HC3_SLICE6_EXTERNAL_RUNNER_TEST_ONLY_V1|collaboration-hc3-slice6-external-runner|hc3_slice6_external_qualification_evidence|qualification-metadata\.json/.test(source)) {
      slice6DeployableHits.push(relative(root, file));
    }
    if (/BEGIN:nextjs-agent-rules|This is NOT the Next\.js you know|@AGENTS\.md/.test(source)) {
      agentGuidanceDeployableHits.push(relative(root, file));
    }
  }
  assert.deepEqual(slice6DeployableHits, [], "Slice 6 qualification runner or evidence parser entered deployable production output");
  assert.deepEqual(agentGuidanceDeployableHits, [], "Repository agent guidance entered deployable production output");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

process.stdout.write(`${JSON.stringify({
  production_hc3_imports: productionImports,
  hc3_modules_scanned: hc3Files.length,
  production_routes_added: false,
  protocol_handlers_registered: false,
  forbidden_capabilities_present: false,
  existing_frozen_fixtures_unchanged: Object.keys(frozenFixtureHashes).length,
  production_build_graph_checked: productionBuildGraphChecked,
  hc3_in_initial_page_graph: hc3InInitialPageGraph,
  slice6_qualification_imports: slice6QualificationImports,
  slice6_deployable_hits: slice6DeployableHits,
  agent_guidance_manifest_category: "covered_source",
  agent_guidance_source_hits: agentGuidanceSourceHits,
  agent_guidance_deployable_hits: agentGuidanceDeployableHits,
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

async function deployableFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await deployableFiles(path));
    else if (/\.(?:js|json|html|txt)$/.test(entry.name)) files.push(path);
  }
  return files;
}
