import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assertCanonicalCbor,
  buildSignaturePreimage,
  bytesEqual,
  bytesToHex,
  canonicalArray,
  canonicalBytes,
  canonicalMap,
  canonicalNull,
  canonicalText,
  canonicalUint,
  collaborationHashDomains,
  collaborationSignatureDomains,
  decodeCanonicalCbor,
  decodeSha256Base32,
  deriveAcknowledgementIdentity,
  deriveControlActionIdentity,
  deriveControlEventIdentity,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveMergeKeyIdentity,
  deriveProjectionSnapshotIdentity,
  deriveSemanticEventIdentity,
  deriveSemanticPayloadIdentity,
  digestBytesFromId,
  encodeCanonicalCbor,
  encodeSha256Base32,
  formatDigestId,
  parseDigestId,
  sha256,
  webCryptoSha256
} from "../lib/collaboration/index.ts";
import {
  createObjectFixtures,
  evaluateCollaborationVectors
} from "./collaboration-vector-runtime.ts";

const vectorUrl = new URL("./fixtures/collaboration-canonical-v1.json", import.meta.url);
const vectors = JSON.parse(await readFile(vectorUrl, "utf8"));
const vectorCounts = await evaluateCollaborationVectors(vectors);
const fixtures = createObjectFixtures();
let focusedChecks = 0;

function check(operation) {
  operation();
  focusedChecks += 1;
}

async function checkAsync(operation) {
  await operation();
  focusedChecks += 1;
}

check(() => {
  const forward = canonicalMap([
    ["z", canonicalUint(0n)],
    ["é", canonicalUint(1n)]
  ]);
  const reverse = canonicalMap([
    ["é", canonicalUint(1n)],
    ["z", canonicalUint(0n)]
  ]);
  assert.equal(bytesToHex(encodeCanonicalCbor(forward)), "a2617a0062c3a901");
  assert.deepEqual(encodeCanonicalCbor(reverse), encodeCanonicalCbor(forward));
});

check(() => {
  const entries = Object.entries(fixtures.values.controlActionCore).reverse();
  const reversedPropertyOrder = Object.fromEntries(entries);
  assert.notDeepEqual(
    Object.keys(reversedPropertyOrder),
    Object.keys(fixtures.values.controlActionCore)
  );
});

await checkAsync(async () => {
  const reversedPropertyOrder = Object.fromEntries(
    Object.entries(fixtures.values.controlActionCore).reverse()
  );
  const [left, right] = await Promise.all([
    deriveControlActionIdentity(fixtures.values.controlActionCore),
    deriveControlActionIdentity(reversedPropertyOrder)
  ]);
  assert.deepEqual(left.canonical_bytes, right.canonical_bytes);
  assert.equal(left.id, right.id);
});

await checkAsync(async () => {
  const results = await Promise.all(
    Array.from({ length: 32 }, () =>
      deriveSemanticPayloadIdentity(fixtures.values.semanticPayloadCore)
    )
  );
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(
    new Set(results.map((result) => bytesToHex(result.canonical_bytes))).size,
    1
  );
});

await checkAsync(async () => {
  const original = await deriveControlActionIdentity(fixtures.values.controlActionCore);
  const changed = await deriveControlActionIdentity({
    ...fixtures.values.controlActionCore,
    role: "reviewer"
  });
  assert.notEqual(changed.id, original.id);
});

await checkAsync(async () => {
  const core = canonicalMap([["value", canonicalUint(1n)]]);
  const left = encodeCanonicalCbor(
    canonicalArray([canonicalText(collaborationHashDomains.controlAction), core])
  );
  const right = encodeCanonicalCbor(
    canonicalArray([canonicalText(collaborationHashDomains.semanticPayload), core])
  );
  assert.notDeepEqual(left, right);
  assert.notDeepEqual(await sha256(left), await sha256(right));
});

await checkAsync(async () => {
  const all = await Promise.all(Object.values(fixtures.objects).map((derive) => derive()));
  assert.equal(new Set(all.map((result) => bytesToHex(result.digest))).size, all.length);
});

await checkAsync(async () => {
  const source = new TextEncoder().encode("same Markdown\n");
  const otherProject = entity("project", "b");
  const [first, repeated, other] = await Promise.all([
    deriveMarkdownBlobIdentity(fixtures.ids.project, source),
    deriveMarkdownBlobIdentity(fixtures.ids.project, Uint8Array.from(source)),
    deriveMarkdownBlobIdentity(otherProject, source)
  ]);
  assert.equal(first.id, repeated.id);
  assert.notEqual(first.id, other.id);
});

await checkAsync(async () => {
  const variants = await Promise.all([
    deriveMarkdownBlobIdentity(fixtures.ids.project, new TextEncoder().encode("line\n")),
    deriveMarkdownBlobIdentity(fixtures.ids.project, new TextEncoder().encode("line\r\n")),
    deriveMarkdownBlobIdentity(fixtures.ids.project, new TextEncoder().encode("\ufeffline\n")),
    deriveMarkdownBlobIdentity(fixtures.ids.project, new TextEncoder().encode("é\n")),
    deriveMarkdownBlobIdentity(fixtures.ids.project, new TextEncoder().encode("e\u0301\n"))
  ]);
  assert.equal(new Set(variants.map((result) => result.id)).size, variants.length);
});

await checkAsync(async () => {
  await assert.rejects(
    deriveMarkdownBlobIdentity(fixtures.ids.project, Uint8Array.from([0xff])),
    /UTF-8/
  );
});

await checkAsync(async () => {
  const reversedParents = {
    ...fixtures.values.semanticEventCore,
    causal_parent_event_ids: [...fixtures.values.semanticEventCore.causal_parent_event_ids].reverse()
  };
  await assert.rejects(
    deriveSemanticEventIdentity(reversedParents, fixtures.values.semanticPayloadRecord),
    /sorted and unique/
  );
});

await checkAsync(async () => {
  const duplicateParents = {
    ...fixtures.values.semanticEventCore,
    causal_parent_event_ids: [fixtures.ids.eventA, fixtures.ids.eventA]
  };
  await assert.rejects(
    deriveSemanticEventIdentity(duplicateParents, fixtures.values.semanticPayloadRecord),
    /sorted and unique/
  );
});

await checkAsync(async () => {
  await assert.rejects(
    deriveSemanticPayloadIdentity({
      schema_version: 1,
      project_id: fixtures.ids.project,
      semantic_kind: "comment_operation",
      data: {
        operation: "create",
        document_id: fixtures.ids.document,
        comment_id: entity("comment"),
        content: "e\u0301"
      }
    }),
    /NFC/
  );
});

check(() => {
  const canonical = encodeCanonicalCbor(canonicalArray([canonicalUint(24n), canonicalNull]));
  assert.deepEqual(encodeCanonicalCbor(decodeCanonicalCbor(canonical)), canonical);
  assert.throws(() => decodeCanonicalCbor(Uint8Array.from([0x98, 0x02, 0x18, 0x18, 0xf6])));
});

check(() => {
  assertCanonicalCbor(
    encodeCanonicalCbor(canonicalText("accepted")),
    canonicalText("accepted")
  );
  assert.throws(() =>
    assertCanonicalCbor(
      encodeCanonicalCbor(canonicalText("accepted")),
      canonicalText("different")
    )
  );
});

await checkAsync(async () => {
  const input = new TextEncoder().encode("concurrent hash input");
  const digests = await Promise.all(Array.from({ length: 64 }, () => sha256(input)));
  assert.equal(new Set(digests.map(bytesToHex)).size, 1);
});

await checkAsync(async () => {
  const source = Uint8Array.from([1, 2, 3, 4]);
  const expected = bytesToHex(await webCryptoSha256(source));
  const pending = sha256(source, async (copiedInput) => {
    await Promise.resolve();
    return webCryptoSha256(copiedInput);
  });
  source.fill(255);
  assert.equal(bytesToHex(await pending), expected);
});

await checkAsync(async () => {
  const providerOutput = new Uint8Array(32).fill(7);
  const result = await sha256(new Uint8Array(), async () => providerOutput);
  providerOutput.fill(9);
  assert.equal(bytesToHex(result), "07".repeat(32));
});

await checkAsync(async () => {
  await assert.rejects(sha256(new Uint8Array(), async () => new Uint8Array(31)), /32 bytes/);
  await assert.rejects(
    sha256(new Uint8Array(), async () => {
      throw new Error("secure provider unavailable");
    }),
    /secure provider unavailable/
  );
});

await checkAsync(async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.ok(cryptoDescriptor?.configurable);
  delete globalThis.crypto;
  try {
    await assert.rejects(webCryptoSha256(new Uint8Array()), /unavailable/);
  } finally {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  }
  await assert.rejects(webCryptoSha256([]), /Uint8Array/);
});

check(() => {
  const source = Uint8Array.from([1, 2, 3]);
  const value = canonicalBytes(source);
  source.fill(9);
  assert.equal(bytesToHex(encodeCanonicalCbor(value)), "43010203");
});

check(() => {
  const digest = new Uint8Array(32).fill(0xff);
  const encoded = encodeSha256Base32(digest);
  const decoded = decodeSha256Base32(encoded);
  decoded.fill(0);
  assert.equal(encodeSha256Base32(digest), encoded);
});

await checkAsync(async () => {
  const independentlyConstructed = {
    merge_algorithm_version: fixtures.values.mergeKeyCore.merge_algorithm_version,
    result_revision_id: fixtures.values.mergeKeyCore.result_revision_id,
    parent_revision_ids: [...fixtures.values.mergeKeyCore.parent_revision_ids],
    project_id: fixtures.values.mergeKeyCore.project_id,
    schema_version: 1,
    base_revision_id: fixtures.values.mergeKeyCore.base_revision_id,
    merge_algorithm_id: fixtures.values.mergeKeyCore.merge_algorithm_id,
    document_id: fixtures.values.mergeKeyCore.document_id,
    object_kind: "merge_key_core"
  };
  const [left, right] = await Promise.all([
    deriveMergeKeyIdentity(fixtures.values.mergeKeyCore),
    deriveMergeKeyIdentity(independentlyConstructed)
  ]);
  assert.deepEqual(left.canonical_bytes, right.canonical_bytes);
  assert.equal(left.id, right.id);
});

await checkAsync(async () => {
  const changed = {
    ...fixtures.values.semanticEventCore,
    display_timestamp: "2030-01-01T00:00:00.000Z"
  };
  const [left, right] = await Promise.all([
    deriveSemanticEventIdentity(
      fixtures.values.semanticEventCore,
      fixtures.values.semanticPayloadRecord
    ),
    deriveSemanticEventIdentity(changed, fixtures.values.semanticPayloadRecord)
  ]);
  assert.equal(left.id, right.id);
});

await checkAsync(async () => {
  const changed = {
    ...fixtures.values.controlEventCore,
    display_timestamp: "2030-01-01T00:00:00.000Z"
  };
  const [left, right] = await Promise.all([
    deriveControlEventIdentity(fixtures.values.controlEventCore),
    deriveControlEventIdentity(changed)
  ]);
  assert.equal(left.id, right.id);
});

await checkAsync(async () => {
  const changed = {
    ...fixtures.values.acknowledgementCore,
    display_timestamp: "2030-01-01T00:00:00.000Z"
  };
  const [left, right] = await Promise.all([
    deriveAcknowledgementIdentity(fixtures.values.acknowledgementCore),
    deriveAcknowledgementIdentity(changed)
  ]);
  assert.equal(left.id, right.id);
});

await checkAsync(async () => {
  await assert.rejects(
    deriveDocumentRevisionIdentity({
      ...fixtures.values.revisionCore,
      revision_id: fixtures.ids.revisionC
    }),
    /unexpected field/
  );
  await assert.rejects(
    deriveSemanticEventIdentity(
      { ...fixtures.values.semanticEventCore, event_id: fixtures.ids.eventB },
      fixtures.values.semanticPayloadRecord
    ),
    /unexpected field/
  );
  await assert.rejects(
    deriveControlEventIdentity({
      ...fixtures.values.controlEventCore,
      control_id: fixtures.ids.controlEvent
    }),
    /unexpected field/
  );
  await assert.rejects(
    deriveProjectionSnapshotIdentity({
      ...fixtures.values.snapshotCore,
      snapshot_id: fixtures.ids.snapshot
    }),
    /unexpected field/
  );
});

check(() => {
  const raw = digestBytesFromId("projection-root", fixtures.ids.projectionRoot);
  assert.equal(formatDigestId("projection-root", raw), fixtures.ids.projectionRoot);
  assert.equal(raw.length, 32);
});

await checkAsync(async () => {
  const unsupportedNames = [
    "deriveAcceptedHistoryRootIdentity",
    "deriveConflictSetRootIdentity",
    "deriveProjectionRootIdentity",
    "deriveRevisionHeadsRootIdentity",
    "deriveSemanticStateRootIdentity",
    "deriveStateBlobIdentity"
  ];
  const collaboration = await import("../lib/collaboration/index.ts");
  for (const name of unsupportedNames) assert.equal(name in collaboration, false);
});

check(() => {
  assert.throws(() =>
    buildSignaturePreimage(
      "semantic_event",
      fixtures.ids.project,
      fixtures.ids.controlEvent
    )
  );
  assert.throws(() => parseDigestId("semantic-event", fixtures.ids.controlEvent), /namespace/);
  assert.throws(
    () => parseDigestId("semantic-event", `pm:semantic-event:v1:${"a".repeat(51)}b`),
    /namespace/
  );
});

check(() => {
  assert.equal(Object.isFrozen(collaborationHashDomains), true);
  assert.equal(Object.isFrozen(collaborationSignatureDomains), true);
  assert.equal(collaborationHashDomains.mergeKey, "patchmark/merge-key/v1");
});

check(() => {
  assert.throws(() => canonicalUint(-1n));
  assert.throws(() => canonicalUint(1n << 64n));
  assert.throws(() => canonicalUint(1));
  assert.throws(() => canonicalMap([["a", canonicalNull], ["a", canonicalNull]]));
  assert.throws(() => encodeCanonicalCbor(new Map()));
});

check(() => {
  const objectVector = vectors.objects.find((vector) => vector.name === "semantic_event");
  assert.ok(objectVector);
  const decoded = decodeCanonicalCbor(Buffer.from(objectVector.canonical_cbor_hex, "hex"));
  assert.equal(
    bytesToHex(encodeCanonicalCbor(decoded)),
    objectVector.canonical_cbor_hex
  );
});

assert.equal(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
assert.equal(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(2, 1)), false);

process.stdout.write(
  `${JSON.stringify(
    {
      runtime: process.version,
      immutableVectorFile: vectorUrl.pathname,
      vectors: vectorCounts,
      focusedDeterminismAndMalleabilityChecks: focusedChecks,
      expectedValuesRewritten: false
    },
    null,
    2
  )}\n`
);

function entity(kind, marker = "a") {
  return `pm:${kind}:v1:${"a".repeat(24)}${marker}a`;
}
