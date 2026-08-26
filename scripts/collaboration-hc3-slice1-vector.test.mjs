import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createHc3Slice1VectorActual } from "./collaboration-hc3-slice1-vector-runtime.ts";

const path = new URL("./fixtures/collaboration-hc3-slice1-v1.json", import.meta.url);
const bytes = await readFile(path);
const fixture = JSON.parse(bytes);
const actual = await createHc3Slice1VectorActual(fixture);
assert.deepEqual(actual, fixture.expected, "Node HC-3 carrier vectors differ from frozen literal expectations");

process.stdout.write(`${JSON.stringify({
  fixture_sha256: createHash("sha256").update(bytes).digest("hex"),
  fixture_bytes: bytes.length,
  canonical_carriers: Object.keys(actual).length,
  artifact_text_characters: Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, value.text_characters])),
  node_equivalence: true,
  status: "ok"
}, null, 2)}\n`);
