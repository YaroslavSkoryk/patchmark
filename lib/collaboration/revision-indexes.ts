import {
  canonicalArray,
  canonicalMap,
  canonicalText,
  canonicalUint,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue,
  type CanonicalValue
} from "./canonical-cbor.ts";
import {
  parseDigestId,
  parseEntityId,
  type DocumentId,
  type DocumentRevisionId,
  type ProjectId,
  type SemanticEventId
} from "./identities.ts";
import {
  expectArray,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  freezeRecord
} from "./validation.ts";

export const revisionReferenceKinds = [
  "adopted",
  "authored",
  "authorized_merge"
] as const;

export type RevisionReferenceKind = (typeof revisionReferenceKinds)[number];

export type RevisionReference = Readonly<{
  schema_version: 1;
  reference_kind: RevisionReferenceKind;
  project_id: ProjectId;
  document_id: DocumentId;
  revision_id: DocumentRevisionId;
  event_id: SemanticEventId;
}>;

export type RevisionReferenceIndex = Readonly<{
  schema_version: 1;
  object_kind: "revision_reference_index";
  project_id: ProjectId;
  document_id: DocumentId;
  revision_id: DocumentRevisionId;
  references: readonly RevisionReference[];
}>;

const indexDomain = "patchmark/revision-reference-index/v1";

export function parseRevisionReference(value: unknown): RevisionReference {
  const record = expectExactRecord(value, "revision reference", [
    "schema_version",
    "reference_kind",
    "project_id",
    "document_id",
    "revision_id",
    "event_id"
  ]);
  expectLiteral(record.schema_version, 1, "revision reference schema version");
  return freezeRecord({
    schema_version: 1,
    reference_kind: expectEnum(
      record.reference_kind,
      revisionReferenceKinds,
      "revision reference kind"
    ),
    project_id: parseEntityId("project", record.project_id),
    document_id: parseEntityId("document", record.document_id),
    revision_id: parseDigestId("document-revision", record.revision_id),
    event_id: parseDigestId("semantic-event", record.event_id)
  });
}

export function parseRevisionReferenceIndex(
  value: unknown
): RevisionReferenceIndex {
  const record = expectExactRecord(value, "revision reference index", [
    "schema_version",
    "object_kind",
    "project_id",
    "document_id",
    "revision_id",
    "references"
  ]);
  expectLiteral(record.schema_version, 1, "revision reference index version");
  expectLiteral(
    record.object_kind,
    "revision_reference_index",
    "revision reference index kind"
  );
  const projectId = parseEntityId("project", record.project_id);
  const documentId = parseEntityId("document", record.document_id);
  const revisionId = parseDigestId("document-revision", record.revision_id);
  const references = expectArray(record.references, "revision references").map(
    parseRevisionReference
  );
  let previous = "";
  for (const reference of references) {
    if (
      reference.project_id !== projectId ||
      reference.document_id !== documentId ||
      reference.revision_id !== revisionId
    ) {
      throw new Error("Revision references must match their index ownership.");
    }
    const key = revisionReferenceSortKey(reference);
    if (key <= previous) {
      throw new Error("Revision references must be strictly sorted and unique.");
    }
    previous = key;
  }
  return freezeRecord({
    schema_version: 1,
    object_kind: "revision_reference_index" as const,
    project_id: projectId,
    document_id: documentId,
    revision_id: revisionId,
    references: Object.freeze(references)
  });
}

export function buildRevisionReferenceIndex(
  projectId: ProjectId,
  documentId: DocumentId,
  revisionId: DocumentRevisionId,
  references: readonly RevisionReference[]
): RevisionReferenceIndex {
  const parsedProjectId = parseEntityId("project", projectId);
  const parsedDocumentId = parseEntityId("document", documentId);
  const parsedRevisionId = parseDigestId("document-revision", revisionId);
  const parsed = references.map(parseRevisionReference);
  parsed.sort((left, right) => {
    const leftKey = revisionReferenceSortKey(left);
    const rightKey = revisionReferenceSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (let index = 1; index < parsed.length; index += 1) {
    if (revisionReferenceSortKey(parsed[index - 1]) === revisionReferenceSortKey(parsed[index])) {
      throw new Error("Revision reference rebuild input contains a duplicate.");
    }
  }
  return parseRevisionReferenceIndex({
    schema_version: 1,
    object_kind: "revision_reference_index",
    project_id: parsedProjectId,
    document_id: parsedDocumentId,
    revision_id: parsedRevisionId,
    references: parsed
  });
}

export function encodeRevisionReferenceIndex(
  value: RevisionReferenceIndex
): Uint8Array {
  const index = parseRevisionReferenceIndex(value);
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(indexDomain),
      canonicalMap([
        ["schema_version", canonicalUint(BigInt(1))],
        ["object_kind", canonicalText(index.object_kind)],
        ["project_id", canonicalText(index.project_id)],
        ["document_id", canonicalText(index.document_id)],
        ["revision_id", canonicalText(index.revision_id)],
        [
          "references",
          canonicalArray(
            index.references.map((reference) =>
              canonicalMap([
                ["schema_version", canonicalUint(BigInt(1))],
                ["reference_kind", canonicalText(reference.reference_kind)],
                ["project_id", canonicalText(reference.project_id)],
                ["document_id", canonicalText(reference.document_id)],
                ["revision_id", canonicalText(reference.revision_id)],
                ["event_id", canonicalText(reference.event_id)]
              ])
            )
          )
        ]
      ])
    ])
  );
}

export function decodeRevisionReferenceIndex(
  bytes: Uint8Array
): RevisionReferenceIndex {
  const root = expectCanonicalArray(decodeCanonicalCbor(bytes), "revision index envelope");
  if (root.length !== 2 || expectCanonicalText(root[0], "revision index domain") !== indexDomain) {
    throw new Error("Stored revision index has an unsupported domain or envelope.");
  }
  const index = expectCanonicalMap(root[1], "revision index");
  expectExactCanonicalKeys(index, [
    "schema_version",
    "object_kind",
    "project_id",
    "document_id",
    "revision_id",
    "references"
  ]);
  const references = expectCanonicalArray(
    requireCanonicalField(index, "references"),
    "revision reference array"
  ).map((value) => {
    const reference = expectCanonicalMap(value, "revision reference");
    expectExactCanonicalKeys(reference, [
      "schema_version",
      "reference_kind",
      "project_id",
      "document_id",
      "revision_id",
      "event_id"
    ]);
    return {
      schema_version: expectCanonicalVersion(reference, "schema_version"),
      reference_kind: expectCanonicalText(
        requireCanonicalField(reference, "reference_kind"),
        "revision reference kind"
      ),
      project_id: expectCanonicalText(
        requireCanonicalField(reference, "project_id"),
        "revision reference project"
      ),
      document_id: expectCanonicalText(
        requireCanonicalField(reference, "document_id"),
        "revision reference document"
      ),
      revision_id: expectCanonicalText(
        requireCanonicalField(reference, "revision_id"),
        "revision reference revision"
      ),
      event_id: expectCanonicalText(
        requireCanonicalField(reference, "event_id"),
        "revision reference event"
      )
    };
  });
  return parseRevisionReferenceIndex({
    schema_version: expectCanonicalVersion(index, "schema_version"),
    object_kind: expectCanonicalText(
      requireCanonicalField(index, "object_kind"),
      "revision index kind"
    ),
    project_id: expectCanonicalText(
      requireCanonicalField(index, "project_id"),
      "revision index project"
    ),
    document_id: expectCanonicalText(
      requireCanonicalField(index, "document_id"),
      "revision index document"
    ),
    revision_id: expectCanonicalText(
      requireCanonicalField(index, "revision_id"),
      "revision index revision"
    ),
    references
  });
}

export function revisionReferenceSortKey(reference: RevisionReference): string {
  return `${reference.reference_kind}\u0000${reference.event_id}`;
}

function expectCanonicalArray(value: CanonicalValue, label: string): readonly CanonicalValue[] {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "array") throw new Error(`${label} must be a canonical array.`);
  return view.values;
}

function expectCanonicalMap(
  value: CanonicalValue,
  label: string
): ReadonlyMap<string, CanonicalValue> {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "map") throw new Error(`${label} must be a canonical map.`);
  return new Map(view.entries);
}

function expectCanonicalText(value: CanonicalValue, label: string): string {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "text") throw new Error(`${label} must be canonical text.`);
  return view.value;
}

function expectCanonicalVersion(
  map: ReadonlyMap<string, CanonicalValue>,
  key: string
): number {
  const view = inspectCanonicalValue(requireCanonicalField(map, key));
  if (view.kind !== "uint" || view.value !== BigInt(1)) {
    throw new Error(`${key} must be canonical uint 1.`);
  }
  return 1;
}

function requireCanonicalField(
  map: ReadonlyMap<string, CanonicalValue>,
  key: string
): CanonicalValue {
  const value = map.get(key);
  if (!value) throw new Error(`Canonical record is missing ${key}.`);
  return value;
}

function expectExactCanonicalKeys(
  map: ReadonlyMap<string, CanonicalValue>,
  expected: readonly string[]
): void {
  if (map.size !== expected.length || expected.some((key) => !map.has(key))) {
    throw new Error("Canonical record contains an unexpected field set.");
  }
}
