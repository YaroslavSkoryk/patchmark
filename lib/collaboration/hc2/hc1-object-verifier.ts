import { parseAcknowledgementRecord, parseProjectionSnapshotRecord } from "../checkpoints.ts";
import { decodeStoredRevisionCore } from "../revision-storage-codec.ts";
import {
  decodeStoredAttestation,
  decodeStoredControlAction,
  decodeStoredControlEvent,
  decodeStoredSemanticEvent,
  decodeStoredSemanticPayload
} from "../event-storage-codec.ts";
import { parseEntityId, type CheckpointId, type ProjectId } from "../identities.ts";
import {
  deriveAcknowledgementIdentity,
  deriveDocumentRevisionIdentity,
  deriveMarkdownBlobIdentity,
  deriveProjectionSnapshotIdentity
} from "../preimages.ts";
import { deriveCanonicalStateBlobIdentity, parseCanonicalStateBlobRecord } from "../state-snapshots.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationObjectId,
  type CollaborationObjectIdByKind,
  type CollaborationObjectKind
} from "../storage.ts";
import { decodeProtocolRecord, type Hc2PortableObjectVerifier, type Hc2VerifiedPortableObject } from "./portable-folder.ts";

/** Real HC-1 canonical parser/identity adapter, bound to one expected project. */
export class Hc1CanonicalPortableObjectVerifier implements Hc2PortableObjectVerifier {
  readonly #project: ProjectId;

  constructor(expectedProjectId: ProjectId) {
    this.#project = parseEntityId("project", expectedProjectId);
  }

  async verifyExactObject<TKind extends CollaborationObjectKind>(input: Readonly<{
    object_kind: TKind;
    object_id: CollaborationObjectIdByKind[TKind];
    exact_bytes: Uint8Array;
  }>): Promise<Hc2VerifiedPortableObject<TKind>> {
    const kind = parseCollaborationObjectKind(input.object_kind) as TKind;
    const id = parseCollaborationObjectId(kind, input.object_id);
    const bytes = Uint8Array.from(input.exact_bytes);
    const decoded = await decodeAndDerive(kind, bytes, this.#project);
    if (decoded.id !== id || decoded.project_id !== this.#project) throw new Error("Stored HC-1 object does not match its portable identity or project.");
    return Object.freeze({
      object_kind: kind,
      object_id: id,
      project_id: this.#project,
      dependency_ids: Object.freeze(collectStoredDependencies(decoded.value, id))
    });
  }
}

async function decodeAndDerive(kind: CollaborationObjectKind, bytes: Uint8Array, project: ProjectId): Promise<Readonly<{
  id: CollaborationObjectId;
  project_id: ProjectId;
  value: unknown;
}>> {
  switch (kind) {
    case "markdown-blob": {
      const identity = await deriveMarkdownBlobIdentity(project, bytes);
      return Object.freeze({ id: identity.id, project_id: project, value: null });
    }
    case "document-revision": {
      const core = decodeStoredRevisionCore(bytes);
      const identity = await deriveDocumentRevisionIdentity(core);
      return Object.freeze({ id: identity.id, project_id: core.project_id, value: core });
    }
    case "semantic-payload": {
      const record = await decodeStoredSemanticPayload(bytes);
      return Object.freeze({ id: record.payload_id, project_id: record.core.project_id, value: record });
    }
    case "control-action": {
      const record = await decodeStoredControlAction(bytes);
      return Object.freeze({ id: record.action_id, project_id: record.core.project_id, value: record });
    }
    case "semantic-event": {
      const record = await decodeStoredSemanticEvent(bytes);
      return Object.freeze({ id: record.event_id, project_id: record.core.project_id, value: record });
    }
    case "control-event": {
      const record = await decodeStoredControlEvent(bytes);
      return Object.freeze({ id: record.control_event_id, project_id: record.core.project_id, value: record });
    }
    case "attestation": {
      const record = await decodeStoredAttestation(bytes);
      return Object.freeze({ id: record.attestation_id, project_id: record.core.project_id, value: record });
    }
    case "state-blob": {
      const record = parseCanonicalStateBlobRecord(decodeProtocolRecord(bytes));
      const identity = await deriveCanonicalStateBlobIdentity(record.core);
      return Object.freeze({ id: identity.id, project_id: record.core.project_id, value: record });
    }
    case "snapshot": {
      const plain = decodeProtocolRecord(bytes) as Readonly<{ core: Readonly<{ checkpoint_id: string }> }>;
      const record = parseProjectionSnapshotRecord(plain, parseCollaborationObjectId("semantic-event", plain.core.checkpoint_id) as CheckpointId);
      const identity = await deriveProjectionSnapshotIdentity(record.core);
      return Object.freeze({ id: identity.id, project_id: record.core.project_id, value: record });
    }
    case "acknowledgement": {
      const plain = decodeProtocolRecord(bytes) as Readonly<{ core: Readonly<{ acknowledged_checkpoint_id: string }> }>;
      const record = parseAcknowledgementRecord(plain, parseCollaborationObjectId("semantic-event", plain.core.acknowledged_checkpoint_id) as CheckpointId);
      const identity = await deriveAcknowledgementIdentity(record.core);
      return Object.freeze({ id: identity.id, project_id: record.core.project_id, value: record });
    }
  }
}

function collectStoredDependencies(value: unknown, ownId: CollaborationObjectId): CollaborationObjectId[] {
  const ids = new Set<CollaborationObjectId>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      const match = /^pm:(markdown-blob|document-revision|semantic-payload|control-action|semantic-event|control-event|attestation|state-blob|snapshot|acknowledgement):v1:/.exec(candidate);
      if (match && candidate !== ownId) {
        const kind = parseCollaborationObjectKind(match[1]);
        ids.add(parseCollaborationObjectId(kind, candidate));
      }
      return;
    }
    if (Array.isArray(candidate)) { for (const child of candidate) visit(child); return; }
    if (candidate && typeof candidate === "object" && !(candidate instanceof Uint8Array)) {
      for (const child of Object.values(candidate as Readonly<Record<string, unknown>>)) visit(child);
    }
  };
  visit(value);
  return [...ids].sort();
}
