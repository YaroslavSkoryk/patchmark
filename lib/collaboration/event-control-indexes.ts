import {
  canonicalArray,
  canonicalBytes,
  canonicalMap,
  canonicalNull,
  canonicalText,
  canonicalUint,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  inspectCanonicalValue,
  type CanonicalValue
} from "./canonical-cbor.ts";
import type { DerivedControlForkRecord } from "./control.ts";
import { formatDigestId } from "./digest-ids.ts";
import type {
  AttestationIndexEntry,
  ControlEventClassification,
  EventControlProjectState,
  RootControlForkRecord,
  SemanticDeviceForkRecord,
  SemanticEventClassification,
  SemanticSequenceReservation
} from "./event-control-types.ts";
import {
  parseDigestId,
  parseEntityId,
  type ControlEventId,
  type DerivedConflictId,
  type ProjectId
} from "./identities.ts";
import { sha256 } from "./sha256.ts";
import {
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectUInt64,
  parseSortedUniqueArray
} from "./validation.ts";

const reservationDomain = "patchmark/semantic-sequence-reservation/v1";
const projectStateDomain = "patchmark/event-control-project-state-index/v1";
const controlForkDomain = "patchmark/derived-control-fork-index/v1";

export function encodeSemanticSequenceReservation(
  value: SemanticSequenceReservation
): Uint8Array {
  const reservation = parseSemanticSequenceReservation(value);
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(reservationDomain),
      canonicalMap([
        ["schema_version", canonicalUint(BigInt(reservation.schema_version))],
        ["object_kind", canonicalText(reservation.object_kind)],
        ["reservation_state", canonicalText(reservation.reservation_state)],
        ["project_id", canonicalText(reservation.project_id)],
        ["device_id", canonicalText(reservation.device_id)],
        ["device_sequence", canonicalUint(reservation.device_sequence)],
        [
          "previous_device_event_id",
          reservation.previous_device_event_id === null
            ? canonicalNull
            : canonicalText(reservation.previous_device_event_id)
        ],
        ["semantic_payload_id", canonicalText(reservation.semantic_payload_id)],
        [
          "causal_parent_event_ids",
          textArray(reservation.causal_parent_event_ids)
        ],
        [
          "authorizing_control_head_id",
          canonicalText(reservation.authorizing_control_head_id)
        ],
        ["key_epoch_id", canonicalText(reservation.key_epoch_id)],
        ["resulting_event_id", canonicalText(reservation.resulting_event_id)],
        ["event_record_bytes", canonicalBytes(reservation.event_record_bytes)],
        [
          "attestation_record_bytes",
          canonicalArray(
            reservation.attestation_record_bytes.map((bytes) => canonicalBytes(bytes))
          )
        ]
      ])
    ])
  );
}

export function decodeSemanticSequenceReservation(
  bytes: Uint8Array
): SemanticSequenceReservation {
  const root = inspectCanonicalValue(decodeCanonicalCbor(bytes));
  if (root.kind !== "array" || root.values.length !== 2) {
    throw new Error("Semantic sequence reservation has an invalid envelope.");
  }
  if (expectText(root.values[0], "reservation domain") !== reservationDomain) {
    throw new Error("Semantic sequence reservation has an incorrect domain.");
  }
  const record = canonicalMapRecord(root.values[1], "semantic sequence reservation");
  const parsed = parseSemanticSequenceReservation({
    schema_version: numberValue(record.schema_version, "reservation schema version"),
    object_kind: plainText(record.object_kind, "reservation object kind"),
    reservation_state: plainText(record.reservation_state, "reservation state"),
    project_id: plainText(record.project_id, "reservation project"),
    device_id: plainText(record.device_id, "reservation device"),
    device_sequence: uintValue(record.device_sequence, "reservation sequence"),
    previous_device_event_id: nullableText(
      record.previous_device_event_id,
      "reservation previous event"
    ),
    semantic_payload_id: plainText(record.semantic_payload_id, "reservation payload"),
    causal_parent_event_ids: textValues(
      record.causal_parent_event_ids,
      "reservation parents"
    ),
    authorizing_control_head_id: plainText(
      record.authorizing_control_head_id,
      "reservation control head"
    ),
    key_epoch_id: plainText(record.key_epoch_id, "reservation key epoch"),
    resulting_event_id: plainText(record.resulting_event_id, "reservation event"),
    event_record_bytes: byteValue(record.event_record_bytes, "reservation event bytes"),
    attestation_record_bytes: byteValues(
      record.attestation_record_bytes,
      "reservation attestation bytes"
    )
  });
  assertSameBytes(
    bytes,
    encodeSemanticSequenceReservation(parsed),
    "Semantic sequence reservation is not canonical."
  );
  return parsed;
}

export function parseSemanticSequenceReservation(
  value: unknown
): SemanticSequenceReservation {
  const record = expectExactRecord(value, "semantic sequence reservation", [
    "schema_version",
    "object_kind",
    "reservation_state",
    "project_id",
    "device_id",
    "device_sequence",
    "previous_device_event_id",
    "semantic_payload_id",
    "causal_parent_event_ids",
    "authorizing_control_head_id",
    "key_epoch_id",
    "resulting_event_id",
    "event_record_bytes",
    "attestation_record_bytes"
  ]);
  expectLiteral(record.schema_version, 1, "reservation schema version");
  expectLiteral(
    record.object_kind,
    "semantic_sequence_reservation",
    "reservation object kind"
  );
  const previous = record.previous_device_event_id === null
    ? null
    : parseDigestId("semantic-event", record.previous_device_event_id);
  if (!(record.event_record_bytes instanceof Uint8Array)) {
    throw new Error("Reservation event bytes must be a Uint8Array.");
  }
  if (!Array.isArray(record.attestation_record_bytes)) {
    throw new Error("Reservation attestation bytes must be an array.");
  }
  const attestations = record.attestation_record_bytes.map((candidate) => {
    if (!(candidate instanceof Uint8Array)) {
      throw new Error("Reservation attestation entries must be Uint8Array values.");
    }
    return Uint8Array.from(candidate);
  });
  if (attestations.length === 0) {
    throw new Error("A local sequence reservation requires an attestation.");
  }
  return Object.freeze({
    schema_version: 1 as const,
    object_kind: "semantic_sequence_reservation" as const,
    reservation_state: expectEnum(
      record.reservation_state,
      ["pending", "committed"] as const,
      "reservation state"
    ),
    project_id: parseEntityId("project", record.project_id),
    device_id: parseEntityId("device", record.device_id),
    device_sequence: expectUInt64(record.device_sequence, "reservation sequence"),
    previous_device_event_id: previous,
    semantic_payload_id: parseDigestId("semantic-payload", record.semantic_payload_id),
    causal_parent_event_ids: parseSortedUniqueArray(
      record.causal_parent_event_ids,
      "reservation causal parents",
      (candidate) => parseDigestId("semantic-event", candidate),
      { allowEmpty: true }
    ),
    authorizing_control_head_id: parseDigestId(
      "control-event",
      record.authorizing_control_head_id
    ),
    key_epoch_id: parseEntityId("key-epoch", record.key_epoch_id),
    resulting_event_id: parseDigestId("semantic-event", record.resulting_event_id),
    event_record_bytes: Uint8Array.from(record.event_record_bytes),
    attestation_record_bytes: Object.freeze(attestations)
  });
}

export function encodeEventControlProjectState(
  state: EventControlProjectState
): Uint8Array {
  return encodeCanonicalCbor(
    canonicalArray([
      canonicalText(projectStateDomain),
      canonicalMap([
        ["schema_version", canonicalUint(BigInt(state.schema_version))],
        ["object_kind", canonicalText(state.object_kind)],
        ["project_id", canonicalText(state.project_id)],
        [
          "semantic_classifications",
          canonicalArray(state.semantic_classifications.map(classificationValue))
        ],
        [
          "control_classifications",
          canonicalArray(state.control_classifications.map(classificationValue))
        ],
        ["accepted_semantic_event_ids", textArray(state.accepted_semantic_event_ids)],
        ["accepted_control_event_ids", textArray(state.accepted_control_event_ids)],
        ["accepted_semantic_frontier", textArray(state.accepted_semantic_frontier)],
        ["semantic_forks", canonicalArray(state.semantic_forks.map(semanticForkValue))],
        ["control_forks", canonicalArray(state.control_forks.map(controlForkValue))],
        ["root_forks", canonicalArray(state.root_forks.map(rootForkValue))],
        ["superseded_control_event_ids", textArray(state.superseded_control_event_ids)],
        ["attestation_index", canonicalArray(state.attestation_index.map(attestationIndexValue))],
        [
          "pending_reservation_event_ids",
          textArray(state.pending_reservations.map((entry) => entry.resulting_event_id).sort())
        ],
        ["invalid_object_ids", textArray(state.invalid_object_ids)]
      ])
    ])
  );
}

export function verifyEventControlProjectStateEncoding(
  bytes: Uint8Array,
  projectId: ProjectId
): void {
  const project = parseEntityId("project", projectId);
  const decoded = decodeCanonicalCbor(bytes);
  assertSameBytes(
    bytes,
    encodeCanonicalCbor(decoded),
    "Event/control project-state index is not canonical."
  );
  const root = inspectCanonicalValue(decoded);
  if (root.kind !== "array" || root.values.length !== 2) {
    throw new Error("Event/control project-state index has an invalid envelope.");
  }
  if (expectText(root.values[0], "project-state domain") !== projectStateDomain) {
    throw new Error("Event/control project-state index has an incorrect domain.");
  }
  const record = canonicalMapRecord(root.values[1], "event/control project-state index");
  if (numberValue(record.schema_version, "project-state schema version") !== 1) {
    throw new Error("Event/control project-state index has an unknown version.");
  }
  if (plainText(record.object_kind, "project-state object kind") !== "event_control_project_state") {
    throw new Error("Event/control project-state index has an incorrect object kind.");
  }
  if (plainText(record.project_id, "project-state project") !== project) {
    throw new Error("Event/control project-state index belongs to another project.");
  }
}

export async function deriveControlForkConflictId(
  projectId: ProjectId,
  previousControlId: ControlEventId,
  contenders: readonly ControlEventId[]
): Promise<DerivedConflictId> {
  const project = parseEntityId("project", projectId);
  const previous = parseDigestId("control-event", previousControlId);
  const tips = parseSortedUniqueArray(
    contenders,
    "control fork contenders",
    (candidate) => parseDigestId("control-event", candidate)
  );
  if (tips.length < 2) throw new Error("A control fork requires two contenders.");
  const bytes = encodeCanonicalCbor(
    canonicalArray([
      canonicalText(controlForkDomain),
      canonicalText(project),
      canonicalText(previous),
      textArray(tips)
    ])
  );
  return formatDigestId("derived-conflict", await sha256(bytes));
}

function classificationValue(
  value: SemanticEventClassification | ControlEventClassification
): CanonicalValue {
  return canonicalMap([
    ["schema_version", canonicalUint(BigInt(value.schema_version))],
    ["object_kind", canonicalText(value.object_kind)],
    ["project_id", canonicalText(value.project_id)],
    ["object_id", canonicalText(value.object_id)],
    ["disposition", canonicalText(value.disposition)],
    ["reason", canonicalText(value.reason)],
    ["detail", canonicalText(value.detail)]
  ]);
}

function semanticForkValue(value: SemanticDeviceForkRecord): CanonicalValue {
  return canonicalMap([
    ["schema_version", canonicalUint(BigInt(value.schema_version))],
    ["object_kind", canonicalText(value.object_kind)],
    ["authority", canonicalText(value.authority)],
    ["project_id", canonicalText(value.project_id)],
    ["device_id", canonicalText(value.device_id)],
    ["device_sequence", canonicalUint(value.device_sequence)],
    [
      "previous_device_event_id",
      value.previous_device_event_id === null
        ? canonicalNull
        : canonicalText(value.previous_device_event_id)
    ],
    ["contender_event_ids", textArray(value.contender_event_ids)]
  ]);
}

function controlForkValue(value: DerivedControlForkRecord): CanonicalValue {
  return canonicalMap([
    ["schema_version", canonicalUint(BigInt(value.schema_version))],
    ["object_kind", canonicalText(value.object_kind)],
    ["authority", canonicalText(value.authority)],
    ["quarantine_state", canonicalText(value.quarantine_state)],
    ["conflict_id", canonicalText(value.conflict_id)],
    ["project_id", canonicalText(value.project_id)],
    ["last_uncontested_control_id", canonicalText(value.last_uncontested_control_id)],
    ["conflicting_tip_ids", textArray(value.conflicting_tip_ids)]
  ]);
}

function rootForkValue(value: RootControlForkRecord): CanonicalValue {
  return canonicalMap([
    ["schema_version", canonicalUint(BigInt(value.schema_version))],
    ["object_kind", canonicalText(value.object_kind)],
    ["authority", canonicalText(value.authority)],
    ["project_id", canonicalText(value.project_id)],
    [
      "previous_root_control_id",
      value.previous_root_control_id === null
        ? canonicalNull
        : canonicalText(value.previous_root_control_id)
    ],
    ["root_sequence", canonicalUint(value.root_sequence)],
    ["contender_control_event_ids", textArray(value.contender_control_event_ids)]
  ]);
}

function attestationIndexValue(value: AttestationIndexEntry): CanonicalValue {
  return canonicalMap([
    ["subject_kind", canonicalText(value.subject_kind)],
    ["subject_id", canonicalText(value.subject_id)],
    ["attestation_ids", textArray(value.attestation_ids)]
  ]);
}

function textArray(values: readonly string[]): CanonicalValue {
  return canonicalArray(values.map((value) => canonicalText(value)));
}

function canonicalMapRecord(
  value: CanonicalValue,
  label: string
): Readonly<Record<string, CanonicalValue>> {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "map") throw new Error(`${label} must be a canonical map.`);
  const result: Record<string, CanonicalValue> = Object.create(null);
  for (const [key, child] of view.entries) result[key] = child;
  return result;
}

function expectText(value: CanonicalValue, label: string): string {
  const view = inspectCanonicalValue(value);
  if (view.kind !== "text") throw new Error(`${label} must be canonical text.`);
  return view.value;
}

function plainText(value: CanonicalValue | undefined, label: string): string {
  if (!value) throw new Error(`${label} is missing.`);
  return expectText(value, label);
}

function nullableText(value: CanonicalValue | undefined, label: string): string | null {
  if (!value) throw new Error(`${label} is missing.`);
  const view = inspectCanonicalValue(value);
  if (view.kind === "null") return null;
  if (view.kind !== "text") throw new Error(`${label} must be text or null.`);
  return view.value;
}

function uintValue(value: CanonicalValue | undefined, label: string): bigint {
  if (!value) throw new Error(`${label} is missing.`);
  const view = inspectCanonicalValue(value);
  if (view.kind !== "uint") throw new Error(`${label} must be an unsigned integer.`);
  return view.value;
}

function numberValue(value: CanonicalValue | undefined, label: string): number {
  const integer = uintValue(value, label);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer range.`);
  }
  return Number(integer);
}

function textValues(value: CanonicalValue | undefined, label: string): readonly string[] {
  if (!value) throw new Error(`${label} is missing.`);
  const view = inspectCanonicalValue(value);
  if (view.kind !== "array") throw new Error(`${label} must be an array.`);
  return view.values.map((candidate) => expectText(candidate, label));
}

function byteValue(value: CanonicalValue | undefined, label: string): Uint8Array {
  if (!value) throw new Error(`${label} is missing.`);
  const view = inspectCanonicalValue(value);
  if (view.kind !== "bytes") throw new Error(`${label} must be bytes.`);
  return Uint8Array.from(view.value);
}

function byteValues(value: CanonicalValue | undefined, label: string): readonly Uint8Array[] {
  if (!value) throw new Error(`${label} is missing.`);
  const view = inspectCanonicalValue(value);
  if (view.kind !== "array") throw new Error(`${label} must be an array.`);
  return view.values.map((candidate) => byteValue(candidate, label));
}

function assertSameBytes(actual: Uint8Array, expected: Uint8Array, message: string): void {
  if (
    actual.length !== expected.length ||
    actual.some((byte, index) => byte !== expected[index])
  ) {
    throw new Error(message);
  }
}
