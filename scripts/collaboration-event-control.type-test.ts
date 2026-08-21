import type {
  AttestationId,
  CollaborationAttestationVerifier,
  CollaborationControlTransitionVerifier,
  ControlActionId,
  ControlEventId,
  DocumentRevisionId,
  LegacyIdentityAlias,
  MarkdownBlobId,
  MergeKeyId,
  SemanticEventId,
  SemanticPayloadId
} from "../lib/collaboration/index.ts";
import { collaborationObjectAddresses } from "../lib/collaboration/index.ts";

declare const payloadId: SemanticPayloadId;
declare const actionId: ControlActionId;
declare const semanticEventId: SemanticEventId;
declare const controlEventId: ControlEventId;
declare const attestationId: AttestationId;
declare const revisionId: DocumentRevisionId;
declare const blobId: MarkdownBlobId;
declare const mergeKeyId: MergeKeyId;
declare const legacyAlias: LegacyIdentityAlias;

function needsPayload(value: SemanticPayloadId): void {
  void value;
}
function needsAction(value: ControlActionId): void {
  void value;
}
function needsSemanticEvent(value: SemanticEventId): void {
  void value;
}
function needsControlEvent(value: ControlEventId): void {
  void value;
}
function needsAttestation(value: AttestationId): void {
  void value;
}

needsPayload(payloadId);
needsAction(actionId);
needsSemanticEvent(semanticEventId);
needsControlEvent(controlEventId);
needsAttestation(attestationId);

collaborationObjectAddresses("semantic-payload", payloadId);
collaborationObjectAddresses("control-action", actionId);
collaborationObjectAddresses("semantic-event", semanticEventId);
collaborationObjectAddresses("control-event", controlEventId);
collaborationObjectAddresses("attestation", attestationId);

// @ts-expect-error Semantic events cannot address the control-event namespace.
collaborationObjectAddresses("control-event", semanticEventId);
// @ts-expect-error Control events cannot be used as semantic payload IDs.
needsPayload(controlEventId);
// @ts-expect-error Actions and payloads remain distinct digest namespaces.
needsAction(payloadId);
// @ts-expect-error Attestations are not semantic event IDs.
needsSemanticEvent(attestationId);
// @ts-expect-error Revisions are not control events.
needsControlEvent(revisionId);
// @ts-expect-error Markdown blobs are not attestations.
needsAttestation(blobId);
// @ts-expect-error Merge keys are not semantic events.
needsSemanticEvent(mergeKeyId);
// @ts-expect-error Legacy aliases never become protocol event IDs.
needsSemanticEvent(legacyAlias);

const attestationVerifier: CollaborationAttestationVerifier = {
  async verify(request) {
    return { outcome: "verified", binding: request };
  }
};

const transitionVerifier: CollaborationControlTransitionVerifier = {
  async verify() {
    return { outcome: "invalid", reason: "fixture" };
  }
};

void attestationVerifier;
void transitionVerifier;
