export const HC2_PLATFORM_POLICY_VERSION = 1 as const;
export const HC2_AUTHORITY_CLASSIFICATION_VERSION = 1 as const;
export const HC2_PORTABLE_ADDRESS_VERSION = 1 as const;
export const HC2_REPLICA_SCHEMA_VERSION = 1 as const;
export const HC2_TRANSACTION_INTENT_SCHEMA_VERSION = 1 as const;
export const HC2_BATCH_SCHEMA_VERSION = 1 as const;
export const HC2_WRITER_CONTINUITY_SCHEMA_VERSION = 1 as const;
export const HC2_MATERIALIZATION_SCHEMA_VERSION = 1 as const;
export const HC2_COORDINATION_SCHEMA_VERSION = 1 as const;
export const HC2_CRYPTO_SUITE_VERSION = 1 as const;
export const HC2_ENVELOPE_VERSION = 1 as const;
export const HC2_LIMIT_PROFILE_VERSION = 1 as const;
export const HC2_RECOVERY_POLICY_VERSION = 1 as const;
export const HC2_CUSTODY_SCHEMA_VERSION = 1 as const;
export const HC2_RECOVERY_KIT_VERSION = 1 as const;
export const HC2_EPOCH_WRAP_VERSION = 1 as const;
export const HC2_CEREMONY_JOURNAL_VERSION = 1 as const;

export const HC2_ABSOLUTE_CHROMIUM_FLOOR = 137 as const;

export const HC2_CRYPTO_SUITE_ID = "patchmark/hc2/crypto-suite/v1" as const;
export const HC2_LIMIT_PROFILE_ID = "patchmark/hc2/limits/v1" as const;
export const HC2_FOLDER_ROOT = ".patchmark/patchmark-collaboration/v1/" as const;
export const HC2_ENVELOPE_MAGIC = "PATCHMARK-HC2-BUNDLE" as const;
export const HC2_HPKE_INFO_PROTOCOL_DOMAIN =
  "patchmark/hc2/hpke-info/v1" as const;
export const HC2_RECOVERY_KIT_PROFILE_ID =
  "patchmark/hc2/recovery-kit/v1" as const;
export const HC2_LOCAL_EPOCH_WRAP_PROFILE_ID =
  "patchmark/hc2/local-epoch-wrap/v1" as const;

export const hc2HashDomains = Object.freeze({
  batchObjectRoot: "patchmark/hc2/batch-object-root/v1",
  chunkCommitment: "patchmark/hc2/chunk-commitment/v1",
  bundleRoot: "patchmark/hc2/bundle-root/v1",
  encryptedContainer: "patchmark/hc2/encrypted-container/v1",
  objectCommitMarker: "patchmark/hc2/object-commit-marker/v1",
  portableBatch: "patchmark/hc2/portable-batch/v1",
  recoveryEnvelope: "patchmark/hc2/recovery-envelope/v1",
  transactionIntent: "patchmark/hc2/transaction-intent/v1",
  writerContinuity: "patchmark/hc2/writer-continuity/v1",
  custodyCeremonyPlan: "patchmark/hc2/custody-ceremony-plan/v1",
  epochSecretCommitment: "patchmark/hc2/epoch-secret-commitment/v1",
  recoveryKit: "patchmark/hc2/recovery-kit/v1",
  recoveryKitPayload: "patchmark/hc2/recovery-kit-payload/v1",
  recoveryConfirmation: "patchmark/hc2/recovery-confirmation/v1"
} as const);

export const hc2SignatureDomains = Object.freeze({
  envelopeChunk: "patchmark/hc2/signature/envelope-chunk/v1",
  writerContinuity: "patchmark/hc2/signature/writer-continuity/v1"
} as const);
