import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { evaluateCollaborationRootVectors } from "./collaboration-root-vector-runtime.ts";

const vectors = JSON.parse(
  await readFile(new URL("./fixtures/collaboration-roots-v1.json", import.meta.url), "utf8")
);
const result = await evaluateCollaborationRootVectors(vectors);

assert.deepEqual(result, {
  merkle_vectors: 12,
  component_roots: 5,
  identity_vectors: 7,
  verification_cases: 2,
  duplicate_rejections: 1
});
assert.equal(
  vectors.expected.merkle.non_power_of_two_five.root_hex,
  vectors.expected.merkle.permuted_five.root_hex
);
assert.notEqual(
  vectors.expected.merkle.non_power_of_two_five.root_hex,
  vectors.expected.merkle.same_keys_other_family.root_hex
);
assert.equal(
  vectors.expected.verification_cases.onboarding_boundary.full_history_verified,
  false
);

process.stdout.write(`${JSON.stringify({
  ...result,
  frozen_fixture: "collaboration-roots-v1.json",
  normal_test_regeneration: false
}, null, 2)}\n`);
