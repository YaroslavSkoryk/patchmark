import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createSlice7VectorActual } from "./collaboration-hc2-slice7-vector-runtime.ts";

const fixtureUrl = new URL("./fixtures/collaboration-hc2-slice7-v3.json", import.meta.url);
const fixtureBytes = await readFile(fixtureUrl);
const fixture = JSON.parse(fixtureBytes);
const actual = await createSlice7VectorActual(fixture.inputs);
assert.deepEqual(actual, fixture.expected, "Node synchronization V3 bytes differ from the frozen independent fixture");
assert.equal(fixture.fixture_version, 3);
assert.ok(fixtureBytes.length < 2 * 1024 * 1024, "V3 fixture must remain compact");
assert.deepEqual(new Set(fixture.expected.authority_values), new Set(["none"]));
assert.equal(fixture.expected.public_header_keys.some((key) => /project|person|membership|control|epoch|purpose|session|inventory|request|stream/.test(key)), false);
assert.equal(new Set(fixture.expected.encapsulated_key_hex).size, fixture.expected.encapsulated_key_hex.length, "each V3 container uses a fresh HPKE context");
process.stdout.write(`${JSON.stringify({
  fixture_bytes: fixtureBytes.length,
  fixture_sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  node_v3_vector_equivalence: true,
  containers: actual.container_ids.length,
  bundle_bytes: actual.bundle_canonical_length
}, null, 2)}\n`);
