import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertPolicyShape,
  instrumentPolicyHtml,
  normalProductionTrustedTypesSource,
  normalProductionPolicy,
  optimizedCollaborationPolicy,
  RADIX_SELECT_VIEWPORT_STYLE,
  validateNormalProductionScriptUrl,
  validateNormalProductionTrustedHtml
} from "./lib/collaboration-hc3-slice5-policy.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
let assertions = 0;
const check = (value, message) => { assertions += 1; assert.ok(value, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const normal = normalProductionPolicy("normal-nonce");
const optimized = optimizedCollaborationPolicy("optimized-nonce");
check(assertPolicyShape(normal), "normal production policy has the required strict shape");
check(assertPolicyShape(optimized), "optimized collaboration policy has the required strict shape");
equal(normal.trusted_type_policies, ["default", "nextjs#bundler"], "normal production permits only its exact style boundary and Next's production bundler policy");
equal(optimized.trusted_type_policies, ["patchmark#optimized-bundler"], "optimized collaboration permits only its private production-bundler policy");
check(optimized.header.includes("trusted-types patchmark#optimized-bundler"), "optimized harness blocks every unrelated Trusted Types policy");
check(!optimized.header.includes("ws:") && !optimized.header.includes("http:") && !optimized.header.includes("https:"), "optimized policy admits no remote or HMR origin");
const instrumented = instrumentPolicyHtml("<!doctype html><html><head></head><body><script src=\"/app.js\"></script></body></html>", "n");
equal((instrumented.match(/nonce=\"n\"/g) ?? []).length, 2, "policy instrumentation nonces the bootstrap and application script");
check(!instrumented.includes("pmhc3.") && !instrumented.includes("artifact_text"), "policy instrumentation contains no artifact material");
equal(validateNormalProductionTrustedHtml(RADIX_SELECT_VIEWPORT_STYLE), RADIX_SELECT_VIEWPORT_STYLE, "normal production accepts only the frozen Radix Select viewport style");
for (const hostile of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "javascript:alert(1)", `${RADIX_SELECT_VIEWPORT_STYLE} body{display:none}`]) {
  assert.throws(() => validateNormalProductionTrustedHtml(hostile), /fixed Radix Select viewport-style boundary/);
  assertions += 1;
}
const normalLocation = new URL("http://127.0.0.1:3131/");
equal(validateNormalProductionScriptUrl("/_next/static/chunks/app/page-1234abcd.js", normalLocation), "http://127.0.0.1:3131/_next/static/chunks/app/page-1234abcd.js", "Next bundler policy accepts its fixed same-origin chunk shape");
for (const hostile of [
  "https://attacker.invalid/_next/static/chunks/app.js",
  "javascript:alert(1)",
  "/_next/static/chunks/app.js?secret=artifact",
  "/_next/static/media/not-a-chunk.js",
  "http://user:pass@127.0.0.1:3131/_next/static/chunks/app.js"
]) {
  assert.throws(() => validateNormalProductionScriptUrl(hostile, normalLocation), /fixed same-origin chunk boundary/);
  assertions += 1;
}
check(!normalProductionTrustedTypesSource().includes("createScript(value)"), "normal production policies define no TrustedScript return path");

const entry = readFileSync(resolve(root, "scripts/collaboration-hc3-slice5-optimized-entry.tsx"), "utf8");
const applicationSources = [
  "app/page.tsx",
  "components/document-editor.tsx",
  "lib/collaboration-shadow/entrypoint.ts",
  "next.config.ts"
].map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
check(entry.includes("PATCHMARK_HC3_SLICE5_OPTIMIZED_HARNESS_V1"), "optimized entry has an explicit scan marker");
check(!applicationSources.includes("PATCHMARK_HC3_SLICE5_OPTIMIZED_HARNESS_V1"), "production application sources do not reference the optimized marker");
check(!applicationSources.includes("collaboration-hc3-slice5-optimized-entry"), "production application sources do not import the harness entry");
check(!entry.includes("dangerouslySetInnerHTML") && !entry.includes("eval(") && !entry.includes("new Function"), "optimized entry introduces no executable sink");

process.stdout.write(`${JSON.stringify({ assertions, normal_policy: normal.header, optimized_policy: optimized.header, optimized_trusted_type_policies: optimized.trusted_type_policies, status: "ok" }, null, 2)}\n`);
