import {
  decodeCanonicalCbor,
  inspectCanonicalValue,
  type CanonicalValue
} from "./canonical-cbor.ts";
import {
  parseDocumentRevisionCore,
  type DocumentRevisionCore
} from "./content.ts";
import { collaborationHashDomains } from "./domains.ts";

export function decodeStoredRevisionCore(bytes: Uint8Array): DocumentRevisionCore {
  const envelope = expectArray(
    decodeCanonicalCbor(bytes),
    "stored revision preimage"
  );
  if (
    envelope.length !== 2 ||
    expectText(envelope[0], "stored revision domain") !==
      collaborationHashDomains.revisionCore
  ) {
    throw new Error("Stored revision has an unsupported canonical envelope.");
  }
  const core = expectMap(envelope[1], "stored revision core");
  const ancestryKind = expectTextField(core, "ancestry_kind");
  const commonKeys = [
    "schema_version",
    "object_kind",
    "ancestry_kind",
    "project_id",
    "document_id",
    "markdown_blob_id",
    "parent_revision_ids"
  ];
  const expectedKeys = ancestryKind === "admission_boundary"
    ? [
        ...commonKeys,
        "sealed_parent_history_root",
        "parent_traversal",
        "prior_plaintext"
      ]
    : commonKeys;
  expectExactKeys(core, expectedKeys);
  const base = {
    schema_version: expectVersion(core, "schema_version"),
    object_kind: expectTextField(core, "object_kind"),
    ancestry_kind: ancestryKind,
    project_id: expectTextField(core, "project_id"),
    document_id: expectTextField(core, "document_id"),
    markdown_blob_id: expectTextField(core, "markdown_blob_id"),
    parent_revision_ids: expectArray(
      requireField(core, "parent_revision_ids"),
      "stored revision parents"
    ).map((value) => expectText(value, "stored revision parent"))
  };
  if (ancestryKind !== "admission_boundary") {
    return parseDocumentRevisionCore(base);
  }
  return parseDocumentRevisionCore({
    ...base,
    sealed_parent_history_root: expectTextField(
      core,
      "sealed_parent_history_root"
    ),
    parent_traversal: expectTextField(core, "parent_traversal"),
    prior_plaintext: expectTextField(core, "prior_plaintext")
  });
}

function expectArray(value: CanonicalValue, label: string): readonly CanonicalValue[] {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "array") throw new Error(`${label} must be a canonical array.`);
  return view.values;
}

function expectMap(
  value: CanonicalValue,
  label: string
): ReadonlyMap<string, CanonicalValue> {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "map") throw new Error(`${label} must be a canonical map.`);
  return new Map(view.entries);
}

function expectText(value: CanonicalValue, label: string): string {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "text") throw new Error(`${label} must be canonical text.`);
  return view.value;
}

function expectTextField(
  map: ReadonlyMap<string, CanonicalValue>,
  key: string
): string {
  return expectText(requireField(map, key), key);
}

function expectVersion(
  map: ReadonlyMap<string, CanonicalValue>,
  key: string
): number {
  const view = inspectCanonicalValue(requireField(map, key));
  if (view.kind !== "uint" || view.value !== BigInt(1)) {
    throw new Error(`${key} must be canonical uint 1.`);
  }
  return 1;
}

function requireField(
  map: ReadonlyMap<string, CanonicalValue>,
  key: string
): CanonicalValue {
  const value = map.get(key);
  if (!value) throw new Error(`Stored revision is missing ${key}.`);
  return value;
}

function expectExactKeys(
  map: ReadonlyMap<string, CanonicalValue>,
  expected: readonly string[]
): void {
  if (map.size !== expected.length || expected.some((key) => !map.has(key))) {
    throw new Error("Stored revision contains an unexpected field set.");
  }
}
