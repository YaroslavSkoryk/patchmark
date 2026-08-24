import { expectExactRecord, expectLiteral, freezeRecord } from "../validation.ts";
import { HC2_AUTHORITY_CLASSIFICATION_VERSION } from "./versions.ts";

export const hc2AuthorityClasses = [
  "portable_authoritative",
  "device_private_authoritative",
  "device_private_operational",
  "local_transactional",
  "rebuildable",
  "staging",
  "materialized_projection",
  "encrypted_recovery"
] as const;

export type Hc2AuthorityClass = (typeof hc2AuthorityClasses)[number];

export const hc2RecordKinds = [
  "acknowledgement", "active_document", "active_root_key_handle", "attestation", "batch_marker",
  "browser_directory_handle", "browser_file_handle", "cache_preferences", "capability_probe_observation", "checkpoint",
  "control_action", "control_event", "control_index", "credential_reference", "device_kek_handle",
  "device_pending_reservation_continuity", "device_private_key_handle", "device_recipient_key_handle", "device_sequence_continuity", "device_sequence_reservation",
  "device_signing_key_handle", "device_stream_generation", "device_stream_high_water", "diagnostic_state", "document_md",
  "document_revision", "editor_focus", "editor_selection", "editor_state", "external_recovery_kit",
  "key_vault_security_metadata", "local_alias", "local_batch_journal", "local_path", "local_path_binding",
  "markdown_blob", "materialization_status", "object_catalog", "object_commit_marker", "opfs_cache",
  "pending_batch", "permission_grant", "permission_observation", "persistence_observation", "person_private_key_handle",
  "private_review_override", "project_folder_binding", "projector_cache", "reading_bookmark", "recovery_recipient_epoch_envelope",
  "replica_metadata", "revision_index", "semantic_event", "semantic_index", "semantic_payload", "snapshot",
  "staging_object", "state_blob", "storage_estimate_observation", "transaction_intent", "ui_state",
  "unsaved_recovery_draft", "wrapped_local_epoch_secret", "writer_lock_state",
  "invitation_evidence", "invitation_handoff", "enrollment_request", "possession_proof",
  "membership_transition", "epoch_recipient_manifest", "epoch_delivery_set", "epoch_delivery_envelope",
  "current_state_admission_package", "epoch_delivery_receipt", "enrollment_batch_marker",
  "possession_challenge", "enrollment_transition_journal", "enrollment_completion_marker",
  "pending_enrollment_device_vault", "enrollment_admission_completion_marker"
] as const;

export type Hc2RecordKind = (typeof hc2RecordKinds)[number];

export const hc2AuthorityByRecordKind = Object.freeze({
  acknowledgement: "portable_authoritative",
  active_document: "device_private_operational",
  active_root_key_handle: "device_private_authoritative",
  attestation: "portable_authoritative",
  batch_marker: "portable_authoritative",
  browser_directory_handle: "device_private_operational",
  browser_file_handle: "device_private_operational",
  cache_preferences: "device_private_operational",
  capability_probe_observation: "device_private_operational",
  checkpoint: "portable_authoritative",
  control_action: "portable_authoritative",
  control_event: "portable_authoritative",
  control_index: "rebuildable",
  credential_reference: "device_private_operational",
  device_kek_handle: "device_private_authoritative",
  device_pending_reservation_continuity: "device_private_authoritative",
  device_private_key_handle: "device_private_authoritative",
  device_recipient_key_handle: "device_private_authoritative",
  device_sequence_continuity: "device_private_authoritative",
  device_sequence_reservation: "local_transactional",
  device_signing_key_handle: "device_private_authoritative",
  device_stream_generation: "device_private_authoritative",
  device_stream_high_water: "device_private_authoritative",
  diagnostic_state: "device_private_operational",
  document_md: "materialized_projection",
  document_revision: "portable_authoritative",
  editor_focus: "device_private_operational",
  editor_selection: "device_private_operational",
  editor_state: "device_private_operational",
  external_recovery_kit: "encrypted_recovery",
  key_vault_security_metadata: "device_private_authoritative",
  local_alias: "device_private_operational",
  local_batch_journal: "local_transactional",
  local_path: "device_private_operational",
  local_path_binding: "device_private_operational",
  markdown_blob: "portable_authoritative",
  materialization_status: "materialized_projection",
  object_catalog: "rebuildable",
  object_commit_marker: "portable_authoritative",
  opfs_cache: "rebuildable",
  pending_batch: "staging",
  permission_grant: "device_private_operational",
  permission_observation: "device_private_operational",
  persistence_observation: "device_private_operational",
  person_private_key_handle: "device_private_authoritative",
  private_review_override: "device_private_operational",
  project_folder_binding: "device_private_operational",
  projector_cache: "rebuildable",
  reading_bookmark: "device_private_operational",
  recovery_recipient_epoch_envelope: "portable_authoritative",
  replica_metadata: "portable_authoritative",
  revision_index: "rebuildable",
  semantic_event: "portable_authoritative",
  semantic_index: "rebuildable",
  semantic_payload: "portable_authoritative",
  snapshot: "portable_authoritative",
  staging_object: "staging",
  state_blob: "portable_authoritative",
  storage_estimate_observation: "device_private_operational",
  transaction_intent: "local_transactional",
  ui_state: "device_private_operational",
  unsaved_recovery_draft: "device_private_operational",
  wrapped_local_epoch_secret: "device_private_authoritative",
  writer_lock_state: "local_transactional",
  invitation_evidence: "portable_authoritative",
  invitation_handoff: "portable_authoritative",
  enrollment_request: "portable_authoritative",
  possession_proof: "portable_authoritative",
  membership_transition: "portable_authoritative",
  epoch_recipient_manifest: "portable_authoritative",
  epoch_delivery_set: "portable_authoritative",
  epoch_delivery_envelope: "portable_authoritative",
  current_state_admission_package: "portable_authoritative",
  epoch_delivery_receipt: "portable_authoritative",
  enrollment_batch_marker: "portable_authoritative",
  possession_challenge: "local_transactional",
  enrollment_transition_journal: "local_transactional",
  enrollment_completion_marker: "local_transactional",
  pending_enrollment_device_vault: "device_private_authoritative",
  enrollment_admission_completion_marker: "local_transactional"
} as const satisfies Readonly<Record<Hc2RecordKind, Hc2AuthorityClass>>);

export type Hc2ClassifiedRecord<TKind extends Hc2RecordKind = Hc2RecordKind> = Readonly<{
  classification_version: typeof HC2_AUTHORITY_CLASSIFICATION_VERSION;
  record_kind: TKind;
  authority: (typeof hc2AuthorityByRecordKind)[TKind];
}>;

export type Hc2RecordKindForClass<TClass extends Hc2AuthorityClass> = {
  [TKind in Hc2RecordKind]: (typeof hc2AuthorityByRecordKind)[TKind] extends TClass ? TKind : never
}[Hc2RecordKind];

export type Hc2PortableAuthoritativeRecordKind = Hc2RecordKindForClass<"portable_authoritative">;
export type Hc2DevicePrivateAuthoritativeRecordKind = Hc2RecordKindForClass<"device_private_authoritative">;
export type Hc2DevicePrivateOperationalRecordKind = Hc2RecordKindForClass<"device_private_operational">;

declare const devicePrivateAuthoritativeBrand: unique symbol;
declare const devicePrivateOperationalBrand: unique symbol;

export type Hc2DevicePrivateAuthoritativeState<
  TKind extends Hc2DevicePrivateAuthoritativeRecordKind = Hc2DevicePrivateAuthoritativeRecordKind
> = Hc2ClassifiedRecord<TKind> & { readonly [devicePrivateAuthoritativeBrand]: true };

export type Hc2DevicePrivateOperationalState<
  TKind extends Hc2DevicePrivateOperationalRecordKind = Hc2DevicePrivateOperationalRecordKind
> = Hc2ClassifiedRecord<TKind> & { readonly [devicePrivateOperationalBrand]: true };

export function classifyHc2Record<TKind extends Hc2RecordKind>(kind: TKind): Hc2ClassifiedRecord<TKind> {
  if (typeof kind !== "string" || !(kind in hc2AuthorityByRecordKind)) throw new Error("Unknown HC-2 record kind.");
  return freezeRecord({
    classification_version: HC2_AUTHORITY_CLASSIFICATION_VERSION,
    record_kind: kind,
    authority: hc2AuthorityByRecordKind[kind]
  });
}

export function parseHc2AuthorityClass(value: unknown): Hc2AuthorityClass {
  if (typeof value !== "string" || !(hc2AuthorityClasses as readonly string[]).includes(value)) {
    throw new Error("Unknown HC-2 authority classification.");
  }
  return value as Hc2AuthorityClass;
}

export function parseHc2DevicePrivateAuthoritativeState(value: unknown): Hc2DevicePrivateAuthoritativeState {
  return parseExactClassifiedState(value, "device_private_authoritative") as Hc2DevicePrivateAuthoritativeState;
}

export function parseHc2DevicePrivateOperationalState(value: unknown): Hc2DevicePrivateOperationalState {
  return parseExactClassifiedState(value, "device_private_operational") as Hc2DevicePrivateOperationalState;
}

export function assertPortableRecordKind(kind: Hc2PortableAuthoritativeRecordKind): void {
  if (classifyHc2Record(kind).authority !== "portable_authoritative") {
    throw new Error(`${kind} is not portable authoritative state.`);
  }
}

function parseExactClassifiedState<TClass extends "device_private_authoritative" | "device_private_operational">(
  value: unknown,
  expectedClass: TClass
): Hc2ClassifiedRecord<Hc2RecordKindForClass<TClass>> {
  const record = expectExactRecord(value, `${expectedClass} state classification`, [
    "classification_version", "record_kind", "authority"
  ]);
  const kind = record.record_kind;
  if (typeof kind !== "string" || !(kind in hc2AuthorityByRecordKind)) throw new Error("Unknown HC-2 record kind.");
  const classified = classifyHc2Record(kind as Hc2RecordKind);
  if (classified.authority !== expectedClass) throw new Error(`${kind} is not ${expectedClass} state.`);
  expectLiteral(record.authority, expectedClass, "authority classification");
  expectLiteral(record.classification_version, HC2_AUTHORITY_CLASSIFICATION_VERSION, "authority classification version");
  return classified as Hc2ClassifiedRecord<Hc2RecordKindForClass<TClass>>;
}
