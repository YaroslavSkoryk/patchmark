import {
  canonicalArray,
  canonicalNull,
  canonicalText,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue,
  type CanonicalValue
} from "./canonical-cbor.ts";
import {
  parseAttestationRecord,
  type AttestationRecord
} from "./checkpoints.ts";
import {
  parseControlActionRecord,
  parseControlEventRecordStructure,
  type ControlActionRecord,
  type ControlEventRecord
} from "./control.ts";
import { collaborationHashDomains } from "./domains.ts";
import {
  deriveAttestationIdentity,
  deriveControlActionIdentity,
  deriveControlEventCoreIdentity,
  deriveSemanticEventCoreIdentity,
  deriveSemanticPayloadIdentity,
  buildAttestationPreimage,
  buildControlActionPreimage,
  buildControlEventCorePreimage,
  buildSemanticEventCorePreimage,
  buildSemanticPayloadPreimage
} from "./preimages.ts";
import {
  parseSemanticEventRecordStructure,
  parseSemanticPayloadRecord,
  type SemanticEventRecord,
  type SemanticPayloadRecord
} from "./semantic.ts";

const storageDomains = Object.freeze({
  semanticPayload: "patchmark/stored-semantic-payload/v1",
  controlAction: "patchmark/stored-control-action/v1",
  semanticEvent: "patchmark/stored-semantic-event/v1",
  controlEvent: "patchmark/stored-control-event/v1",
  attestation: "patchmark/stored-attestation/v1"
});

export function encodeStoredSemanticPayload(
  value: SemanticPayloadRecord
): Uint8Array {
  const record = parseSemanticPayloadRecord(value);
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(storageDomains.semanticPayload),
      canonicalText(record.payload_id),
      buildSemanticPayloadPreimage(record.core)
    ])
  );
}

export async function decodeStoredSemanticPayload(
  bytes: Uint8Array
): Promise<SemanticPayloadRecord> {
  const values = decodeEnvelope(bytes, storageDomains.semanticPayload, 3);
  const id = expectText(values[1], "stored semantic payload ID");
  const core = decodeSeparatedCore(
    values[2],
    collaborationHashDomains.semanticPayload,
    "semantic payload"
  );
  const record = parseSemanticPayloadRecord({
    record_version: 1,
    object_kind: "semantic_payload",
    payload_id: id,
    core
  });
  const identity = await deriveSemanticPayloadIdentity(record.core);
  if (identity.id !== record.payload_id) {
    throw new Error("Stored semantic payload does not match its payload ID.");
  }
  assertExactEncoding(bytes, encodeStoredSemanticPayload(record), "semantic payload");
  return record;
}

export function encodeStoredControlAction(
  value: ControlActionRecord
): Uint8Array {
  const record = parseControlActionRecord(value);
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(storageDomains.controlAction),
      canonicalText(record.action_id),
      buildControlActionPreimage(record.core)
    ])
  );
}

export async function decodeStoredControlAction(
  bytes: Uint8Array
): Promise<ControlActionRecord> {
  const values = decodeEnvelope(bytes, storageDomains.controlAction, 3);
  const id = expectText(values[1], "stored control action ID");
  const core = decodeSeparatedCore(
    values[2],
    collaborationHashDomains.controlAction,
    "control action"
  );
  const record = parseControlActionRecord({
    record_version: 1,
    object_kind: "control_action",
    action_id: id,
    core
  });
  const identity = await deriveControlActionIdentity(record.core);
  if (identity.id !== record.action_id) {
    throw new Error("Stored control action does not match its action ID.");
  }
  assertExactEncoding(bytes, encodeStoredControlAction(record), "control action");
  return record;
}

export function encodeStoredSemanticEvent(
  value: SemanticEventRecord
): Uint8Array {
  const record = parseSemanticEventRecordStructure(value);
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(storageDomains.semanticEvent),
      canonicalText(record.event_id),
      buildSemanticEventCorePreimage(record.core),
      record.core.display_timestamp === undefined
        ? canonicalNull
        : canonicalText(record.core.display_timestamp),
      canonicalArray(
        record.author_attestation_ids.map((id) => canonicalText(id))
      )
    ])
  );
}

export async function decodeStoredSemanticEvent(
  bytes: Uint8Array
): Promise<SemanticEventRecord> {
  const values = decodeEnvelope(bytes, storageDomains.semanticEvent, 5);
  const id = expectText(values[1], "stored semantic event ID");
  const coreValue = decodeSeparatedCore(
    values[2],
    collaborationHashDomains.semanticEventCore,
    "semantic event"
  );
  const displayTimestamp = expectNullableText(
    values[3],
    "semantic event display timestamp"
  );
  const record = parseSemanticEventRecordStructure({
    record_version: 1,
    object_kind: "semantic_event",
    event_id: id,
    core: displayTimestamp === null
      ? coreValue
      : { ...coreValue, display_timestamp: displayTimestamp },
    author_attestation_ids: expectTextArray(
      values[4],
      "semantic event author attestations"
    )
  });
  const identity = await deriveSemanticEventCoreIdentity(record.core);
  if (identity.id !== record.event_id) {
    throw new Error("Stored semantic event does not match its event ID.");
  }
  assertExactEncoding(bytes, encodeStoredSemanticEvent(record), "semantic event");
  return record;
}

export function encodeStoredControlEvent(
  value: ControlEventRecord
): Uint8Array {
  const record = parseControlEventRecordStructure(value);
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(storageDomains.controlEvent),
      canonicalText(record.control_event_id),
      buildControlEventCorePreimage(record.core),
      record.core.display_timestamp === undefined
        ? canonicalNull
        : canonicalText(record.core.display_timestamp),
      canonicalText(record.authority_attestation_id)
    ])
  );
}

export async function decodeStoredControlEvent(
  bytes: Uint8Array
): Promise<ControlEventRecord> {
  const values = decodeEnvelope(bytes, storageDomains.controlEvent, 5);
  const id = expectText(values[1], "stored control event ID");
  const coreValue = decodeSeparatedCore(
    values[2],
    collaborationHashDomains.controlEventCore,
    "control event"
  );
  const displayTimestamp = expectNullableText(
    values[3],
    "control event display timestamp"
  );
  const record = parseControlEventRecordStructure({
    record_version: 1,
    object_kind: "control_event",
    control_event_id: id,
    core: displayTimestamp === null
      ? coreValue
      : { ...coreValue, display_timestamp: displayTimestamp },
    authority_attestation_id: expectText(
      values[4],
      "control event authority attestation ID"
    )
  });
  const identity = await deriveControlEventCoreIdentity(record.core);
  if (identity.id !== record.control_event_id) {
    throw new Error("Stored control event does not match its control-event ID.");
  }
  assertExactEncoding(bytes, encodeStoredControlEvent(record), "control event");
  return record;
}

export function encodeStoredAttestation(value: AttestationRecord): Uint8Array {
  const record = parseAttestationRecord(value);
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(storageDomains.attestation),
      canonicalText(record.attestation_id),
      buildAttestationPreimage(record.core)
    ])
  );
}

export async function decodeStoredAttestation(
  bytes: Uint8Array
): Promise<AttestationRecord> {
  const values = decodeEnvelope(bytes, storageDomains.attestation, 3);
  const id = expectText(values[1], "stored attestation ID");
  const core = decodeSeparatedCore(
    values[2],
    collaborationHashDomains.attestationRecord,
    "attestation"
  );
  const record = parseAttestationRecord({
    record_version: 1,
    object_kind: "attestation",
    attestation_id: id,
    core
  });
  const identity = await deriveAttestationIdentity(record.core);
  if (identity.id !== record.attestation_id) {
    throw new Error("Stored attestation does not match its attestation ID.");
  }
  assertExactEncoding(bytes, encodeStoredAttestation(record), "attestation");
  return copyAttestation(record);
}

function decodeEnvelope(
  bytes: Uint8Array,
  expectedDomain: string,
  expectedLength: number
): readonly CanonicalValue[] {
  const view = inspectCanonicalValue(decodeCanonicalCbor(bytes));
  if (view.kind !== "array" || view.values.length !== expectedLength) {
    throw new Error(`${expectedDomain} has an invalid storage envelope.`);
  }
  if (expectText(view.values[0], "storage domain") !== expectedDomain) {
    throw new Error(`${expectedDomain} has an incorrect storage domain.`);
  }
  return view.values;
}

function decodeSeparatedCore(
  value: CanonicalValue,
  expectedDomain: string,
  label: string
): Readonly<Record<string, unknown>> {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "array" || view.values.length !== 2) {
    throw new Error(`Stored ${label} preimage has an invalid envelope.`);
  }
  if (expectText(view.values[0], `${label} hash domain`) !== expectedDomain) {
    throw new Error(`Stored ${label} uses an incorrect hash domain.`);
  }
  const plain = canonicalToPlain(view.values[1]);
  if (typeof plain !== "object" || plain === null || Array.isArray(plain)) {
    throw new Error(`Stored ${label} core must be a canonical map.`);
  }
  return plain as Readonly<Record<string, unknown>>;
}

function canonicalToPlain(value: CanonicalValue, key?: string): unknown {
  const view = inspectCanonicalValue(value);
  switch (view.kind) {
    case "null":
      return null;
    case "boolean":
    case "text":
      return view.value;
    case "bytes":
      return Uint8Array.from(view.value);
    case "uint":
      return key === "schema_version" ? Number(view.value) : view.value;
    case "array":
      return view.values.map((child) => canonicalToPlain(child));
    case "map": {
      const result: Record<string, unknown> = Object.create(null);
      for (const [entryKey, child] of view.entries) {
        result[entryKey] = canonicalToPlain(child, entryKey);
      }
      return result;
    }
  }
}

function expectText(value: CanonicalValue, label: string): string {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "text") throw new Error(`${label} must be canonical text.`);
  return view.value;
}

function expectNullableText(value: CanonicalValue, label: string): string | null {
  const view = inspectCanonicalValue(value);
  if (view.kind === "null") return null;
  if (view.kind !== "text") throw new Error(`${label} must be text or null.`);
  return view.value;
}

function expectTextArray(value: CanonicalValue, label: string): readonly string[] {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "array") throw new Error(`${label} must be an array.`);
  return view.values.map((child) => expectText(child, label));
}

function assertExactEncoding(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((byte, index) => byte !== expected[index])
  ) {
    throw new Error(`Stored ${label} is not in exact canonical form.`);
  }
}

function copyAttestation(value: AttestationRecord): AttestationRecord {
  return Object.freeze({
    ...value,
    core: Object.freeze({
      ...value.core,
      signature_bytes: Uint8Array.from(value.core.signature_bytes)
    })
  });
}
