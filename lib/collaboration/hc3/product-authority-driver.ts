import {
  hc3ProductActions,
  parseHc3ProductSnapshot,
  validateHc3ProductActionInput,
  type Hc3ProductAction,
  type Hc3ProductActionInput,
  type Hc3ProductQualificationDriver,
  type Hc3ProductSnapshot
} from "./product-contracts.ts";

export const HC3_PRODUCT_AUTHORITY_RUNTIME_KEY =
  "__patchmarkHc3ProductAuthorityRuntime" as const;

export const hc3ProductAuthorityBoundaries = Object.freeze([
  "durable_reconstruction",
  "hc1_foundation",
  "hc2_recovery_custody",
  "hc2_invitation_control",
  "hc2_enrollment_possession",
  "hc2_admission_v2",
  "hc2_replication_v3",
  "hc3_direct_v3",
  "hc1_conflict_resolution",
  "hc2_epoch_rotation"
] as const);

export type Hc3ProductAuthorityBoundary =
  (typeof hc3ProductAuthorityBoundaries)[number];

export type Hc3ProductAuthorityEvidence = Readonly<{
  schema_version: 1;
  record_kind: "hc3_product_authority_evidence";
  authority: "hc2_hc3";
  action: Hc3ProductAction | "inspect";
  project_id: string;
  revision: bigint;
  boundary: Hc3ProductAuthorityBoundary;
  durable_revalidation: true;
  accepted_object_ids: readonly string[];
  exact_v3_sha256: string | null;
  snapshot: Hc3ProductSnapshot;
}>;

export interface Hc3ProductAuthorityRuntime {
  inspect(input: Readonly<{ project_id: string }>): Promise<unknown>;
  invoke(input: Hc3ProductActionInput): Promise<unknown>;
  closeOperationalWork?(): void;
}

const actionBoundaries: Readonly<Record<Hc3ProductAction, readonly Hc3ProductAuthorityBoundary[]>> =
  Object.freeze({
    create_collaboration_copy: ["hc1_foundation"],
    verify_recovery_kit: ["hc2_recovery_custody"],
    create_invitation: ["hc2_invitation_control"],
    cancel_invitation: ["hc2_invitation_control"],
    preview_received_artifact: ["hc2_invitation_control", "hc2_enrollment_possession"],
    continue_invitation: ["hc2_enrollment_possession"],
    create_response: ["hc2_enrollment_possession"],
    authorize_admission: ["hc2_enrollment_possession", "hc2_admission_v2"],
    save_encrypted_file: ["hc2_admission_v2", "hc2_replication_v3"],
    select_encrypted_file: ["hc2_admission_v2", "hc2_replication_v3"],
    preview_encrypted_file: ["hc2_admission_v2", "hc2_replication_v3"],
    import_encrypted_file: ["hc2_admission_v2", "hc2_replication_v3"],
    create_direct_offer: ["hc3_direct_v3"],
    open_direct_offer: ["hc3_direct_v3"],
    create_direct_answer: ["hc3_direct_v3"],
    open_direct_answer: ["hc3_direct_v3"],
    sync_directly: ["hc3_direct_v3", "hc2_replication_v3"],
    use_encrypted_file: ["hc2_replication_v3"],
    change_role: ["hc2_epoch_rotation"],
    revoke_device: ["hc2_epoch_rotation"],
    revoke_membership: ["hc2_epoch_rotation"],
    resolve_conflict: ["hc1_conflict_resolution"],
    reopen_and_verify: ["durable_reconstruction"]
  });

export function readInjectedHc3ProductAuthorityRuntime(
  environment: unknown
): Hc3ProductAuthorityRuntime | null {
  if (!environment || typeof environment !== "object") return null;
  const candidate = (environment as Record<string, unknown>)[HC3_PRODUCT_AUTHORITY_RUNTIME_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const runtime = candidate as Partial<Hc3ProductAuthorityRuntime>;
  if (typeof runtime.inspect !== "function" || typeof runtime.invoke !== "function") return null;
  return runtime as Hc3ProductAuthorityRuntime;
}

export function createHc3ProductAuthorityDriver(input: Readonly<{
  project_id: string;
  runtime: Hc3ProductAuthorityRuntime;
}>): Hc3ProductQualificationDriver {
  let currentRevision: bigint | null = null;

  return Object.freeze({
    async inspect(request: Readonly<{ project_id: string }>) {
      assertProject(request.project_id, input.project_id);
      const evidence = parseAuthorityEvidence(
        await input.runtime.inspect(request),
        "inspect",
        input.project_id
      );
      currentRevision = evidence.revision;
      return evidence.snapshot;
    },
    async invoke(request: Hc3ProductActionInput) {
      const action = validateHc3ProductActionInput(request);
      assertProject(action.project_id, input.project_id);
      if (currentRevision === null || action.expected_revision !== currentRevision) {
        throw new Error("Product action is stale relative to reconstructed HC-2 evidence.");
      }
      const evidence = parseAuthorityEvidence(
        await input.runtime.invoke(action),
        action.action,
        input.project_id
      );
      if (!actionBoundaries[action.action].includes(evidence.boundary)) {
        throw new Error(`Product action returned the wrong durable authority boundary: ${evidence.boundary}.`);
      }
      if (evidence.revision <= currentRevision) {
        throw new Error("Accepted product authority evidence did not advance its durable revision.");
      }
      currentRevision = evidence.revision;
      return evidence.snapshot;
    },
    closeOperationalWork() {
      input.runtime.closeOperationalWork?.();
    }
  });
}

export function parseHc3ProductAuthorityEvidence(
  value: unknown
): Hc3ProductAuthorityEvidence {
  return parseAuthorityEvidence(value, null, null);
}

function parseAuthorityEvidence(
  value: unknown,
  expectedAction: Hc3ProductAction | "inspect" | null,
  expectedProject: string | null
): Hc3ProductAuthorityEvidence {
  const record = exact(value, [
    "schema_version", "record_kind", "authority", "action", "project_id",
    "revision", "boundary", "durable_revalidation", "accepted_object_ids",
    "exact_v3_sha256", "snapshot"
  ]);
  if (
    record.schema_version !== 1 ||
    record.record_kind !== "hc3_product_authority_evidence" ||
    record.authority !== "hc2_hc3" ||
    record.durable_revalidation !== true
  ) {
    throw new Error("Product authority evidence provenance is invalid.");
  }
  const action = record.action === "inspect"
    ? "inspect"
    : enumeration(record.action, hc3ProductActions, "product authority action");
  if (expectedAction !== null && action !== expectedAction) {
    throw new Error("Product authority evidence is bound to another action.");
  }
  const projectId = text(record.project_id, "product authority project", 256);
  if (expectedProject !== null) assertProject(projectId, expectedProject);
  if (typeof record.revision !== "bigint" || record.revision < BigInt(0)) {
    throw new Error("Product authority evidence revision is invalid.");
  }
  const boundary = enumeration(
    record.boundary,
    hc3ProductAuthorityBoundaries,
    "product authority boundary"
  );
  const acceptedIds = stringArray(record.accepted_object_ids).map((id) => {
    if (!/^(?:pm:[a-z0-9-]+:v[123]:[a-z2-7]{12,64}|[0-9a-f]{64})$/.test(id)) {
      throw new Error("Product authority evidence contains a non-canonical accepted identity.");
    }
    return id;
  });
  if (new Set(acceptedIds).size !== acceptedIds.length) {
    throw new Error("Product authority evidence repeats an accepted identity.");
  }
  const exactV3 = record.exact_v3_sha256 === null
    ? null
    : sha256(record.exact_v3_sha256);
  if ((boundary === "hc2_replication_v3" || boundary === "hc3_direct_v3") && action !== "inspect" && exactV3 === null) {
    throw new Error("V3 authority evidence must bind the exact transported bytes.");
  }
  const snapshot = parseHc3ProductSnapshot(record.snapshot);
  if (snapshot.project_id !== projectId || snapshot.revision !== record.revision) {
    throw new Error("Product presentation does not match its durable authority evidence.");
  }
  return Object.freeze({
    schema_version: 1,
    record_kind: "hc3_product_authority_evidence",
    authority: "hc2_hc3",
    action,
    project_id: projectId,
    revision: record.revision,
    boundary,
    durable_revalidation: true,
    accepted_object_ids: Object.freeze([...acceptedIds].sort()),
    exact_v3_sha256: exactV3,
    snapshot
  });
}

function assertProject(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("Product authority runtime is bound to another project.");
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Product authority evidence must be an exact record.");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Product authority evidence has unexpected or missing fields.");
  }
  return record;
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} is unsupported.`);
  }
  return value as T[number];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Accepted product authority identities must be an array of strings.");
  }
  return [...value] as string[];
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Product authority V3 digest must be lowercase SHA-256 hex.");
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
