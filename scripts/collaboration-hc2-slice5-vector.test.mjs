import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createHc2Slice5VectorActual } from "./collaboration-hc2-slice5-vector-runtime.ts";

const url = new URL("./fixtures/collaboration-hc2-slice5-v1.json", import.meta.url);
const bytes = await readFile(url); const fixture = JSON.parse(bytes);
assert.equal(fixture.fixture_version, 1);
assert.equal(fixture.fixture_domain, "patchmark/hc2/slice5-vectors/v1");
const actual = await createHc2Slice5VectorActual(fixture.inputs);
assert.deepEqual(actual, fixture.expected, "Slice 5 frozen protocol vectors changed");
assert.equal(actual.deliveries.length, 2);
assert.equal(new Set(actual.deliveries.map((entry) => entry.recipient_device_id)).size, 2);
assert.equal(actual.admission.full_history_verified, false);
assert.deepEqual(actual.revocation.recipient_device_ids, [actual.transition.recipient_device_ids[0]]);
assert.equal(fixture.expected.rejections.length, 12);
assert(!bytes.includes(Buffer.from(fixture.inputs.epoch2_secret_hex, "hex")), "fixture stores deterministic bytes as hex text, never raw binary payloads");
process.stdout.write(`${JSON.stringify({ fixture_bytes: bytes.length, fixture_sha256: createHash("sha256").update(bytes).digest("hex"), node_vector_equivalence: true, recipient_envelopes: 2 })}\n`);
