import { DEVICE_PRIVATE_STATE_SCHEMA_VERSION } from "./versions.ts";
import {
  type ControlEventId,
  type DeviceId,
  type DocumentId,
  type DocumentRevisionId,
  type ExternalImportCandidateId,
  type FrontierRootId,
  type MarkdownBlobId,
  type ProjectId,
  type ProjectionRootId,
  parseDigestId,
  parseEntityId
} from "./identities.ts";
import {
  type NonAuthoritativeTimestamp,
  expectBoolean,
  expectBytes,
  expectDisplayTimestamp,
  expectEnum,
  expectExactRecord,
  expectLiteral,
  expectNonEmptyString,
  expectString,
  freezeRecord
} from "./validation.ts";

type DevicePrivateBase<TKind extends string> = Readonly<{
  schema_version: typeof DEVICE_PRIVATE_STATE_SCHEMA_VERSION;
  state_scope: "device_private";
  private_kind: TKind;
  project_id: ProjectId;
  device_id: DeviceId;
}>;

export type LocalFilesystemBinding =
  DevicePrivateBase<"local_filesystem_binding"> &
    Readonly<{
      document_id: DocumentId;
      binding_id: string;
      relative_path: string;
      file_identity_hint: string | null;
    }>;

export type UnsavedMarkdownRecovery =
  DevicePrivateBase<"unsaved_markdown_recovery"> &
    Readonly<{
      document_id: DocumentId;
      base_revision_id: DocumentRevisionId | null;
      markdown_bytes: Uint8Array;
      captured_at: NonAuthoritativeTimestamp;
    }>;

export type ExternalMarkdownImportCandidate =
  DevicePrivateBase<"external_markdown_import_candidate"> &
    Readonly<{
      candidate_id: ExternalImportCandidateId;
      document_id: DocumentId;
      filesystem_binding_id: string;
      base_materialized_revision_id: DocumentRevisionId;
      external_blob_id: MarkdownBlobId;
      detected_frontier_root: FrontierRootId;
      detected_projection_root: ProjectionRootId;
      detected_control_head_id: ControlEventId;
      authority: "none";
      detected_at: NonAuthoritativeTimestamp;
    }>;

export type MaterializationReceipt =
  DevicePrivateBase<"materialization_receipt"> &
    Readonly<{
      document_id: DocumentId;
      filesystem_binding_id: string;
      materialized_revision_id: DocumentRevisionId;
      materialized_blob_id: MarkdownBlobId;
      projection_root: ProjectionRootId;
      materialization_generation: string;
    }>;

export type DeviceReadingBookmark = DevicePrivateBase<"reading_bookmark"> &
  Readonly<{
    document_id: DocumentId;
    anchor_kind: "section" | "selected_text";
    anchor_value: string;
  }>;

export type ActiveEditorState = DevicePrivateBase<"active_editor_state"> &
  Readonly<{
    active_document_id: DocumentId;
    editor_mode: "markdown" | "visual";
    active_comment_id: string | null;
    selection_state: string | null;
    scroll_state: string | null;
    groups_collapsed: boolean;
  }>;

export type LocalQuarantineDiagnostic =
  DevicePrivateBase<"local_quarantine_diagnostic"> &
    Readonly<{
      diagnostic_code: string;
      object_reference: string;
      detail: string;
      observed_at: NonAuthoritativeTimestamp;
      authority: "none";
    }>;

export type DevicePrivateState =
  | LocalFilesystemBinding
  | UnsavedMarkdownRecovery
  | ExternalMarkdownImportCandidate
  | MaterializationReceipt
  | DeviceReadingBookmark
  | ActiveEditorState
  | LocalQuarantineDiagnostic;

export function parseDevicePrivateState(value: unknown): DevicePrivateState {
  const discriminator = expectExactRecord(
    value,
    "device-private state",
    ["schema_version", "state_scope", "private_kind", "project_id", "device_id"],
    [
      "document_id",
      "binding_id",
      "relative_path",
      "file_identity_hint",
      "base_revision_id",
      "markdown_bytes",
      "captured_at",
      "candidate_id",
      "filesystem_binding_id",
      "base_materialized_revision_id",
      "external_blob_id",
      "detected_frontier_root",
      "detected_projection_root",
      "detected_control_head_id",
      "authority",
      "detected_at",
      "materialized_revision_id",
      "materialized_blob_id",
      "projection_root",
      "materialization_generation",
      "anchor_kind",
      "anchor_value",
      "active_document_id",
      "editor_mode",
      "active_comment_id",
      "selection_state",
      "scroll_state",
      "groups_collapsed",
      "diagnostic_code",
      "object_reference",
      "detail",
      "observed_at"
    ]
  );
  expectLiteral(
    discriminator.schema_version,
    DEVICE_PRIVATE_STATE_SCHEMA_VERSION,
    "device-private schema version"
  );
  expectLiteral(
    discriminator.state_scope,
    "device_private",
    "device-private state scope"
  );
  const kind = expectEnum(
    discriminator.private_kind,
    [
      "local_filesystem_binding",
      "unsaved_markdown_recovery",
      "external_markdown_import_candidate",
      "materialization_receipt",
      "reading_bookmark",
      "active_editor_state",
      "local_quarantine_diagnostic"
    ] as const,
    "device-private state kind"
  );
  const common = {
    schema_version: DEVICE_PRIVATE_STATE_SCHEMA_VERSION,
    state_scope: "device_private" as const,
    project_id: parseEntityId("project", discriminator.project_id),
    device_id: parseEntityId("device", discriminator.device_id)
  };

  switch (kind) {
    case "local_filesystem_binding":
      requireVariantKeys(discriminator, [
        "document_id",
        "binding_id",
        "relative_path",
        "file_identity_hint"
      ]);
      return freezeRecord({
        ...common,
        private_kind: kind,
        document_id: parseEntityId("document", discriminator.document_id),
        binding_id: parseLocalToken(discriminator.binding_id, "filesystem binding ID"),
        relative_path: expectNonEmptyString(
          discriminator.relative_path,
          "filesystem relative path"
        ),
        file_identity_hint:
          discriminator.file_identity_hint === null
            ? null
            : expectString(discriminator.file_identity_hint, "file identity hint")
      });
    case "unsaved_markdown_recovery":
      requireVariantKeys(discriminator, [
        "document_id",
        "base_revision_id",
        "markdown_bytes",
        "captured_at"
      ]);
      return freezeRecord({
        ...common,
        private_kind: kind,
        document_id: parseEntityId("document", discriminator.document_id),
        base_revision_id:
          discriminator.base_revision_id === null
            ? null
            : parseDigestId("document-revision", discriminator.base_revision_id),
        markdown_bytes: expectBytes(
          discriminator.markdown_bytes,
          "unsaved recovery Markdown bytes"
        ),
        captured_at: expectDisplayTimestamp(
          discriminator.captured_at,
          "unsaved recovery capture time"
        )
      });
    case "external_markdown_import_candidate":
      requireVariantKeys(discriminator, [
        "candidate_id",
        "document_id",
        "filesystem_binding_id",
        "base_materialized_revision_id",
        "external_blob_id",
        "detected_frontier_root",
        "detected_projection_root",
        "detected_control_head_id",
        "authority",
        "detected_at"
      ]);
      expectLiteral(
        discriminator.authority,
        "none",
        "external import candidate authority"
      );
      return freezeRecord({
        ...common,
        private_kind: kind,
        candidate_id: parseEntityId(
          "external-import-candidate",
          discriminator.candidate_id
        ),
        document_id: parseEntityId("document", discriminator.document_id),
        filesystem_binding_id: parseLocalToken(
          discriminator.filesystem_binding_id,
          "filesystem binding ID"
        ),
        base_materialized_revision_id: parseDigestId(
          "document-revision",
          discriminator.base_materialized_revision_id
        ),
        external_blob_id: parseDigestId(
          "markdown-blob",
          discriminator.external_blob_id
        ),
        detected_frontier_root: parseDigestId(
          "frontier-root",
          discriminator.detected_frontier_root
        ),
        detected_projection_root: parseDigestId(
          "projection-root",
          discriminator.detected_projection_root
        ),
        detected_control_head_id: parseDigestId(
          "control-event",
          discriminator.detected_control_head_id
        ),
        authority: "none" as const,
        detected_at: expectDisplayTimestamp(
          discriminator.detected_at,
          "external import detection time"
        )
      });
    case "materialization_receipt":
      requireVariantKeys(discriminator, [
        "document_id",
        "filesystem_binding_id",
        "materialized_revision_id",
        "materialized_blob_id",
        "projection_root",
        "materialization_generation"
      ]);
      return freezeRecord({
        ...common,
        private_kind: kind,
        document_id: parseEntityId("document", discriminator.document_id),
        filesystem_binding_id: parseLocalToken(
          discriminator.filesystem_binding_id,
          "filesystem binding ID"
        ),
        materialized_revision_id: parseDigestId(
          "document-revision",
          discriminator.materialized_revision_id
        ),
        materialized_blob_id: parseDigestId(
          "markdown-blob",
          discriminator.materialized_blob_id
        ),
        projection_root: parseDigestId(
          "projection-root",
          discriminator.projection_root
        ),
        materialization_generation: parseLocalToken(
          discriminator.materialization_generation,
          "materialization generation"
        )
      });
    case "reading_bookmark":
      requireVariantKeys(discriminator, [
        "document_id",
        "anchor_kind",
        "anchor_value"
      ]);
      return freezeRecord({
        ...common,
        private_kind: kind,
        document_id: parseEntityId("document", discriminator.document_id),
        anchor_kind: expectEnum(
          discriminator.anchor_kind,
          ["section", "selected_text"] as const,
          "reading bookmark anchor kind"
        ),
        anchor_value: expectString(discriminator.anchor_value, "bookmark anchor")
      });
    case "active_editor_state":
      requireVariantKeys(discriminator, [
        "active_document_id",
        "editor_mode",
        "active_comment_id",
        "selection_state",
        "scroll_state",
        "groups_collapsed"
      ]);
      return freezeRecord({
        ...common,
        private_kind: kind,
        active_document_id: parseEntityId(
          "document",
          discriminator.active_document_id
        ),
        editor_mode: expectEnum(
          discriminator.editor_mode,
          ["markdown", "visual"] as const,
          "editor mode"
        ),
        active_comment_id:
          discriminator.active_comment_id === null
            ? null
            : parseEntityId("comment", discriminator.active_comment_id),
        selection_state:
          discriminator.selection_state === null
            ? null
            : expectString(discriminator.selection_state, "selection state"),
        scroll_state:
          discriminator.scroll_state === null
            ? null
            : expectString(discriminator.scroll_state, "scroll state"),
        groups_collapsed: expectBoolean(
          discriminator.groups_collapsed,
          "group collapsed state"
        )
      });
    case "local_quarantine_diagnostic":
      requireVariantKeys(discriminator, [
        "diagnostic_code",
        "object_reference",
        "detail",
        "observed_at",
        "authority"
      ]);
      expectLiteral(
        discriminator.authority,
        "none",
        "quarantine diagnostic authority"
      );
      return freezeRecord({
        ...common,
        private_kind: kind,
        diagnostic_code: parseLocalToken(
          discriminator.diagnostic_code,
          "diagnostic code"
        ),
        object_reference: expectNonEmptyString(
          discriminator.object_reference,
          "diagnostic object reference"
        ),
        detail: expectString(discriminator.detail, "diagnostic detail"),
        observed_at: expectDisplayTimestamp(
          discriminator.observed_at,
          "diagnostic observation time"
        ),
        authority: "none" as const
      });
  }
}

const baseKeys = new Set([
  "schema_version",
  "state_scope",
  "private_kind",
  "project_id",
  "device_id"
]);

function requireVariantKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): void {
  const allowed = new Set([...baseKeys, ...keys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Device-private ${record.private_kind} cannot contain ${key}.`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Device-private ${record.private_kind} requires ${key}.`);
    }
  }
}

function parseLocalToken(value: unknown, label: string): string {
  const token = expectNonEmptyString(value, label);
  if (!/^[A-Za-z0-9._:-]+$/.test(token)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return token;
}
