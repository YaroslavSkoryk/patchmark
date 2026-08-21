import {
  parseAcknowledgementCore,
  parseAcknowledgementRecord,
  parseAttestationRecord,
  type AcknowledgementRecord,
  type AttestationRecord,
  type FirstSlice6AcknowledgementCore,
  type SubsequentSlice6AcknowledgementCore
} from "./checkpoints.ts";
import { digestBytesFromId } from "./digest-ids.ts";
import type {
  AttestationVerificationRequest,
  CollaborationAttestationVerifier,
  DeviceAuthorityFact
} from "./event-control-types.ts";
import type {
  AcknowledgementId,
  AttestationId,
  CheckpointId,
  ControlEventId,
  DeviceId,
  PersonId,
  ProjectId,
  ProjectionRootId,
} from "./identities.ts";
import { parseDigestId, parseEntityId } from "./identities.ts";
import {
  buildSignaturePreimage,
  deriveAcknowledgementIdentity,
  deriveAttestationIdentity
} from "./preimages.ts";
import type { LoadedProjectionHistory } from "./projection-causality.ts";
import { encodeCanonicalCbor } from "./canonical-cbor.ts";
import type { CollaborationReadResult } from "./storage.ts";
import {
  SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION
} from "./versions.ts";
import type { UInt64 } from "./validation.ts";

export type Slice6AcknowledgementCore =
  | FirstSlice6AcknowledgementCore
  | SubsequentSlice6AcknowledgementCore;

export type PreparedAcknowledgementDraft = Readonly<{
  preparation_version: 1;
  authority: "none";
  core: Slice6AcknowledgementCore;
  acknowledgement_id: AcknowledgementId;
  canonical_core_bytes: Uint8Array;
  signature_preimage: Uint8Array;
}>;

export type PrepareAcknowledgementInput = Readonly<{
  project_id: ProjectId;
  person_id: PersonId;
  device_id: DeviceId;
  observed_control_head_id: ControlEventId;
  acknowledged_checkpoint_id: CheckpointId;
  projection_root: ProjectionRootId;
  history: LoadedProjectionHistory;
  previous: AcknowledgementRecord | null;
  display_timestamp?: string;
}>;

export type AcknowledgementVerificationInput = Readonly<{
  project_id: ProjectId;
  record: AcknowledgementRecord;
  checkpoint_id: CheckpointId;
  projection_root: ProjectionRootId;
  control_head_id: ControlEventId;
  history: LoadedProjectionHistory;
  device_authorities: readonly DeviceAuthorityFact[];
  read_attestation: (
    id: AttestationId
  ) => Promise<CollaborationReadResult<AttestationRecord>>;
  attestation_verifier: CollaborationAttestationVerifier;
}>;

export type VerifiedAcknowledgement = Readonly<{
  status: "verified";
  record: AcknowledgementRecord & Readonly<{ core: Slice6AcknowledgementCore }>;
}>;

export type AcknowledgementVerificationResult =
  | VerifiedAcknowledgement
  | Readonly<{
      status: "invalid" | "incomplete_dependencies";
      reason: string;
    }>;

export type AcknowledgementForkRecord = Readonly<{
  schema_version: 1;
  object_kind: "acknowledgement_device_fork";
  authority: "none";
  project_id: ProjectId;
  device_id: DeviceId;
  acknowledgement_sequence: UInt64;
  previous_acknowledgement_id: AcknowledgementId | null;
  contender_acknowledgement_ids: readonly AcknowledgementId[];
}>;

export type AcknowledgementStreamReconstruction = Readonly<{
  schema_version: 1;
  object_kind: "acknowledgement_stream_reconstruction";
  authority: "none";
  verified_acknowledgement_ids: readonly AcknowledgementId[];
  invalid_acknowledgement_ids: readonly AcknowledgementId[];
  incomplete_acknowledgement_ids: readonly AcknowledgementId[];
  forks: readonly AcknowledgementForkRecord[];
  compaction_authorized: false;
}>;

export async function prepareAcknowledgementDraft(
  input: PrepareAcknowledgementInput
): Promise<PreparedAcknowledgementDraft> {
  const projectId = parseEntityId("project", input.project_id);
  const personId = parseEntityId("person", input.person_id);
  const deviceId = parseEntityId("device", input.device_id);
  const checkpointId = parseDigestId("semantic-event", input.acknowledged_checkpoint_id) as CheckpointId;
  const previous = input.previous === null
    ? null
    : parseAcknowledgementRecord(input.previous, input.previous.core.acknowledged_checkpoint_id);
  if (previous !== null && (
    previous.core.project_id !== projectId ||
    previous.core.device_id !== deviceId ||
    previous.core.schema_version !== SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION
  )) {
    throw new Error("Previous acknowledgement belongs to another chain.");
  }
  const common = {
    schema_version: SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION,
    object_kind: "acknowledgement_core" as const,
    project_id: projectId,
    person_id: personId,
    device_id: deviceId,
    observed_control_head_id: parseDigestId("control-event", input.observed_control_head_id),
    acknowledged_checkpoint_id: checkpointId,
    observed_semantic_frontier: Object.freeze([...input.history.accepted_frontier]),
    highest_contiguous_semantic_sequences: deriveHighestContiguousSemanticSequences(input.history),
    projection_root: parseDigestId("projection-root", input.projection_root),
    ...(input.display_timestamp === undefined ? {} : { display_timestamp: input.display_timestamp })
  };
  const core = parseAcknowledgementCore(
    previous === null
      ? {
          ...common,
          chain_position: "first",
          acknowledgement_sequence: BigInt(0),
          previous_acknowledgement_id: null
        }
      : {
          ...common,
          chain_position: "subsequent",
          acknowledgement_sequence: previous.core.acknowledgement_sequence + BigInt(1),
          previous_acknowledgement_id: previous.acknowledgement_id
        },
    checkpointId
  );
  if (core.schema_version !== SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION) {
    throw new Error("Prepared acknowledgement did not produce the Slice 6 core.");
  }
  const identity = await deriveAcknowledgementIdentity(core);
  return Object.freeze({
    preparation_version: 1,
    authority: "none" as const,
    core,
    acknowledgement_id: identity.id,
    canonical_core_bytes: Uint8Array.from(identity.canonical_bytes),
    signature_preimage: encodeCanonicalCbor(
      buildSignaturePreimage("acknowledgement", projectId, identity.id)
    )
  });
}

export function bindAcknowledgementAttestation(
  draft: PreparedAcknowledgementDraft,
  attestationId: AttestationId
): AcknowledgementRecord {
  return parseAcknowledgementRecord({
    record_version: 1,
    object_kind: "acknowledgement",
    acknowledgement_id: draft.acknowledgement_id,
    core: draft.core,
    attestation_id: attestationId
  }, draft.core.acknowledged_checkpoint_id);
}

export async function verifyAcknowledgement(
  input: AcknowledgementVerificationInput
): Promise<AcknowledgementVerificationResult> {
  try {
    const record = parseAcknowledgementRecord(input.record, input.checkpoint_id);
    if (record.core.schema_version !== SLICE6_ACKNOWLEDGEMENT_CORE_SCHEMA_VERSION) {
      throw new Error("Full Slice 6 verification requires acknowledgement core v2.");
    }
    const identity = await deriveAcknowledgementIdentity(record.core);
    if (identity.id !== record.acknowledgement_id) {
      throw new Error("Acknowledgement ID does not match its exact core.");
    }
    if (
      record.core.project_id !== input.project_id ||
      record.core.observed_control_head_id !== input.control_head_id ||
      record.core.acknowledged_checkpoint_id !== input.checkpoint_id ||
      record.core.projection_root !== input.projection_root
    ) {
      throw new Error("Acknowledgement checkpoint, projection, control, or project binding is wrong.");
    }
    const authority = input.device_authorities.find(
      (fact) => fact.device_id === record.core.device_id
    );
    if (
      !authority ||
      authority.status !== "active" ||
      authority.person_id !== record.core.person_id
    ) {
      throw new Error("Acknowledging device is not authorized at the referenced control head.");
    }
    if (!sameStrings(record.core.observed_semantic_frontier, input.history.accepted_frontier)) {
      throw new Error("Acknowledgement observed semantic frontier is incorrect.");
    }
    const expectedSequences = deriveHighestContiguousSemanticSequences(input.history);
    if (stableSequences(record.core.highest_contiguous_semantic_sequences) !== stableSequences(expectedSequences)) {
      throw new Error("Acknowledgement contiguous semantic sequence claims are incorrect.");
    }
    const attestationResult = await input.read_attestation(record.attestation_id);
    if (attestationResult.status !== "valid") {
      return Object.freeze({
        status: attestationResult.status === "missing" || attestationResult.status === "incomplete"
          ? "incomplete_dependencies" as const
          : "invalid" as const,
        reason: `Acknowledgement attestation is ${attestationResult.status}: ${attestationResult.reason}`
      });
    }
    const attestation = parseAttestationRecord(attestationResult.value);
    const attestationIdentity = await deriveAttestationIdentity(attestation.core);
    if (
      attestationIdentity.id !== record.attestation_id ||
      attestation.core.project_id !== input.project_id ||
      attestation.core.subject_kind !== "acknowledgement" ||
      attestation.core.subject_id !== record.acknowledgement_id ||
      attestation.core.signer_key_id !== authority.signing_key_id
    ) {
      throw new Error("Acknowledgement attestation subject or signer binding is invalid.");
    }
    const request: AttestationVerificationRequest = Object.freeze({
      schema_version: 1,
      project_id: input.project_id,
      subject_kind: "acknowledgement" as const,
      subject_id: record.acknowledgement_id,
      raw_subject_digest: digestBytesFromId("acknowledgement", record.acknowledgement_id),
      signature_preimage: encodeCanonicalCbor(
        buildSignaturePreimage("acknowledgement", input.project_id, record.acknowledgement_id)
      ),
      signer_key_id: authority.signing_key_id,
      algorithm: "ed25519" as const,
      signature_bytes: Uint8Array.from(attestation.core.signature_bytes),
      referenced_control_head_id: input.control_head_id,
      root_authority_context_id: null,
      expected_device_id: authority.device_id,
      expected_person_id: authority.person_id
    });
    const verification = await input.attestation_verifier.verify(copyRequest(request));
    if (verification.outcome === "unavailable") {
      return Object.freeze({ status: "incomplete_dependencies" as const, reason: verification.reason });
    }
    if (verification.outcome !== "verified" || !sameRequest(request, verification.binding)) {
      throw new Error(
        verification.outcome === "invalid"
          ? verification.reason
          : "Acknowledgement signature verification was not bound to the exact request."
      );
    }
    return Object.freeze({
      status: "verified" as const,
      record: record as AcknowledgementRecord & Readonly<{ core: Slice6AcknowledgementCore }>
    });
  } catch (error) {
    return Object.freeze({ status: "invalid" as const, reason: errorMessage(error) });
  }
}

export async function reconstructAcknowledgementStream(
  inputs: readonly AcknowledgementVerificationInput[]
): Promise<AcknowledgementStreamReconstruction> {
  const unique = new Map<AcknowledgementId, AcknowledgementVerificationInput>();
  for (const input of inputs) unique.set(input.record.acknowledgement_id, input);
  const verified: VerifiedAcknowledgement[] = [];
  const invalid: AcknowledgementId[] = [];
  const incomplete: AcknowledgementId[] = [];
  for (const input of unique.values()) {
    const result = await verifyAcknowledgement(input);
    if (result.status === "verified") verified.push(result);
    else if (result.status === "invalid") invalid.push(input.record.acknowledgement_id);
    else incomplete.push(input.record.acknowledgement_id);
  }
  const validById = new Map(verified.map((entry) => [entry.record.acknowledgement_id, entry.record]));
  for (const entry of verified) {
    const core = entry.record.core;
    if (core.chain_position === "first") continue;
    const previous = validById.get(core.previous_acknowledgement_id);
    if (
      !previous ||
      previous.core.device_id !== core.device_id ||
      previous.core.acknowledgement_sequence + BigInt(1) !== core.acknowledgement_sequence
    ) {
      invalid.push(entry.record.acknowledgement_id);
    }
  }
  const invalidSet = new Set(invalid);
  const accepted = verified
    .map((entry) => entry.record)
    .filter((record) => !invalidSet.has(record.acknowledgement_id));
  const groups = new Map<string, AcknowledgementRecord[]>();
  for (const record of accepted) {
    const key = `${record.core.device_id}\u0000${record.core.acknowledgement_sequence}\u0000${record.core.previous_acknowledgement_id ?? "first"}`;
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }
  const forks: AcknowledgementForkRecord[] = [];
  for (const records of groups.values()) {
    if (records.length < 2) continue;
    const first = records[0];
    forks.push(Object.freeze({
      schema_version: 1,
      object_kind: "acknowledgement_device_fork" as const,
      authority: "none" as const,
      project_id: first.core.project_id,
      device_id: first.core.device_id,
      acknowledgement_sequence: first.core.acknowledgement_sequence,
      previous_acknowledgement_id: first.core.previous_acknowledgement_id,
      contender_acknowledgement_ids: Object.freeze(
        records.map((record) => record.acknowledgement_id).sort()
      )
    }));
  }
  return Object.freeze({
    schema_version: 1,
    object_kind: "acknowledgement_stream_reconstruction" as const,
    authority: "none" as const,
    verified_acknowledgement_ids: Object.freeze(accepted.map((record) => record.acknowledgement_id).sort()),
    invalid_acknowledgement_ids: Object.freeze([...invalidSet].sort()),
    incomplete_acknowledgement_ids: Object.freeze([...new Set(incomplete)].sort()),
    forks: Object.freeze(forks.sort((left, right) => left.device_id < right.device_id ? -1 : 1)),
    compaction_authorized: false as const
  });
}

export function deriveHighestContiguousSemanticSequences(
  history: LoadedProjectionHistory
): Slice6AcknowledgementCore["highest_contiguous_semantic_sequences"] {
  const byDevice = new Map<DeviceId, bigint[]>();
  for (const loaded of history.events) {
    const values = byDevice.get(loaded.event.core.author_device_id) ?? [];
    values.push(loaded.event.core.device_sequence);
    byDevice.set(loaded.event.core.author_device_id, values);
  }
  return Object.freeze(
    [...byDevice.entries()]
      .sort(([left], [right]) => left < right ? -1 : 1)
      .map(([deviceId, sequences]) => {
        const sorted = [...new Set(sequences)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        for (let index = 0; index < sorted.length; index += 1) {
          if (sorted[index] !== BigInt(index)) {
            throw new Error(`Semantic sequence for ${deviceId} is not contiguous.`);
          }
        }
        return Object.freeze({
          device_id: deviceId,
          highest_contiguous_sequence: sorted[sorted.length - 1] as UInt64
        });
      })
  );
}

function copyRequest(request: AttestationVerificationRequest): AttestationVerificationRequest {
  return Object.freeze({
    ...request,
    raw_subject_digest: Uint8Array.from(request.raw_subject_digest),
    signature_preimage: Uint8Array.from(request.signature_preimage),
    signature_bytes: Uint8Array.from(request.signature_bytes)
  });
}

function sameRequest(left: AttestationVerificationRequest, right: AttestationVerificationRequest): boolean {
  return left.project_id === right.project_id &&
    left.subject_kind === right.subject_kind &&
    left.subject_id === right.subject_id &&
    left.signer_key_id === right.signer_key_id &&
    left.referenced_control_head_id === right.referenced_control_head_id &&
    left.expected_device_id === right.expected_device_id &&
    left.expected_person_id === right.expected_person_id &&
    equalBytes(left.raw_subject_digest, right.raw_subject_digest) &&
    equalBytes(left.signature_preimage, right.signature_preimage) &&
    equalBytes(left.signature_bytes, right.signature_bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableSequences(values: Slice6AcknowledgementCore["highest_contiguous_semantic_sequences"]): string {
  return values.map((entry) => `${entry.device_id}:${entry.highest_contiguous_sequence}`).join("|");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
