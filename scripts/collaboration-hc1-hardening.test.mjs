import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  bytesToHex,
  deriveReviewResponseEvidence,
  parseReviewResponseEvidenceCommitment,
  parseReviewResponseEvidenceCore,
  parseReviewResponseImportId,
  parseSemanticPayloadCore,
  verifyReviewResponseEvidenceCommitment
} from "../lib/collaboration/index.ts";

const vectorUrl = new URL(
  "./fixtures/collaboration-review-response-evidence-v1.json",
  import.meta.url
);
const vector = JSON.parse(await readFile(vectorUrl, "utf8"));
let assertions = 0;

const check = (condition, message) => {
  assertions += 1;
  assert(condition, message);
};

const reversed = await deriveReviewResponseEvidence({
  schema_version: 1,
  project_id: vector.project_id,
  review_batch_id: vector.review_batch_id,
  response_import_id: vector.response_import_id,
  contribution_payload_ids: [...vector.contribution_payload_ids].reverse()
});
check(
  reversed.commitment === vector.commitment,
  "the factory must canonicalize contribution ordering"
);
check(
  bytesToHex(reversed.canonical_preimage_bytes) === vector.canonical_preimage_hex,
  "the frozen HC-1 evidence preimage must remain byte exact"
);
check(
  await verifyReviewResponseEvidenceCommitment(reversed.core, reversed.commitment),
  "the strict verifier must reproduce the frozen commitment"
);
check(
  reversed.core.contribution_payload_ids.every(
    (value, index, values) => index === 0 || values[index - 1] < value
  ),
  "the factory output must be sorted and unique"
);

await assert.rejects(
  () => deriveReviewResponseEvidence({
    ...reversed.core,
    contribution_payload_ids: [
      vector.contribution_payload_ids[0],
      vector.contribution_payload_ids[0]
    ]
  }),
  /unique/
);
assertions += 1;

assert.throws(
  () => parseReviewResponseEvidenceCore({
    ...reversed.core,
    contribution_payload_ids: [...reversed.core.contribution_payload_ids].reverse()
  }),
  /sorted and unique/
);
assertions += 1;
assert.throws(
  () => parseReviewResponseEvidenceCore({ ...reversed.core, schema_version: 2 }),
  /Unsupported/
);
assertions += 1;

for (const malformed of [
  vector.commitment.toUpperCase(),
  `sha256:${vector.commitment}`,
  vector.commitment.slice(0, -1),
  "arbitrary-response-identity"
]) {
  assert.throws(
    () => parseReviewResponseEvidenceCommitment(malformed),
    /lowercase SHA-256/
  );
  assertions += 1;
}

for (const privateProvenance of [
  "https://private.invalid/response",
  "/Users/private/response.json",
  "local response handle"
]) {
  assert.throws(
    () => parseReviewResponseImportId(privateProvenance),
    /local provenance token/
  );
  assertions += 1;
}

const changedImport = await deriveReviewResponseEvidence({
  ...reversed.core,
  response_import_id: "import-review-2026_08_23"
});
check(
  changedImport.commitment !== reversed.commitment,
  "explicit import provenance must affect authenticated evidence"
);
const changedContributions = await deriveReviewResponseEvidence({
  ...reversed.core,
  contribution_payload_ids: [vector.contribution_payload_ids[0]]
});
check(
  changedContributions.commitment !== reversed.commitment,
  "the exact contribution set must affect authenticated evidence"
);

const live = parseSemanticPayloadCore({
  schema_version: 1,
  project_id: vector.project_id,
  semantic_kind: "review_batch_operation",
  data: {
    operation: "respond",
    review_batch_id: vector.review_batch_id,
    response_evidence_commitment: vector.commitment,
    response_import_id: vector.response_import_id,
    contribution_payload_ids: vector.contribution_payload_ids
  }
});
check(
  live.data.response_evidence_commitment === vector.commitment &&
    live.data.response_import_id === vector.response_import_id,
  "live semantic response fields must preserve the same strict evidence model"
);
assert.throws(
  () => parseSemanticPayloadCore({
    ...live,
    data: {
      ...live.data,
      source_chat_url: "https://private.invalid/chat"
    }
  }),
  /unexpected field/
);
assertions += 1;
check(
  !new TextDecoder().decode(reversed.canonical_preimage_bytes).includes("private"),
  "private source fields must not enter canonical shared bytes"
);

process.stdout.write(`${JSON.stringify({
  assertions,
  frozen_fixture: vectorUrl.pathname,
  canonical_preimage_bytes: reversed.canonical_preimage_bytes.length,
  evidence_terminology: "review response evidence commitment",
  companion_cross_slice_suites: [
    "collaboration-bootstrap",
    "collaboration-events",
    "collaboration-projector",
    "collaboration-consolidation",
    "collaboration-shadow"
  ]
}, null, 2)}\n`);
