import {
  canonicalArray,
  canonicalBoolean,
  canonicalBytes,
  canonicalMap,
  canonicalNull,
  canonicalText,
  canonicalUint,
  encodeCanonicalCbor,
  type CanonicalMap,
  type CanonicalValue
} from "./canonical-cbor.ts";
import {
  parseDocumentRevisionCore,
  type DocumentRevisionCore
} from "./content.ts";
import {
  parseControlActionCore,
  parseControlEventCore,
  parseControlEventCoreStructure,
  type ControlActionCore,
  type ControlEventCore,
  type DeviceSequenceCutoff,
  type InitialAuthorizedDevice,
  type InitialMembership,
  type OrdinaryControlValidationContext
} from "./control.ts";
import {
  parseAcknowledgementCore,
  parseAttestationCore,
  parseProjectionSnapshotCore,
  type AcknowledgementCore,
  type AttestationCore,
  type BoundaryRevisionEntry,
  type CheckpointResolutionOperation,
  type ProjectionSnapshotCore
} from "./checkpoints.ts";
import {
  parseDerivedConflictCore,
  parseMergeKeyCore,
  type DerivedConflictCore,
  type MergeAuthorization,
  type MergeKeyCore
} from "./derived.ts";
import {
  parseSemanticEventCore,
  parseSemanticEventCoreStructure,
  parseSemanticPayloadCore,
  type SemanticEventCore,
  type SemanticPayloadCore,
  type SemanticPayloadRecord
} from "./semantic.ts";
import { collaborationHashDomains, collaborationSignatureDomains } from "./domains.ts";
import { canonicalProtocolValue } from "./canonical-protocol.ts";
import { digestBytesFromId, formatDigestId } from "./digest-ids.ts";
import {
  parseEntityId,
  type AcknowledgementId,
  type AttestationId,
  type ControlActionId,
  type ControlEventId,
  type DerivedConflictId,
  type DigestIdByKind,
  type DigestIdKind,
  type DocumentRevisionId,
  type MarkdownBlobId,
  type MergeKeyId,
  type ProjectId,
  type SemanticEventId,
  type SemanticPayloadId,
  type SnapshotId
} from "./identities.ts";
import { sha256, type Sha256Digest, type Sha256Provider } from "./sha256.ts";

export type DerivedCollaborationIdentity<TId extends string> = Readonly<{
  canonical_bytes: Uint8Array;
  digest: Sha256Digest;
  id: TId;
}>;

export type SignatureSubjectIdByKind = {
  semantic_event: SemanticEventId;
  control_event: ControlEventId;
  snapshot: SnapshotId;
  acknowledgement: AcknowledgementId;
};

export function buildMarkdownBlobPreimage(
  projectId: ProjectId,
  exactRawUtf8Bytes: Uint8Array
): CanonicalValue {
  const parsedProjectId = parseEntityId("project", projectId);
  assertWellFormedUtf8(exactRawUtf8Bytes, "Markdown bytes");
  return canonicalArray([
    canonicalText(collaborationHashDomains.markdownBlob),
    canonicalText(parsedProjectId),
    canonicalBytes(exactRawUtf8Bytes)
  ]);
}

export function buildSemanticPayloadPreimage(
  value: SemanticPayloadCore
): CanonicalValue {
  const core = parseSemanticPayloadCore(value);
  return separated(
    collaborationHashDomains.semanticPayload,
    canonicalMap([
      ["schema_version", uint(core.schema_version)],
      ["project_id", text(core.project_id)],
      ["semantic_kind", text(core.semantic_kind)],
      ["data", semanticPayloadData(core)]
    ])
  );
}

export function buildControlActionPreimage(
  value: ControlActionCore
): CanonicalValue {
  const core = parseControlActionCore(value);
  return separated(
    collaborationHashDomains.controlAction,
    controlActionMap(core)
  );
}

export function buildDocumentRevisionPreimage(
  value: DocumentRevisionCore
): CanonicalValue {
  const core = parseDocumentRevisionCore(value);
  const entries: Array<readonly [string, CanonicalValue]> = [
    ["schema_version", uint(core.schema_version)],
    ["object_kind", text(core.object_kind)],
    ["ancestry_kind", text(core.ancestry_kind)],
    ["project_id", text(core.project_id)],
    ["document_id", text(core.document_id)],
    ["markdown_blob_id", text(core.markdown_blob_id)],
    ["parent_revision_ids", textArray(core.parent_revision_ids)]
  ];
  if (core.ancestry_kind === "admission_boundary") {
    entries.push(
      ["sealed_parent_history_root", text(core.sealed_parent_history_root)],
      ["parent_traversal", text(core.parent_traversal)],
      ["prior_plaintext", text(core.prior_plaintext)]
    );
  }
  return separated(collaborationHashDomains.revisionCore, canonicalMap(entries));
}

export function buildSemanticEventPreimage(
  value: SemanticEventCore,
  payload: SemanticPayloadRecord
): CanonicalValue {
  const core = parseSemanticEventCore(value, payload);
  return semanticEventCorePreimage(core);
}

export function buildSemanticEventCorePreimage(
  value: SemanticEventCore
): CanonicalValue {
  return semanticEventCorePreimage(parseSemanticEventCoreStructure(value));
}

function semanticEventCorePreimage(core: SemanticEventCore): CanonicalValue {
  return separated(
    collaborationHashDomains.semanticEventCore,
    canonicalMap([
      ["schema_version", uint(core.schema_version)],
      ["object_kind", text(core.object_kind)],
      ["device_chain_position", text(core.device_chain_position)],
      ["project_id", text(core.project_id)],
      ["semantic_kind", text(core.semantic_kind)],
      ["author_device_id", text(core.author_device_id)],
      ["device_sequence", canonicalUint(core.device_sequence)],
      [
        "previous_device_event_id",
        core.previous_device_event_id === null
          ? canonicalNull
          : text(core.previous_device_event_id)
      ],
      ["causal_parent_event_ids", textArray(core.causal_parent_event_ids)],
      ["authorizing_control_head_id", text(core.authorizing_control_head_id)],
      ["key_epoch_id", text(core.key_epoch_id)],
      ["semantic_payload_id", text(core.semantic_payload_id)],
      ["complete_known_frontier", canonicalBoolean(core.complete_known_frontier)]
    ])
  );
}

export function buildControlEventPreimage(
  value: ControlEventCore,
  options: {
    action?: import("./control.ts").ControlActionRecord;
    ordinary_context?: OrdinaryControlValidationContext;
  } = {}
): CanonicalValue {
  const core = parseControlEventCore(value, options);
  return controlEventCorePreimage(core);
}

export function buildControlEventCorePreimage(
  value: ControlEventCore
): CanonicalValue {
  return controlEventCorePreimage(parseControlEventCoreStructure(value));
}

function controlEventCorePreimage(core: ControlEventCore): CanonicalValue {
  return separated(
    collaborationHashDomains.controlEventCore,
    controlEventMap(core)
  );
}

export function buildMergeKeyPreimage(value: MergeKeyCore): CanonicalValue {
  const core = parseMergeKeyCore(value);
  return separated(
    collaborationHashDomains.mergeKey,
    canonicalMap([
      ["schema_version", uint(core.schema_version)],
      ["object_kind", text(core.object_kind)],
      ["project_id", text(core.project_id)],
      ["document_id", text(core.document_id)],
      ["parent_revision_ids", textArray(core.parent_revision_ids)],
      [
        "base_revision_id",
        core.base_revision_id === null ? canonicalNull : text(core.base_revision_id)
      ],
      ["result_revision_id", text(core.result_revision_id)],
      ["merge_algorithm_id", text(core.merge_algorithm_id)],
      ["merge_algorithm_version", text(core.merge_algorithm_version)]
    ])
  );
}

export function buildProjectionSnapshotPreimage(
  value: ProjectionSnapshotCore
): CanonicalValue {
  const core = parseProjectionSnapshotCore(value, value.checkpoint_id);
  return separated(
    collaborationHashDomains.snapshotCore,
    canonicalMap([
      ["schema_version", uint(core.schema_version)],
      ["object_kind", text(core.object_kind)],
      ["project_id", text(core.project_id)],
      ["checkpoint_id", text(core.checkpoint_id)],
      ["reducer_version", text(core.reducer_version)],
      ["state_blob_id", text(core.state_blob_id)],
      ["semantic_state_root", text(core.semantic_state_root)],
      ["revision_heads_root", text(core.revision_heads_root)],
      ["conflict_set_root", text(core.conflict_set_root)],
      ["projection_root", text(core.projection_root)],
      ["boundary_revisions", boundaryRevisions(core.boundary_revisions)],
      ["live_conflict_dependencies", textArray(core.live_conflict_dependencies)]
    ])
  );
}

export function buildAcknowledgementPreimage(
  value: AcknowledgementCore
): CanonicalValue {
  const core = parseAcknowledgementCore(value, value.acknowledged_checkpoint_id);
  return separated(
    collaborationHashDomains.acknowledgementCore,
    canonicalMap([
      ["schema_version", uint(core.schema_version)],
      ["object_kind", text(core.object_kind)],
      ["chain_position", text(core.chain_position)],
      ["project_id", text(core.project_id)],
      ...(core.schema_version === 2
        ? [["person_id", text(core.person_id)] as const]
        : []),
      ["device_id", text(core.device_id)],
      ["acknowledgement_sequence", canonicalUint(core.acknowledgement_sequence)],
      [
        "previous_acknowledgement_id",
        core.previous_acknowledgement_id === null
          ? canonicalNull
          : text(core.previous_acknowledgement_id)
      ],
      ["observed_control_head_id", text(core.observed_control_head_id)],
      ["acknowledged_checkpoint_id", text(core.acknowledged_checkpoint_id)],
      ["observed_semantic_frontier", textArray(core.observed_semantic_frontier)],
      ...(core.schema_version === 2
        ? [[
            "highest_contiguous_semantic_sequences",
            canonicalArray(core.highest_contiguous_semantic_sequences.map((entry) =>
              canonicalMap([
                ["device_id", text(entry.device_id)],
                ["highest_contiguous_sequence", canonicalUint(entry.highest_contiguous_sequence)]
              ])
            ))
          ] as const]
        : []),
      ["projection_root", text(core.projection_root)]
    ])
  );
}

export function buildAttestationPreimage(value: AttestationCore): CanonicalValue {
  const core = parseAttestationCore(value);
  return separated(
    collaborationHashDomains.attestationRecord,
    canonicalMap([
      ["schema_version", uint(core.schema_version)],
      ["object_kind", text(core.object_kind)],
      ["project_id", text(core.project_id)],
      ["subject_kind", text(core.subject_kind)],
      ["subject_id", text(core.subject_id)],
      ["signer_key_id", text(core.signer_key_id)],
      ["algorithm", text(core.algorithm)],
      ["signature_bytes", canonicalBytes(core.signature_bytes)]
    ])
  );
}

export function buildDerivedConflictPreimage(
  value: DerivedConflictCore
): CanonicalValue {
  const core = parseDerivedConflictCore(value);
  return separated(
    collaborationHashDomains.derivedConflict,
    derivedConflictMap(core)
  );
}

export function buildSignaturePreimage<
  TKind extends keyof SignatureSubjectIdByKind
>(
  subjectKind: TKind,
  projectId: ProjectId,
  subjectId: SignatureSubjectIdByKind[TKind]
): CanonicalValue {
  const parsedProjectId = parseEntityId("project", projectId);
  const digest = signatureSubjectDigest(subjectKind, subjectId);
  return canonicalArray([
    canonicalText(collaborationSignatureDomains[subjectKind]),
    canonicalText(parsedProjectId),
    canonicalBytes(digest)
  ]);
}

export async function deriveMarkdownBlobIdentity(
  projectId: ProjectId,
  exactRawUtf8Bytes: Uint8Array,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<MarkdownBlobId>> {
  return derive("markdown-blob", buildMarkdownBlobPreimage(projectId, exactRawUtf8Bytes), provider);
}

export async function deriveSemanticPayloadIdentity(
  core: SemanticPayloadCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<SemanticPayloadId>> {
  return derive("semantic-payload", buildSemanticPayloadPreimage(core), provider);
}

export async function deriveControlActionIdentity(
  core: ControlActionCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<ControlActionId>> {
  return derive("control-action", buildControlActionPreimage(core), provider);
}

export async function deriveDocumentRevisionIdentity(
  core: DocumentRevisionCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<DocumentRevisionId>> {
  return derive("document-revision", buildDocumentRevisionPreimage(core), provider);
}

export async function deriveSemanticEventIdentity(
  core: SemanticEventCore,
  payload: SemanticPayloadRecord,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<SemanticEventId>> {
  return derive("semantic-event", buildSemanticEventPreimage(core, payload), provider);
}

export async function deriveSemanticEventCoreIdentity(
  core: SemanticEventCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<SemanticEventId>> {
  return derive("semantic-event", buildSemanticEventCorePreimage(core), provider);
}

export async function deriveControlEventIdentity(
  core: ControlEventCore,
  options: {
    action?: import("./control.ts").ControlActionRecord;
    ordinary_context?: OrdinaryControlValidationContext;
  } = {},
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<ControlEventId>> {
  return derive("control-event", buildControlEventPreimage(core, options), provider);
}

export async function deriveControlEventCoreIdentity(
  core: ControlEventCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<ControlEventId>> {
  return derive("control-event", buildControlEventCorePreimage(core), provider);
}

export async function deriveMergeKeyIdentity(
  core: MergeKeyCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<MergeKeyId>> {
  return derive("merge-key", buildMergeKeyPreimage(core), provider);
}

export async function deriveProjectionSnapshotIdentity(
  core: ProjectionSnapshotCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<SnapshotId>> {
  return derive("snapshot", buildProjectionSnapshotPreimage(core), provider);
}

export async function deriveAcknowledgementIdentity(
  core: AcknowledgementCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<AcknowledgementId>> {
  return derive("acknowledgement", buildAcknowledgementPreimage(core), provider);
}

export async function deriveAttestationIdentity(
  core: AttestationCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<AttestationId>> {
  return derive("attestation", buildAttestationPreimage(core), provider);
}

export async function deriveDerivedConflictIdentity(
  core: DerivedConflictCore,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<DerivedConflictId>> {
  return derive("derived-conflict", buildDerivedConflictPreimage(core), provider);
}

function semanticPayloadData(core: SemanticPayloadCore): CanonicalMap {
  switch (core.semantic_kind) {
    case "project_genesis":
      return canonicalMap([
        ["genesis_revision_ids", textArray(core.data.genesis_revision_ids)]
      ]);
    case "collaboration_bootstrap_import":
      return canonicalProtocolValue(core.data) as CanonicalMap;
    case "revision_adoption":
      return canonicalMap([
        ["document_id", text(core.data.document_id)],
        ["revision_id", text(core.data.revision_id)]
      ]);
    case "merge_revision_adoption":
      return canonicalMap([
        ["document_id", text(core.data.document_id)],
        ["revision_id", text(core.data.revision_id)],
        ["authorization", mergeAuthorizationMap(core.data.authorization)]
      ]);
    case "external_revision_import":
      return canonicalMap([
        ["document_id", text(core.data.document_id)],
        ["revision_id", text(core.data.revision_id)],
        ["imported_blob_id", text(core.data.imported_blob_id)]
      ]);
    case "comment_operation": {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["operation", text(core.data.operation)],
        ["document_id", text(core.data.document_id)],
        ["comment_id", text(core.data.comment_id)]
      ];
      if (core.data.operation === "create" || core.data.operation === "edit") {
        entries.push(["content", text(core.data.content)]);
      }
      if (
        (core.data.operation === "create" ||
          core.data.operation === "reanchor") &&
        core.data.anchor !== undefined
      ) {
        entries.push([
          "anchor",
          canonicalMap([
            ["anchor_kind", text(core.data.anchor.anchor_kind)],
            ["anchor_key", text(core.data.anchor.anchor_key)]
          ])
        ]);
      }
      return canonicalMap(entries);
    }
    case "reply_operation": {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["operation", text(core.data.operation)],
        ["document_id", text(core.data.document_id)],
        ["comment_id", text(core.data.comment_id)],
        ["reply_id", text(core.data.reply_id)]
      ];
      if (core.data.operation === "create" || core.data.operation === "edit") {
        entries.push(["content", text(core.data.content)]);
        if (core.data.review_batch_id !== undefined) {
          entries.push(
            ["review_batch_id", text(core.data.review_batch_id)],
            ["response_import_id", text(core.data.response_import_id!)]
          );
        }
      }
      return canonicalMap(entries);
    }
    case "patch_operation": {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["operation", text(core.data.operation)],
        ["document_id", text(core.data.document_id)],
        ["patch_id", text(core.data.patch_id)],
        ["patch_version_id", text(core.data.patch_version_id)]
      ];
      if (core.data.operation === "decide") {
        entries.push(["decision", text(core.data.decision)]);
      } else {
        if (core.data.revision_id !== undefined) {
          entries.push(["revision_id", text(core.data.revision_id)]);
        }
        if (core.data.dependency_patch_version_ids !== undefined) {
          entries.push([
            "dependency_patch_version_ids",
            textArray(core.data.dependency_patch_version_ids)
          ]);
        }
        if (core.data.target_provenance !== undefined) {
          entries.push(["target_provenance", text(core.data.target_provenance)]);
        }
        if (core.data.review_batch_id !== undefined) {
          entries.push(
            ["review_batch_id", text(core.data.review_batch_id)],
            ["response_import_id", text(core.data.response_import_id!)]
          );
        }
      }
      return canonicalMap(entries);
    }
    case "metadata_operation": {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["operation", text(core.data.operation)]
      ];
      if ("document_id" in core.data) {
        entries.push(["document_id", text(core.data.document_id)]);
      }
      if ("group_id" in core.data) {
        entries.push(["group_id", text(core.data.group_id)]);
      }
      if ("target_document_id" in core.data) {
        entries.push(["target_document_id", text(core.data.target_document_id)]);
      }
      if ("value" in core.data) entries.push(["value", text(core.data.value)]);
      return canonicalMap(entries);
    }
    case "review_batch_operation": {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["operation", text(core.data.operation)],
        ["review_batch_id", text(core.data.review_batch_id)]
      ];
      if (core.data.operation === "respond") {
        entries.push(
          [
            "response_evidence_commitment",
            text(core.data.response_evidence_commitment)
          ],
          ["response_import_id", text(core.data.response_import_id)],
          [
            "contribution_payload_ids",
            textArray(core.data.contribution_payload_ids)
          ]
        );
      }
      return canonicalMap(entries);
    }
    case "rewrite_operation": {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["operation", text(core.data.operation)],
        ["document_id", text(core.data.document_id)],
        ["rewrite_session_id", text(core.data.rewrite_session_id)]
      ];
      if (core.data.operation === "apply") {
        entries.push(["revision_id", text(core.data.revision_id)]);
      }
      return canonicalMap(entries);
    }
    case "conflict_resolution": {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["conflict_id", text(core.data.conflict_id)],
        [
          "adopted_revision_id",
          core.data.adopted_revision_id === null
            ? canonicalNull
            : text(core.data.adopted_revision_id)
        ]
      ];
      if (core.data.observed_contender_event_ids !== undefined) {
        entries.push([
          "observed_contender_event_ids",
          textArray(core.data.observed_contender_event_ids)
        ]);
      }
      if (core.data.adopted_event_id !== undefined) {
        entries.push([
          "adopted_event_id",
          core.data.adopted_event_id === null
            ? canonicalNull
            : text(core.data.adopted_event_id)
        ]);
      }
      return canonicalMap(entries);
    }
    case "consolidation_checkpoint":
      return canonicalMap([
        ["base_frontier_event_ids", textArray(core.data.base_frontier_event_ids)],
        ["base_frontier_root", text(core.data.base_frontier_root)],
        ["accepted_history_root", text(core.data.accepted_history_root)],
        ["resolution_operations", resolutionOperations(core.data.resolution_operations)],
        ["result_semantic_state_root", text(core.data.result_semantic_state_root)],
        ["result_revision_heads_root", text(core.data.result_revision_heads_root)],
        ["result_conflict_set_root", text(core.data.result_conflict_set_root)],
        ["projection_root", text(core.data.projection_root)],
        ["reducer_version", text(core.data.reducer_version)],
        ["authorizing_control_head_id", text(core.data.authorizing_control_head_id)]
      ]);
  }
}

function controlActionMap(core: ControlActionCore): CanonicalMap {
  const entries: Array<readonly [string, CanonicalValue]> = [
    ["schema_version", uint(core.schema_version)],
    ["project_id", text(core.project_id)],
    ["action_kind", text(core.action_kind)]
  ];
  switch (core.action_kind) {
    case "membership_grant":
      entries.push(
        ["membership_id", text(core.membership_id)],
        ["person_id", text(core.person_id)],
        ["role", text(core.role)],
        ["access_scope_id", text(core.access_scope_id)]
      );
      break;
    case "membership_role_change":
      entries.push(
        ["membership_id", text(core.membership_id)],
        ["person_id", text(core.person_id)],
        ["next_role", text(core.next_role)]
      );
      break;
    case "membership_revocation":
      entries.push(
        ["membership_id", text(core.membership_id)],
        ["person_id", text(core.person_id)],
        ["revocation_cutoffs", deviceSequenceCutoffs(core.revocation_cutoffs)]
      );
      break;
    case "device_authorization":
      entries.push(
        ["person_id", text(core.person_id)],
        ["device_id", text(core.device_id)],
        ["signing_key_id", text(core.signing_key_id)]
      );
      break;
    case "device_revocation":
      entries.push(
        ["person_id", text(core.person_id)],
        ["device_id", text(core.device_id)],
        ["semantic_sequence_cutoff", canonicalUint(core.semantic_sequence_cutoff)]
      );
      break;
    case "active_control_device_transfer":
      entries.push(
        ["previous_active_control_device_id", text(core.previous_active_control_device_id)],
        ["replacement_active_control_device_id", text(core.replacement_active_control_device_id)]
      );
      break;
    case "key_epoch_transition":
      entries.push(
        ["previous_key_epoch_id", text(core.previous_key_epoch_id)],
        ["replacement_key_epoch_id", text(core.replacement_key_epoch_id)],
        ["replacement_key_epoch_commitment", text(core.replacement_key_epoch_commitment)],
        ["reason", text(core.reason)]
      );
      break;
    case "root_recovery":
      entries.push(
        ["last_uncontested_control_id", text(core.last_uncontested_control_id)],
        ["selected_membership_device_state_root", text(core.selected_membership_device_state_root)],
        ["revocation_sequence_cutoffs", deviceSequenceCutoffs(core.revocation_sequence_cutoffs)],
        ["replacement_active_control_device_id", text(core.replacement_active_control_device_id)],
        ["replacement_key_epoch_id", text(core.replacement_key_epoch_id)],
        ["replacement_key_epoch_commitment", text(core.replacement_key_epoch_commitment)],
        ["observed_conflicting_tip_ids", textArray(core.observed_conflicting_tip_ids)],
        ["supersession_policy", text(core.supersession_policy)]
      );
      break;
  }
  return canonicalMap(entries);
}

function controlEventMap(core: ControlEventCore): CanonicalMap {
  const entries: Array<readonly [string, CanonicalValue]> = [
    ["schema_version", uint(core.schema_version)],
    ["object_kind", text(core.object_kind)],
    ["control_kind", text(core.control_kind)],
    ["project_id", text(core.project_id)],
    ["control_sequence", canonicalUint(core.control_sequence)],
    [
      "previous_control_id",
      core.previous_control_id === null ? canonicalNull : text(core.previous_control_id)
    ],
    ["resulting_control_state_root", text(core.resulting_control_state_root)]
  ];
  if (core.control_kind === "genesis") {
    entries.push(
      ["root_sequence", canonicalUint(core.root_sequence)],
      ["previous_root_control_id", canonicalNull],
      ["owner_person_id", text(core.owner_person_id)],
      ["offline_root_key_id", text(core.offline_root_key_id)],
      ["initial_active_control_device_id", text(core.initial_active_control_device_id)],
      ["initial_memberships", initialMemberships(core.initial_memberships)],
      ["initial_authorized_devices", initialDevices(core.initial_authorized_devices)],
      ["initial_key_epoch_id", text(core.initial_key_epoch_id)],
      ["initial_key_epoch_commitment", text(core.initial_key_epoch_commitment)]
    );
  } else if (core.control_kind === "ordinary") {
    entries.push(
      ["issuer_device_id", text(core.issuer_device_id)],
      ["action_id", text(core.action_id)],
      ["key_epoch_id", text(core.key_epoch_id)],
      ["key_epoch_commitment", text(core.key_epoch_commitment)]
    );
  } else {
    entries.push(
      ["root_sequence", canonicalUint(core.root_sequence)],
      ["previous_root_control_id", text(core.previous_root_control_id)],
      ["issuer_root_key_id", text(core.issuer_root_key_id)],
      ["action_id", text(core.action_id)],
      ["key_epoch_id", text(core.key_epoch_id)],
      ["key_epoch_commitment", text(core.key_epoch_commitment)]
    );
  }
  return canonicalMap(entries);
}

function derivedConflictMap(core: DerivedConflictCore): CanonicalMap {
  const entries: Array<readonly [string, CanonicalValue]> = [
    ["schema_version", uint(core.schema_version)],
    ["conflict_kind", text(core.conflict_kind)],
    ["authority", text(core.authority)],
    ["project_id", text(core.project_id)]
  ];
  if (core.conflict_kind === "content") {
    entries.push(
      ["document_id", text(core.document_id)],
      ["contender_revision_ids", textArray(core.contender_revision_ids)],
      [
        "base_revision_id",
        core.base_revision_id === null ? canonicalNull : text(core.base_revision_id)
      ]
    );
  } else if (core.conflict_kind === "metadata") {
    entries.push(
      ["subject_kind", text(core.subject_kind)],
      ["subject_id", text(core.subject_id)],
      ["field", text(core.field)],
      ["contender_payload_ids", textArray(core.contender_payload_ids)]
    );
  } else if (core.conflict_kind === "tombstone") {
    entries.push(
      ["subject_kind", text(core.subject_kind)],
      ["subject_id", text(core.subject_id)],
      ["tombstone_event_id", text(core.tombstone_event_id)],
      ["contender_event_ids", textArray(core.contender_event_ids)]
    );
  } else {
    entries.push(
      ["reducer_version", text(core.reducer_version)],
      ["reducer_conflict_kind", text(core.reducer_conflict_kind)],
      ["subject_kind", text(core.subject_kind)],
      ["subject_id", text(core.subject_id)],
      ["field", text(core.field)],
      [
        "base_value_commitment",
        core.base_value_commitment === null
          ? canonicalNull
          : text(core.base_value_commitment)
      ],
      ["contender_event_ids", textArray(core.contender_event_ids)],
      [
        "contender_value_commitments",
        textArray(core.contender_value_commitments)
      ],
      ["context_event_ids", textArray(core.context_event_ids)]
    );
  }
  return canonicalMap(entries);
}

function mergeAuthorizationMap(value: MergeAuthorization): CanonicalMap {
  const entries: Array<readonly [string, CanonicalValue]> = [
    ["schema_version", uint(value.schema_version)],
    ["object_kind", text(value.object_kind)],
    ["authorization_mode", text(value.authorization_mode)],
    ["merge_key_id", text(value.merge_key_id)]
  ];
  if (value.authorization_mode === "explicit_editor") {
    entries.push(
      ["authorizing_device_id", text(value.authorizing_device_id)],
      ["authorizing_role", text(value.authorizing_role)]
    );
  } else {
    entries.push(
      ["eligible_device_id", text(value.eligible_device_id)],
      ["eligible_role", text(value.eligible_role)],
      ["policy_control_head_id", text(value.policy_control_head_id)],
      ["required_outcome", text(value.required_outcome)]
    );
  }
  return canonicalMap(entries);
}

function resolutionOperations(
  operations: readonly CheckpointResolutionOperation[]
): CanonicalValue {
  return canonicalArray(
    operations.map((operation) => {
      const entries: Array<readonly [string, CanonicalValue]> = [
        ["operation_kind", text(operation.operation_kind)],
        ["conflict_id", text(operation.conflict_id)],
        ["observed_contender_event_ids", textArray(operation.observed_contender_event_ids)]
      ];
      if (operation.operation_kind === "resolve_content_conflict") {
        entries.push(["adopted_revision_id", text(operation.adopted_revision_id)]);
      } else if (operation.operation_kind === "resolve_metadata_conflict") {
        entries.push(["chosen_payload_id", text(operation.chosen_payload_id)]);
      } else {
        entries.push(["resolution", text(operation.resolution)]);
      }
      return canonicalMap(entries);
    })
  );
}

function boundaryRevisions(
  revisions: readonly BoundaryRevisionEntry[]
): CanonicalValue {
  return canonicalArray(
    revisions.map((revision) =>
      canonicalMap([
        ["document_id", text(revision.document_id)],
        ["revision_id", text(revision.revision_id)],
        ["traversal", text(revision.traversal)]
      ])
    )
  );
}

function deviceSequenceCutoffs(
  cutoffs: readonly DeviceSequenceCutoff[]
): CanonicalValue {
  return canonicalArray(
    cutoffs.map((cutoff) =>
      canonicalMap([
        ["device_id", text(cutoff.device_id)],
        ["maximum_accepted_semantic_sequence", canonicalUint(cutoff.maximum_accepted_semantic_sequence)]
      ])
    )
  );
}

function initialMemberships(values: readonly InitialMembership[]): CanonicalValue {
  return canonicalArray(
    values.map((value) =>
      canonicalMap([
        ["membership_id", text(value.membership_id)],
        ["person_id", text(value.person_id)],
        ["role", text(value.role)],
        ["access_scope_id", text(value.access_scope_id)],
        ["status", text(value.status)]
      ])
    )
  );
}

function initialDevices(values: readonly InitialAuthorizedDevice[]): CanonicalValue {
  return canonicalArray(
    values.map((value) =>
      canonicalMap([
        ["device_id", text(value.device_id)],
        ["person_id", text(value.person_id)],
        ["signing_key_id", text(value.signing_key_id)],
        ["status", text(value.status)]
      ])
    )
  );
}

function signatureSubjectDigest<TKind extends keyof SignatureSubjectIdByKind>(
  kind: TKind,
  id: SignatureSubjectIdByKind[TKind]
): Sha256Digest {
  switch (kind) {
    case "semantic_event":
      return digestBytesFromId("semantic-event", id);
    case "control_event":
      return digestBytesFromId("control-event", id);
    case "snapshot":
      return digestBytesFromId("snapshot", id);
    case "acknowledgement":
      return digestBytesFromId("acknowledgement", id);
  }
}

async function derive<TKind extends DigestIdKind>(
  kind: TKind,
  preimage: CanonicalValue,
  provider?: Sha256Provider
): Promise<DerivedCollaborationIdentity<DigestIdByKind[TKind]>> {
  const canonicalBytes = encodeCanonicalCbor(preimage);
  const digest = provider
    ? await sha256(canonicalBytes, provider)
    : await sha256(canonicalBytes);
  return Object.freeze({
    canonical_bytes: Uint8Array.from(canonicalBytes),
    digest: Uint8Array.from(digest) as Sha256Digest,
    id: formatDigestId(kind, digest)
  });
}

function separated(domain: string, value: CanonicalValue): CanonicalValue {
  return canonicalArray([canonicalText(domain), value]);
}

function text(value: string): CanonicalValue {
  return canonicalText(value);
}

function uint(value: number): CanonicalValue {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Protocol schema versions must be nonnegative safe integers.");
  }
  return canonicalUint(BigInt(value));
}

function textArray(values: readonly string[]): CanonicalValue {
  return canonicalArray(values.map((value) => text(value)));
}

function assertWellFormedUtf8(bytes: Uint8Array, label: string): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${label} must be a Uint8Array.`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must contain well-formed UTF-8.`);
  }
}
