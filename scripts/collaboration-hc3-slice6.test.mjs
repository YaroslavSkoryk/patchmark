import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createEvidenceSessionId,
  evaluateReviewManifestCurrency,
  sha256Bytes,
  summarizeExternalQualificationEvidence,
  validateExternalQualificationEvidence,
  validateReviewManifest,
  validateSlice6ReadinessMatrix
} from "./lib/collaboration-hc3-slice6-evidence.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
let assertions = 0;
const check = (value, message) => { assertions += 1; assert.ok(value, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const throws = (operation, pattern, message) => { assertions += 1; assert.throws(operation, pattern, message); };

const deterministicSession = createEvidenceSessionId(() => Uint8Array.from({ length: 16 }, (_, index) => index));
equal(deterministicSession, "hc3q_000102030405060708090a0b0c0d0e0f", "evidence session identifiers are explicit and deterministic under an injected test source");

const templatePath = join(root, "scripts/fixtures/collaboration-hc3-slice6-qualification-template.json");
const template = JSON.parse(readFileSync(templatePath, "utf8"));
equal(validateExternalQualificationEvidence(template).authority, "none", "external evidence is strictly authority-free");
equal(summarizeExternalQualificationEvidence(template).authority_equality, "not_exercised", "a template cannot become real platform evidence");

const exercised = structuredClone(template);
exercised.evidence_session_id = deterministicSession;
exercised.environment = {
  browser_name: "Google Chrome",
  browser_version: "151.0.7922.174",
  engine: "Blink 151",
  os_name: "macOS",
  os_version: "26.2",
  device_model: "MacBook Pro",
  execution_mode: "headless",
  user_agent: "Synthetic qualification browser identifier"
};
exercised.capabilities.push({ id: "nonextractable_signing_key_reopen", browser_reported: true, exercise_status: "pass", detail_code: "real_reopen_passed" });
exercised.permissions.push({ id: "clipboard_write", outcome: "denied", evidence_mode: "manual", status: "pass", detail_code: "denial_preserved_artifact" });
exercised.artifacts.push({ kind: "v3_replication_bundle", byte_length: 4096, sha256: "1".repeat(64) });
exercised.assertions.push(
  { id: "authority_equal_after_reopen", evidence_mode: "automated", status: "pass", detail_code: "exact_commitments_equal" },
  { id: "screen_reader_review", evidence_mode: "manual", status: "not_exercised", detail_code: "qualified_reviewer_required" }
);
exercised.authority_equality = { status: "pass", commitments: { projection_root: "2".repeat(64) }, reopen_equal: true };
exercised.policy = { csp: "pass", trusted_types: "pass", violation_count: 0 };
const parsed = validateExternalQualificationEvidence(exercised);
equal(parsed.assertions.map((entry) => entry.evidence_mode), ["automated", "manual"], "manual assertions remain distinct from automated assertions");
equal(summarizeExternalQualificationEvidence(parsed).totals, { pass: 6, conditional: 0, blocked: 0, not_exercised: 1 }, "evidence summaries do not upgrade missing review to a pass");

for (const mutation of [
  (value) => { value.authority = "hc2_hc3"; },
  (value) => { value.synthetic_project = false; },
  (value) => { value.unknown = true; },
  (value) => { value.artifacts[0].sha256 = "not-a-digest"; },
  (value) => { value.environment.device_model = "/Users/example/private-project"; },
  (value) => { value.assertions[0].detail_code = `encoded_${"A".repeat(600)}`; }
]) {
  const hostile = structuredClone(exercised);
  mutation(hostile);
  throws(() => validateExternalQualificationEvidence(hostile), /authority|synthetic|unexpected|invalid|forbidden|encoded|secret|path|limit/i, "strict evidence parsing rejects authority, unknown fields, malformed hashes, paths, secrets, and oversized encoded material");
}

const readiness = validateSlice6ReadinessMatrix(JSON.parse(readFileSync(join(root, "docs/hc3/readiness-slice6.json"), "utf8")));
check(readiness.items.length >= 20, "Slice 6 readiness matrix covers the release-candidate decision surface");
check(readiness.items.some((entry) => entry.status === "blocked") && readiness.items.some((entry) => entry.status === "not_exercised"), "missing and blocking evidence remains explicit");
check(readiness.items.every((entry) => entry.expires_or_invalidates_on.length > 0), "every readiness conclusion declares invalidation conditions");

const manifest = validateReviewManifest(JSON.parse(readFileSync(join(root, "docs/hc3/review-manifest-slice6.json"), "utf8")));
equal(evaluateReviewManifestCurrency(manifest, root, readiness.browser_floor), { current: true, stale: [] }, "review evidence is current only while every covered byte and browser floor matches");
const staleManifest = structuredClone(manifest);
staleManifest.covered_files[0].sha256 = "f".repeat(64);
equal(evaluateReviewManifestCurrency(staleManifest, root, readiness.browser_floor).current, false, "a covered source byte change invalidates review evidence");
equal(evaluateReviewManifestCurrency(manifest, root, `${readiness.browser_floor} changed`).stale[0].kind, "browser_floor", "a browser-floor change invalidates platform conclusions");

const applicationSources = [
  ...sourceFiles(join(root, "app")),
  ...sourceFiles(join(root, "components")),
  ...sourceFiles(join(root, "lib"))
].map((path) => readFileSync(path, "utf8")).join("\n");
check(!applicationSources.includes("PATCHMARK_HC3_SLICE6_EXTERNAL_RUNNER_TEST_ONLY_V1"), "the external-runner marker is absent from every application and production library source");
check(!applicationSources.includes("collaboration-hc3-slice6-external-runner"), "production sources do not import the external runner");
const optimizedEntry = readFileSync(join(root, "scripts/collaboration-hc3-slice5-optimized-entry.tsx"), "utf8");
check(optimizedEntry.includes("createSlice4RealProductAuthorityRuntime") && !/location\.(?:search|hash)|localStorage|document\.cookie/.test(optimizedEntry), "the qualification entry assembles the real authority runtime and exposes no runtime-selected deterministic driver");

const frozenHashes = {
  "collaboration-canonical-v1.json": "f178eb0510471ef9a9ed6835840b75c1bf9b21a22b445c3ce00275582182726b",
  "collaboration-hc2-slice1-v1.json": "534ec34c32cd208759c135c77d69dcd7cab6fa7cfac93ba6f7680c03171f9cbc",
  "collaboration-hc2-slice3-v1.json": "a74b3f3f171f1b23a6b8b60c5131e0d15a5a36ecd589d0d5d5b8f5997c47bb73",
  "collaboration-hc2-slice4-v1.json": "81b5babfff1faa4092a27ccab598dc78eb47c4ba6609baac59132ef9730a4e50",
  "collaboration-hc2-slice5-v1.json": "6cbb2877156de12b54d976e100cb94de0b1f85d1f4b20f8c8c7284df0a4d4e89",
  "collaboration-hc2-slice6-v2.json": "4400b16f1de78f3ae49f04844f85c7278dbc28291dd772bdfad1c6ea0b69eb4c",
  "collaboration-hc2-slice7-v3.json": "98450f518c9827ec0e310aa2a7a66d99fb4ba5c33f0b0aa3fddb75b4f95a5df1",
  "collaboration-hc2-slice8-qualification-template.json": "735fdbb8df9b93367d5907592e78e7e3e00050740da312e3b6227bc260f5dc46",
  "collaboration-hc3-slice1-v1.json": "fd4aaa38af60d0f12054c475a3ce86b71ad9bc85aa4f1f2f9b24f085f3c370fe",
  "collaboration-hc3-slice3-v1.json": "6defdcb1e2578fa3aa0767c9a009d994046191006db715b7df46fda84221ae8a",
  "collaboration-hc3-slice4-v1.json": "ec123fb2dce2eedc4e55f0e82db5ff6d0f18896352ff51ebbafd606f88475ca6",
  "collaboration-hc3-slice6-qualification-template.json": "d2b2bea2e3ba746e4dbd3ed7d16aee072b37b6fcda633dbaa3d5fdda3bb4c2c6",
  "collaboration-review-response-evidence-v1.json": "7b9dc41a3407549167286aaed20f32c967db5878f2705d219627b08d4ba30e67",
  "collaboration-roots-v1.json": "42189802cee24766e73e974fd09b6e1bd9f612c90da184399a82bea91a1e211e"
};
for (const [name, digest] of Object.entries(frozenHashes)) equal(sha256Bytes(readFileSync(join(root, "scripts/fixtures", name))), digest, `${name} remains byte-identical`);
equal(sha256Bytes(readFileSync(join(root, "scripts/fixtures/collaboration-hc3-slice7a-editor-corpus-v1.json"))), "4a9afec6f85d57bfe433a9166511ed8a96683c5b0c95252855c6832a8e278e2c", "the Slice 7A test-only editor corpus remains byte-identical");

process.stdout.write(`${JSON.stringify({
  assertions,
  readiness_rows: readiness.items.length,
  manifest_files: manifest.covered_files.length,
  external_evidence_authority: "none",
  frozen_fixtures_unchanged: Object.keys(frozenHashes).length,
  production_enabled: false,
  status: "ok"
}, null, 2)}\n`);

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}
