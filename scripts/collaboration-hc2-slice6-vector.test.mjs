import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createSlice6VectorActual } from "./collaboration-hc2-slice6-vector-runtime.ts";

const fixtureUrl = new URL("./fixtures/collaboration-hc2-slice6-v2.json", import.meta.url);
const fixtureBytes = await readFile(fixtureUrl);
const fixture = JSON.parse(fixtureBytes);
const actual = await createSlice6VectorActual(fixture.inputs);
assert.deepEqual(actual, fixture.expected, "Node transport v2 bytes differ from the frozen independent fixture");
assert.equal(fixture.fixture_version, 2);
assert.equal(fixture.expected.public_header_keys.some((key) => /project|person|membership|control|epoch|purpose|stream/.test(key)), false);
assert.equal(new Set(fixture.expected.encapsulated_key_hex).size, fixture.expected.encapsulated_key_hex.length, "each vector container uses a fresh HPKE ephemeral key");
process.stdout.write(`${JSON.stringify({
  fixture_bytes: fixtureBytes.length,
  fixture_sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  node_vector_equivalence: true,
  containers: actual.container_ids.length,
  bundle_bytes: actual.bundle_canonical_length
}, null, 2)}\n`);
