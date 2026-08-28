import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

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
check(!normalProductionTrustedTypesSource().includes("createScript(value)"), "normal production policies define no TrustedScript return path");

const rejected = null;
const predicateMatrices = [
  {
    name: "production_like",
    origin: "https://patchmark.example/",
    cases: [
      ["exact same-origin chunk", "https://patchmark.example/_next/static/chunks/example.js", "https://patchmark.example/_next/static/chunks/example.js"],
      ["relative same-origin chunk", "/_next/static/chunks/example.js", "https://patchmark.example/_next/static/chunks/example.js"],
      ["explicit default HTTPS port", "https://patchmark.example:443/_next/static/chunks/example.js", "https://patchmark.example/_next/static/chunks/example.js"],
      ["inner dot segment stays in chunks", "https://patchmark.example/_next/static/chunks/nested/../example.js", "https://patchmark.example/_next/static/chunks/example.js"],
      ["localhost HTTP", "http://localhost:3000/_next/static/chunks/example.js", rejected],
      ["IPv4 loopback HTTP", "http://127.0.0.1:3000/_next/static/chunks/example.js", rejected],
      ["IPv6 loopback HTTP", "http://[::1]:3000/_next/static/chunks/example.js", rejected],
      ["short numeric loopback", "http://127.1:3000/_next/static/chunks/example.js", rejected],
      ["integer numeric loopback", "http://2130706433:3000/_next/static/chunks/example.js", rejected],
      ["hex numeric loopback", "http://0x7f000001:3000/_next/static/chunks/example.js", rejected],
      ["scheme-relative localhost", "//localhost:3000/_next/static/chunks/example.js", rejected],
      ["same hostname over HTTP", "http://patchmark.example/_next/static/chunks/example.js", rejected],
      ["different non-default port", "https://patchmark.example:444/_next/static/chunks/example.js", rejected],
      ["subdomain", "https://sub.patchmark.example/_next/static/chunks/example.js", rejected],
      ["suffix-confusion hostname", "https://patchmark.example.attacker.invalid/_next/static/chunks/example.js", rejected],
      ["credentials", "https://user:pass@patchmark.example/_next/static/chunks/example.js", rejected],
      ["query", "https://patchmark.example/_next/static/chunks/example.js?v=1", rejected],
      ["fragment", "https://patchmark.example/_next/static/chunks/example.js#fragment", rejected],
      ["wrong path", "https://patchmark.example/_next/static/media/example.js", rejected],
      ["encoded path separator", "https://patchmark.example/_next/static/chunks/nested%2Fexample.js", rejected],
      ["traversal escapes chunks", "https://patchmark.example/_next/static/chunks/../example.js", rejected],
      ["blob input", "blob:https://patchmark.example/00000000-0000-0000-0000-000000000000", rejected],
      ["data input", "data:text/javascript,alert(1)", rejected],
      ["javascript input", "javascript:alert(1)", rejected]
    ]
  },
  {
    name: "local_qualification",
    origin: "http://localhost:3000/",
    cases: [
      ["exact localhost origin and port", "http://localhost:3000/_next/static/chunks/example.js", "http://localhost:3000/_next/static/chunks/example.js"],
      ["relative localhost chunk", "/_next/static/chunks/example.js", "http://localhost:3000/_next/static/chunks/example.js"],
      ["scheme-relative exact current origin", "//localhost:3000/_next/static/chunks/example.js", "http://localhost:3000/_next/static/chunks/example.js"],
      ["inner dot segment stays in chunks", "/_next/static/chunks/nested/../example.js", "http://localhost:3000/_next/static/chunks/example.js"],
      ["IPv4 loopback differs from localhost", "http://127.0.0.1:3000/_next/static/chunks/example.js", rejected],
      ["IPv6 loopback differs from localhost", "http://[::1]:3000/_next/static/chunks/example.js", rejected],
      ["different localhost port", "http://localhost:3001/_next/static/chunks/example.js", rejected],
      ["HTTPS localhost", "https://localhost:3000/_next/static/chunks/example.js", rejected],
      ["credentials", "http://user:pass@localhost:3000/_next/static/chunks/example.js", rejected],
      ["query", "/_next/static/chunks/example.js?v=1", rejected],
      ["fragment", "/_next/static/chunks/example.js#fragment", rejected],
      ["wrong path", "/_next/static/media/example.js", rejected],
      ["encoded path separator", "/_next/static/chunks/nested%2Fexample.js", rejected],
      ["traversal escapes chunks", "/_next/static/chunks/../example.js", rejected]
    ]
  },
  {
    name: "default_http_port",
    origin: "http://localhost/",
    cases: [
      ["explicit default HTTP port", "http://localhost:80/_next/static/chunks/example.js", "http://localhost/_next/static/chunks/example.js"],
      ["implicit default HTTP port", "http://localhost/_next/static/chunks/example.js", "http://localhost/_next/static/chunks/example.js"]
    ]
  },
  {
    name: "canonical_ipv4_loopback",
    origin: "http://127.0.0.1:3000/",
    cases: [
      ["canonical IPv4", "http://127.0.0.1:3000/_next/static/chunks/example.js", "http://127.0.0.1:3000/_next/static/chunks/example.js"],
      ["short numeric IPv4 canonicalizes", "http://127.1:3000/_next/static/chunks/example.js", "http://127.0.0.1:3000/_next/static/chunks/example.js"],
      ["integer IPv4 canonicalizes", "http://2130706433:3000/_next/static/chunks/example.js", "http://127.0.0.1:3000/_next/static/chunks/example.js"],
      ["hex IPv4 canonicalizes", "http://0x7f000001:3000/_next/static/chunks/example.js", "http://127.0.0.1:3000/_next/static/chunks/example.js"],
      ["localhost is still a different origin", "http://localhost:3000/_next/static/chunks/example.js", rejected],
      ["canonical IPv4 different port", "http://127.0.0.1:3001/_next/static/chunks/example.js", rejected]
    ]
  }
];

const predicateEvidence = { cases: 0, accepted: 0, rejected: 0, matrices: {} };
for (const matrix of predicateMatrices) verifyPredicateMatrix(matrix);

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

process.stdout.write(`${JSON.stringify({
  assertions,
  normal_policy: normal.header,
  optimized_policy: optimized.header,
  optimized_trusted_type_policies: optimized.trusted_type_policies,
  exact_origin_predicate: predicateEvidence,
  exported_injected_parity: true,
  non_loopback_page_rejects_loopback_scripts: true,
  external_network_requests: 0,
  status: "ok"
}, null, 2)}\n`);

function verifyPredicateMatrix(matrix) {
  const locationValue = new URL(matrix.origin);
  const injectedValidator = createInjectedValidator(locationValue, matrix.name);
  let matrixAccepted = 0;
  let matrixRejected = 0;
  for (const [label, value, expected] of matrix.cases) {
    const exported = validatorOutcome(() => validateNormalProductionScriptUrl(value, locationValue));
    const injected = validatorOutcome(() => injectedValidator(value));
    equal(injected, exported, `${matrix.name}: exported and injected predicates agree for ${label}`);
    equal(exported.accepted, expected !== rejected, `${matrix.name}: ${label} has the required disposition`);
    if (expected !== rejected) {
      equal(exported.value, expected, `${matrix.name}: ${label} returns the canonical URL`);
      matrixAccepted += 1;
    } else {
      equal(exported.error_name, "TypeError", `${matrix.name}: ${label} fails closed with TypeError`);
      matrixRejected += 1;
    }
  }
  predicateEvidence.cases += matrix.cases.length;
  predicateEvidence.accepted += matrixAccepted;
  predicateEvidence.rejected += matrixRejected;
  predicateEvidence.matrices[matrix.name] = Object.freeze({ cases: matrix.cases.length, accepted: matrixAccepted, rejected: matrixRejected });
}

function createInjectedValidator(locationValue, matrixName) {
  const createdPolicies = [];
  const context = {
    URL,
    location: new URL(locationValue.href),
    trustedTypes: {
      createPolicy(name, rules) {
        createdPolicies.push(String(name));
        return rules;
      }
    }
  };
  runInNewContext(normalProductionTrustedTypesSource(), context);
  const policy = context.trustedTypes.createPolicy("nextjs#bundler", { createScriptURL: (value) => value });
  equal(createdPolicies, ["default", "nextjs#bundler"], `${matrixName}: injected bootstrap creates only the reviewed policies`);
  return (value) => policy.createScriptURL(value);
}

function validatorOutcome(operation) {
  try {
    return Object.freeze({ accepted: true, value: operation() });
  } catch (error) {
    return Object.freeze({ accepted: false, error_name: error?.name ?? "Error", message: error?.message ?? String(error) });
  }
}
