import type {
  EnrollmentRequestRecord,
  InvitationHandoffCore,
  PossessionProofRecord
} from "../hc2/enrollment-contracts.ts";
import type { Hc3IncrementalSha256Factory } from "./bundle-files.ts";
import type { Hc3ArtifactText } from "./text.ts";
import type {
  Hc3SafePreview,
  Hc3WorkflowEvidence
} from "./workflow-contracts.ts";

export type Hc3PortFailureKind =
  | "cancelled"
  | "unsupported"
  | "permission_denied"
  | "failed";

export type Hc3PortResult<T> =
  | Readonly<{ status: "success"; value: T }>
  | Readonly<{ status: Hc3PortFailureKind; diagnostic_code: string; fallback: string | null }>;

export type Hc3SelectedEncryptedFile = Readonly<{
  exact_bytes: Uint8Array;
  reported_size: bigint;
  media_type_hint: string;
  extension_hint: string;
}>;

export type Hc3SafeFileMetadata = Readonly<{
  authority: "none";
  reported_size: bigint;
  media_type_hint: string;
  extension_hint: string;
}>;

export interface Hc3ClipboardWritePort {
  writeText(input: Readonly<{ text: Hc3ArtifactText }>): Promise<Hc3PortResult<Readonly<{ written_characters: number }>>>;
}

export interface Hc3QrPresentationPort {
  present(input: Readonly<{ text: Hc3ArtifactText }>): Promise<Hc3PortResult<Readonly<{ presented_text: string }>>>;
}

export interface Hc3OsSharePort {
  share(input: Hc3ShareInput): Promise<Hc3PortResult<Readonly<{ mode: Hc3ShareInput["mode"] }>>>;
}

export type Hc3ShareInput =
  | Readonly<{ mode: "text"; text: Hc3ArtifactText; title: "Invitation" | "Response" }>
  | Readonly<{ mode: "link"; text: string; title: "Invitation" | "Response" }>
  | Readonly<{ mode: "encrypted_file"; exact_bytes: Uint8Array; filename: string; media_type: string; title: "Encrypted update" }>;

export interface Hc3EncryptedBundleSavePort {
  save(input: Readonly<{
    exact_bytes: Uint8Array;
    filename: string;
    media_type: string;
  }>): Promise<Hc3PortResult<Readonly<{ exact_byte_length: bigint }>>>;
}

export interface Hc3EncryptedBundleSelectionPort {
  select(input: Readonly<{ maximum_byte_length: bigint }>): Promise<Hc3PortResult<Hc3SelectedEncryptedFile>>;
}

export interface Hc3SafeFileMetadataPort {
  inspect(input: Hc3SelectedEncryptedFile): Promise<Hc3PortResult<Hc3SafeFileMetadata>>;
}

export interface Hc3UserConfirmationPort {
  confirm(input: Readonly<{
    title: string;
    explanation: string;
  }>): Promise<Hc3PortResult<Readonly<{ confirmed: true }>>>;
}

export interface Hc3CapabilityDetectionPort {
  detect(): Promise<Hc3PortResult<Readonly<{
    authority: "none";
    secure_context: boolean;
    clipboard_write: boolean;
    text_share: boolean;
    encrypted_file_share: boolean;
    native_file_save: boolean;
    native_file_open: boolean;
    browser_download: boolean;
    qr_presentation: boolean;
  }>>>;
}

export type Hc3BrowserPorts = Readonly<{
  clipboard: Hc3ClipboardWritePort;
  qr: Hc3QrPresentationPort;
  share: Hc3OsSharePort;
  save: Hc3EncryptedBundleSavePort;
  select: Hc3EncryptedBundleSelectionPort;
  metadata: Hc3SafeFileMetadataPort;
  confirmation: Hc3UserConfirmationPort | null;
  capabilities: Hc3CapabilityDetectionPort;
}>;

export type Hc3AuthoritativeOperationResult = Readonly<{
  status: "completed" | "duplicate" | "more_required";
  diagnostic_code: string | null;
}>;

export interface Hc3WorkflowEvidencePort {
  readEvidence(): Promise<unknown>;
}

export interface Hc3WorkflowOperationPort {
  createInvitation(input: Readonly<{ expected_revision: bigint }>): Promise<InvitationHandoffCore>;
  inspectInvitation(input: Readonly<{
    invitation: InvitationHandoffCore;
    evidence: Hc3WorkflowEvidence;
  }>): Promise<Hc3SafePreview>;
  beginEnrollment(input: Readonly<{
    invitation: InvitationHandoffCore;
    expected_revision: bigint;
  }>): Promise<Hc3AuthoritativeOperationResult>;
  createEnrollmentResponse(input: Readonly<{ expected_revision: bigint }>): Promise<Readonly<{
    request: EnrollmentRequestRecord;
    possession_proof: PossessionProofRecord;
  }>>;
  inspectEnrollmentResponse(input: Readonly<{
    request: EnrollmentRequestRecord;
    possession_proof: PossessionProofRecord;
    evidence: Hc3WorkflowEvidence;
  }>): Promise<Hc3SafePreview>;
  authorizeAdmission(input: Readonly<{
    request: EnrollmentRequestRecord;
    possession_proof: PossessionProofRecord;
    expected_revision: bigint;
  }>): Promise<Hc3AuthoritativeOperationResult>;
  prepareAdmissionBundle(input: Readonly<{ expected_revision: bigint }>): Promise<Uint8Array>;
  previewEncryptedBundle(input: Readonly<{
    purpose: "admission" | "synchronization";
    exact_bytes: Uint8Array;
    evidence: Hc3WorkflowEvidence;
  }>): Promise<Hc3SafePreview>;
  confirmAdmissionImport(input: Readonly<{
    exact_bytes: Uint8Array;
    expected_revision: bigint;
  }>): Promise<Hc3AuthoritativeOperationResult>;
  prepareSynchronizationBundle(input: Readonly<{ expected_revision: bigint }>): Promise<Uint8Array>;
  confirmSynchronizationImport(input: Readonly<{
    exact_bytes: Uint8Array;
    expected_revision: bigint;
  }>): Promise<Hc3AuthoritativeOperationResult>;
  inspectConvergence(input: Readonly<{ evidence: Hc3WorkflowEvidence }>): Promise<Readonly<{
    converged: boolean;
    more_required: boolean;
    diagnostic_code: string | null;
  }>>;
}

export type Hc3WorkflowDependencies = Readonly<{
  evidence: Hc3WorkflowEvidencePort;
  operations: Hc3WorkflowOperationPort;
  ports: Hc3BrowserPorts;
  sha256_factory: Hc3IncrementalSha256Factory;
}>;

export function success<T>(value: T): Hc3PortResult<T> {
  return Object.freeze({ status: "success", value: copyPortValue(value) });
}

export function portFailure(
  status: Hc3PortFailureKind,
  diagnosticCode: string,
  fallback: string | null = null
): Hc3PortResult<never> {
  if (!/^[a-z0-9_]{1,64}$/.test(diagnosticCode)) throw new Error("HC-3 port diagnostic code is invalid.");
  return Object.freeze({ status, diagnostic_code: diagnosticCode, fallback });
}

export function copyPortValue<T>(value: T): T {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as T;
  if (Array.isArray(value)) return Object.freeze(value.map(copyPortValue)) as T;
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, copyPortValue(child)])
    )) as T;
  }
  return value;
}
