export const collaborationHashDomains = Object.freeze({
  acknowledgementCore: "patchmark/ack-core/v1",
  acceptedHistoryRoot: "patchmark/accepted-history-root/v1",
  attestationRecord: "patchmark/attestation-record/v1",
  conflictSetRoot: "patchmark/conflict-set-root/v1",
  controlAction: "patchmark/control-action/v1",
  controlEventCore: "patchmark/control-core/v1",
  controlStateRoot: "patchmark/control-state-root/v1",
  derivedConflict: "patchmark/derived-conflict/v1",
  frontierRoot: "patchmark/frontier-root/v1",
  keyEpochCommitment: "patchmark/key-epoch-commitment/v1",
  markdownBlob: "patchmark/markdown-blob/v1",
  merkleEmpty: "patchmark/merkle-empty/v1",
  merkleInternal: "patchmark/merkle-internal/v1",
  merkleMapLeaf: "patchmark/merkle-map-leaf/v1",
  merkleSetLeaf: "patchmark/merkle-set-leaf/v1",
  mergeKey: "patchmark/merge-key/v1",
  projectionRoot: "patchmark/projection-root/v1",
  resolutionOperations: "patchmark/resolution-operations/v1",
  revisionCore: "patchmark/revision-core/v1",
  revisionHeadsRoot: "patchmark/revision-heads-root/v1",
  semanticEventCore: "patchmark/event-core/v1",
  semanticPayload: "patchmark/semantic-payload/v1",
  semanticStateRoot: "patchmark/semantic-state-root/v1",
  snapshotCore: "patchmark/snapshot-core/v1",
  stateBlob: "patchmark/state-blob/v1"
} as const);

export const collaborationSignatureDomains = Object.freeze({
  acknowledgement: "patchmark/signature/acknowledgement/v1",
  control_event: "patchmark/signature/control-event/v1",
  semantic_event: "patchmark/signature/semantic-event/v1",
  snapshot: "patchmark/signature/snapshot/v1"
} as const);
