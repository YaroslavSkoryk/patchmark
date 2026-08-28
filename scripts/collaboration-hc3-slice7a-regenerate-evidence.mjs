import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const baselineCommit = "1f4b3049717b4e9faf55a1a2c9541a9e284df58a";
const readinessPath = join(root, "docs/hc3/readiness-slice6.json");
const manifestPath = join(root, "docs/hc3/review-manifest-slice6.json");

const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
readiness.baseline_commit = baselineCommit;

const dependencyClosures = new Map([
  ["HC3-S6-JS-YAML", {
    status: "pass",
    residual_risk: "Future editor, parser, schema, corpus, or source-authority changes require requalification",
    blocking: false,
    required_approver: "none"
  }],
  ["HC3-S6-POSTCSS", {
    status: "pass",
    residual_risk: "Future framework, build input, bundler, source-map, CSP, or Trusted Types changes require requalification",
    blocking: false,
    required_approver: "none"
  }],
  ["HC3-S6-S7A-EDITOR-PERFORMANCE", {
    requirement: "MDXEditor 4 passes the fixed optimized-production materiality gate while the original development gate remains historical diagnostic evidence",
    status: "pass",
    residual_risk: "The final production comparison passes the prospectively fixed +50 ms median and +100 ms p95 materiality budgets; development remains a reported diagnostic and misses its historical median ceiling",
    blocking: false,
    required_approver: "none"
  }]
]);

for (const row of readiness.items) {
  const closure = dependencyClosures.get(row.id);
  if (closure) Object.assign(row, closure, { evidence_hash: sha256File(row.evidence_source) });
  else if (row.evidence_hash !== null) row.evidence_hash = sha256File(row.evidence_source);
}

for (const id of dependencyClosures.keys()) {
  if (!readiness.items.some((row) => row.id === id)) throw new Error(`missing readiness row ${id}`);
}

writeJson(readinessPath, readiness);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.baseline_commit = baselineCommit;
const covered = new Map(manifest.covered_files.map((entry) => [entry.path, entry.category]));
for (const [path, category] of Object.entries({
  "AGENTS.md": "covered_source",
  "CLAUDE.md": "covered_source",
  "app/globals.css": "covered_source",
  "components/comments-panel.tsx": "covered_source",
  "components/deferred-mdx-heavy-editors.tsx": "covered_source",
  "components/document-editor.tsx": "covered_source",
  "components/mdx-editor-client.tsx": "covered_source",
  "components/mdx-render-error-lifecycle-regression-harness.tsx": "covered_source",
  "docs/hc3/dependency-migration-slice7a.md": "covered_source",
  "docs/hc3/document-switch-performance-slice7a.json": "covered_source",
  "eslint.config.mjs": "security_policy",
  "lib/performance/document-switch-performance.ts": "covered_source",
  "next-env.d.ts": "covered_source",
  "scripts/collaboration-hc3-slice7a-editor-browser.test.mjs": "covered_source",
  "scripts/collaboration-hc3-slice7a-frontmatter-security.test.mjs": "covered_source",
  "scripts/collaboration-hc3-slice7a-regenerate-evidence.mjs": "covered_source",
  "scripts/comment-reanchor-browser.test.mjs": "covered_source",
  "scripts/document-switch-performance-browser.test.mjs": "covered_source",
  "scripts/fixtures/collaboration-hc3-slice7a-editor-corpus-v1.json": "frozen_fixture",
  "scripts/lib/fixtures/create-document-switch-project.mjs": "covered_source",
  "scripts/responsive-accessibility-foundation-browser.test.mjs": "covered_source",
  "tsconfig.json": "covered_source"
})) covered.set(path, category);

manifest.covered_files = [...covered]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, category]) => ({ path, sha256: sha256File(path), category }));
writeJson(manifestPath, manifest);

process.stdout.write(`${JSON.stringify({
  baseline_commit: baselineCommit,
  readiness_sha256: sha256File("docs/hc3/readiness-slice6.json"),
  manifest_sha256: sha256File("docs/hc3/review-manifest-slice6.json"),
  manifest_files: manifest.covered_files.length,
  evidence_rows_closed: [...dependencyClosures.keys()],
  production_enabled: readiness.production_enabled,
  classification: readiness.classification
}, null, 2)}\n`);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
