import {
  SOURCE_DATE_REFERENCE_ERROR,
  SOURCE_DATE_UNAVAILABLE_REFERENCE_ERROR,
  SOURCE_OBSERVATION_REFERENCE_ERROR,
  SourceReferenceValidationError,
  validateSuggestedTextReferenceDates,
  validateSuggestedTextReferenceDatesWithCoverage
} from "../imports/source-date-validation.ts";
import {
  getMarkdownHeadingSectionRange,
  normalizeMarkdownHeading
} from "../markdown/heading-sections.ts";
import type {
  PatchmarkComment,
  PatchmarkCommentReplyImport,
  PatchmarkPatch
} from "../project/project-types.ts";
import { resolveAndApplyPendingPatch } from "./patch-application.ts";

export type PatchDependencyErrorCode =
  | "cross_comment_dependency"
  | "cross_document_dependency"
  | "current_document_patch_target_ambiguous"
  | "current_document_patch_target_missing"
  | "dependent_patch_stale_after_prerequisites"
  | "dependent_patch_target_ambiguous_after_prerequisites"
  | "dependency_patch_overlap_conflict"
  | "dependency_patch_target_ambiguous"
  | "dependency_patch_target_missing"
  | "dependency_simulation_failed"
  | "dependency_source_date_coverage_failed"
  | "dependency_source_preservation_failed"
  | "duplicate_dependency_reference"
  | "duplicate_patch_key"
  | "exported_document_patch_target_ambiguous"
  | "exported_document_patch_target_missing"
  | "independent_patch_simulation_invariant"
  | "missing_patch_dependency"
  | "patch_dependency_cycle"
  | "self_patch_dependency"
  | "unsupported_dependency_protocol";

export type PatchDependencyBaseDocumentState =
  | "changed"
  | "current"
  | "unknown";

export class PatchDependencyValidationError extends Error {
  readonly code: PatchDependencyErrorCode;
  readonly patchKey?: string;
  readonly dependencyKey?: string;
  readonly disclosurePrerequisiteStatus?: "absent" | "invalid" | "unrelated";
  readonly observedAt?: string;
  readonly repairPromptEligible: boolean;
  readonly sourceUrl?: string;

  constructor({
    code,
    dependencyKey,
    disclosurePrerequisiteStatus,
    message,
    observedAt,
    repairPromptEligible = true,
    sourceUrl,
    patchKey
  }: {
    code: PatchDependencyErrorCode;
    dependencyKey?: string;
    disclosurePrerequisiteStatus?: "absent" | "invalid" | "unrelated";
    message: string;
    observedAt?: string;
    repairPromptEligible?: boolean;
    sourceUrl?: string;
    patchKey?: string;
  }) {
    super(message);
    this.name = "PatchDependencyValidationError";
    this.code = code;
    this.patchKey = patchKey;
    this.dependencyKey = dependencyKey;
    this.disclosurePrerequisiteStatus = disclosurePrerequisiteStatus;
    this.observedAt = observedAt;
    this.repairPromptEligible = repairPromptEligible;
    this.sourceUrl = sourceUrl;
  }
}

export type PatchDependencyReviewState =
  | "ready"
  | "blocked_by_pending_dependency"
  | "blocked_by_rejected_dependency"
  | "blocked_by_unavailable_dependency"
  | "dependency_validation_stale";

export type PatchDependencyReviewStatus = {
  acceptedCount: number;
  directDependencies: Array<{
    id: string;
    patch: PatchmarkPatch | null;
  }>;
  pendingCount: number;
  rejectedCount: number;
  state: PatchDependencyReviewState;
  totalCount: number;
  unavailableCount: number;
};

type DependencyGraph = {
  indexByKey: Map<string, number>;
  proposalByKey: Map<
    string,
    PatchmarkCommentReplyImport["patch_proposals"][number]
  >;
};

const SOURCE_SECTION_HEADING_PATTERN =
  /\b(source notes|sources|references)\b/i;
const VISIBLE_URL_PATTERN = /https?:\/\/[^\s)\]>]+/gi;
const SOURCE_DATE_ERRORS = new Set([
  SOURCE_DATE_REFERENCE_ERROR,
  SOURCE_DATE_UNAVAILABLE_REFERENCE_ERROR,
  SOURCE_OBSERVATION_REFERENCE_ERROR
]);

export function validatePatchDependencyGraph(
  response: PatchmarkCommentReplyImport
): void {
  if (response.protocol_version === 1) {
    const hasDependencyFields = response.patch_proposals.some(
      (proposal) =>
        proposal.patch_key !== undefined || proposal.depends_on !== undefined
    );

    if (hasDependencyFields) {
      throw new PatchDependencyValidationError({
        code: "unsupported_dependency_protocol",
        message:
          "Protocol version 1 patch proposals cannot include patch_key or depends_on."
      });
    }

    return;
  }

  const graph = createDependencyGraph(response.patch_proposals);
  validateDependencyCycles(graph);
}

export function getPatchDependencyClosureOrder(
  response: PatchmarkCommentReplyImport,
  patchKey: string
): string[] {
  const graph = createDependencyGraph(response.patch_proposals);
  const visited = new Set<string>();
  const order: string[] = [];

  visitDependencyClosure(patchKey, graph, visited, order);
  return order.filter((key) => key !== patchKey);
}

export function validateImportedPatchDependencySimulation({
  baseDocumentState = "unknown",
  comments,
  existingPatches,
  importedPatches,
  markdown
}: {
  baseDocumentState?: PatchDependencyBaseDocumentState;
  comments: PatchmarkComment[];
  existingPatches: PatchmarkPatch[];
  importedPatches: PatchmarkPatch[];
  markdown: string;
}): Map<string, string[]> {
  const importedById = new Map(
    importedPatches.map((patch) => [patch.id, patch])
  );
  const importedIndexById = new Map(
    importedPatches.map((patch, index) => [patch.id, index])
  );
  const simulationOrders = new Map<string, string[]>();

  for (const patch of importedPatches) {
    const prerequisiteIds = getPersistedDependencyClosureOrder(
      patch,
      importedById,
      importedIndexById
    );
    const prerequisitePatches = prerequisiteIds.map((prerequisiteId) => {
      const prerequisite = importedById.get(prerequisiteId);

      if (!prerequisite) {
        throw new PatchDependencyValidationError({
          code: "missing_patch_dependency",
          dependencyKey: prerequisiteId,
          message: `Patch ${patch.source_patch_key ?? patch.id} references a missing prerequisite.`,
          patchKey: patch.source_patch_key
        });
      }

      return prerequisite;
    });
    const simulatedPatches = [
      ...existingPatches,
      ...prerequisitePatches,
      patch
    ];
    let simulatedMarkdown = markdown;
    const appliedPrerequisites: PatchmarkPatch[] = [];

    for (const prerequisite of prerequisitePatches) {
      const application = resolveAndApplyPendingPatch({
        comments,
        markdown: simulatedMarkdown,
        patch: prerequisite,
        patches: simulatedPatches
      });

      if (application.kind !== "applied") {
        throw createSimulationTargetError({
          appliedPrerequisites,
          dependentPatch: patch,
          failedPatch: prerequisite,
          kind: application.kind,
          prerequisite: true,
          baseDocumentState
        });
      }

      simulatedMarkdown = application.markdown;
      appliedPrerequisites.push(prerequisite);
    }

    if (prerequisiteIds.length === 0 && simulatedMarkdown !== markdown) {
      throw new PatchDependencyValidationError({
        code: "independent_patch_simulation_invariant",
        message: `Patch ${patch.source_patch_key ?? patch.id} could not be validated because Patchmark mutated an independent sibling simulation. The response itself was not the cause.`,
        patchKey: patch.source_patch_key,
        repairPromptEligible: false
      });
    }

    const application = resolveAndApplyPendingPatch({
      comments,
      markdown: simulatedMarkdown,
      patch,
      patches: simulatedPatches
    });

    if (application.kind !== "applied") {
      throw createSimulationTargetError({
        appliedPrerequisites,
        dependentPatch: patch,
        failedPatch: patch,
        kind: application.kind,
        prerequisite: false,
        baseDocumentState
      });
    }

    simulatedMarkdown = application.markdown;
    validateSimulatedPatchSources({
      appliedPrerequisites,
      finalMarkdown: simulatedMarkdown,
      patch
    });
    validateSimulatedSourcePreservation({
      finalMarkdown: simulatedMarkdown,
      patch
    });
    simulationOrders.set(patch.id, [...prerequisiteIds, patch.id]);
  }

  return simulationOrders;
}

export function getPatchDependencyReviewStatus({
  applicability,
  patch,
  patches
}: {
  applicability?: "exact_match" | "multiple_matches" | "not_found" | "table_row_rebase_available";
  patch: PatchmarkPatch;
  patches: PatchmarkPatch[];
}): PatchDependencyReviewStatus {
  const byId = new Map(patches.map((candidate) => [candidate.id, candidate]));
  const directIds = patch.depends_on_patch_ids ?? [];
  const directDependencies = directIds.map((id, index) => {
    const candidate = byId.get(id) ?? null;
    const expectedKey = patch.depends_on_patch_keys_snapshot?.[index];

    return {
      id,
      patch:
        candidate &&
        isValidPersistedDependencyOwnership({
          dependency: candidate,
          expectedKey,
          owner: patch
        })
          ? candidate
          : null
    };
  });
  const closure = collectPersistedDependencyClosure(patch, byId);
  const dependencyPatches = closure.ids.map((id) =>
    closure.invalidIds.has(id) ? null : byId.get(id) ?? null
  );
  const unavailableCount =
    closure.cycleDetected
      ? Math.max(1, dependencyPatches.filter((candidate) => !candidate).length)
      : dependencyPatches.filter(
          (candidate) => !candidate || candidate.status === "stale"
        ).length;
  const rejectedCount = dependencyPatches.filter(
    (candidate) => candidate?.status === "rejected"
  ).length;
  const pendingCount = dependencyPatches.filter(
    (candidate) => candidate?.status === "pending"
  ).length;
  const acceptedCount = dependencyPatches.filter(
    (candidate) => candidate?.status === "accepted"
  ).length;
  let state: PatchDependencyReviewState = "ready";

  if (unavailableCount > 0) {
    state = "blocked_by_unavailable_dependency";
  } else if (rejectedCount > 0) {
    state = "blocked_by_rejected_dependency";
  } else if (pendingCount > 0) {
    state = "blocked_by_pending_dependency";
  } else if (
    directIds.length > 0 &&
    applicability !== undefined &&
    applicability !== "exact_match"
  ) {
    state = "dependency_validation_stale";
  }

  return {
    acceptedCount,
    directDependencies,
    pendingCount,
    rejectedCount,
    state,
    totalCount: closure.ids.length,
    unavailableCount
  };
}

export function getPatchDependencyBlockerMessage(
  status: PatchDependencyReviewStatus
): string | null {
  if (status.state === "blocked_by_pending_dependency") {
    return `This patch depends on ${status.pendingCount} proposal${status.pendingCount === 1 ? "" : "s"} that ${status.pendingCount === 1 ? "has" : "have"} not been accepted yet.`;
  }

  if (status.state === "blocked_by_rejected_dependency") {
    return "This patch depends on a proposal you rejected. It cannot be applied safely without revision.";
  }

  if (status.state === "blocked_by_unavailable_dependency") {
    return "This patch depends on a proposal that is unavailable. Review or repair the dependency before applying it.";
  }

  if (status.state === "dependency_validation_stale") {
    return "The document no longer matches the dependency-validated patch state. Review or repair this proposal.";
  }

  return null;
}

export function createPatchDependencyRepairPrompt(error: unknown): string {
  const isSourceDateFailure =
    error instanceof Error && SOURCE_DATE_ERRORS.has(error.message);

  if (
    !(error instanceof PatchDependencyValidationError) &&
    !isSourceDateFailure
  ) {
    return "";
  }
  if (
    error instanceof PatchDependencyValidationError &&
    !error.repairPromptEligible
  ) {
    return "";
  }

  const errorDetails =
    error instanceof PatchDependencyValidationError
      ? [
          error.patchKey ? `Failing patch_key: ${error.patchKey}` : "",
          error.dependencyKey
            ? `Dependency patch_key: ${error.dependencyKey}`
            : "",
          error.sourceUrl ? `Failed source: ${error.sourceUrl}` : "",
          error.observedAt
            ? `Expected observation date: ${error.observedAt}`
            : "",
          error.disclosurePrerequisiteStatus
            ? `Disclosure prerequisite status: ${error.disclosurePrerequisiteStatus}`
            : ""
        ].filter(Boolean)
      : [];
  const sourceDependencyRule =
    error instanceof PatchDependencyValidationError &&
    error.code === "dependency_source_date_coverage_failed"
      ? `\n- Correct the \`depends_on\` graph for ${error.patchKey ?? "the failing patch"} so it declares a prerequisite whose output supplies the required disclosure in the same or deterministically containing section.\n- Do not duplicate shared disclosure prose into each dependent patch.`
      : "";

  return `Dependency repair required.

Validation code: ${
    error instanceof PatchDependencyValidationError
      ? error.code
      : "coordinated_source_validation_failed"
  }${errorDetails.length > 0 ? `\n${errorDetails.join("\n")}` : ""}

- Return protocol_version 2.
- Give every patch proposal a unique non-empty patch_key.
- Give every patch proposal a depends_on array.
- Use only patch_key values from this same response.
- Keep dependencies within the same comment_id.
- Remove duplicate, missing, self-referential, or cyclic dependencies.
- Ensure prerequisites can be applied in dependency order before their dependents.
- When one same-section disclosure supplies publication and observation dates for source-link patches, make those patches depend on the disclosure patch instead of repeating the disclosure in every patch.
- Include every source-preservation prerequisite needed before deleting a Sources or References section.
- Preserve review_batch_id, project_id, document_id, comment IDs, titles, original_text, suggested_text, sources, reasons, risks, and response substance.
- Do not remove patches or rewrite unrelated content.${sourceDependencyRule}`;
}

function createDependencyGraph(
  proposals: PatchmarkCommentReplyImport["patch_proposals"]
): DependencyGraph {
  const proposalByKey = new Map<
    string,
    PatchmarkCommentReplyImport["patch_proposals"][number]
  >();
  const indexByKey = new Map<string, number>();

  proposals.forEach((proposal, index) => {
    const patchKey = proposal.patch_key;

    if (!patchKey || !Array.isArray(proposal.depends_on)) {
      throw new PatchDependencyValidationError({
        code: "unsupported_dependency_protocol",
        message:
          "Protocol version 2 requires patch_key and depends_on on every patch proposal.",
        patchKey
      });
    }

    if (proposalByKey.has(patchKey)) {
      throw new PatchDependencyValidationError({
        code: "duplicate_patch_key",
        message: `Duplicate patch_key: ${patchKey}.`,
        patchKey
      });
    }

    proposalByKey.set(patchKey, proposal);
    indexByKey.set(patchKey, index);
  });

  for (const proposal of proposals) {
    const patchKey = proposal.patch_key as string;
    const dependencies = proposal.depends_on as string[];
    const uniqueDependencies = new Set<string>();

    for (const dependencyKey of dependencies) {
      if (uniqueDependencies.has(dependencyKey)) {
        throw new PatchDependencyValidationError({
          code: "duplicate_dependency_reference",
          dependencyKey,
          message: `Patch ${patchKey} lists dependency ${dependencyKey} more than once.`,
          patchKey
        });
      }
      uniqueDependencies.add(dependencyKey);

      if (dependencyKey === patchKey) {
        throw new PatchDependencyValidationError({
          code: "self_patch_dependency",
          dependencyKey,
          message: `Patch ${patchKey} cannot depend on itself.`,
          patchKey
        });
      }

      const dependency = proposalByKey.get(dependencyKey);

      if (!dependency) {
        throw new PatchDependencyValidationError({
          code: "missing_patch_dependency",
          dependencyKey,
          message: `Patch ${patchKey} references missing dependency ${dependencyKey}.`,
          patchKey
        });
      }

      if (dependency.comment_id !== proposal.comment_id) {
        throw new PatchDependencyValidationError({
          code: "cross_comment_dependency",
          dependencyKey,
          message:
            "Patch dependencies must remain within the same comment_id.",
          patchKey
        });
      }
    }
  }

  return { indexByKey, proposalByKey };
}

function validateDependencyCycles(graph: DependencyGraph): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const patchKey of sortGraphKeys(graph.proposalByKey.keys(), graph)) {
    visitForCycle(patchKey, graph, visiting, visited);
  }
}

function visitForCycle(
  patchKey: string,
  graph: DependencyGraph,
  visiting: Set<string>,
  visited: Set<string>
): void {
  if (visited.has(patchKey)) {
    return;
  }

  if (visiting.has(patchKey)) {
    throw new PatchDependencyValidationError({
      code: "patch_dependency_cycle",
      message: `Patch dependency cycle detected at ${patchKey}.`,
      patchKey
    });
  }

  visiting.add(patchKey);
  const proposal = graph.proposalByKey.get(patchKey);

  for (const dependencyKey of sortGraphKeys(
    proposal?.depends_on ?? [],
    graph
  )) {
    visitForCycle(dependencyKey, graph, visiting, visited);
  }

  visiting.delete(patchKey);
  visited.add(patchKey);
}

function visitDependencyClosure(
  patchKey: string,
  graph: DependencyGraph,
  visited: Set<string>,
  order: string[]
): void {
  if (visited.has(patchKey)) {
    return;
  }

  const proposal = graph.proposalByKey.get(patchKey);

  if (!proposal) {
    throw new PatchDependencyValidationError({
      code: "missing_patch_dependency",
      dependencyKey: patchKey,
      message: `Missing patch dependency ${patchKey}.`
    });
  }

  for (const dependencyKey of sortGraphKeys(
    proposal.depends_on ?? [],
    graph
  )) {
    visitDependencyClosure(dependencyKey, graph, visited, order);
  }

  visited.add(patchKey);
  order.push(patchKey);
}

function sortGraphKeys(
  keys: Iterable<string>,
  graph: DependencyGraph
): string[] {
  return [...keys].sort(
    (first, second) =>
      (graph.indexByKey.get(first) ?? Number.MAX_SAFE_INTEGER) -
        (graph.indexByKey.get(second) ?? Number.MAX_SAFE_INTEGER) ||
      first.localeCompare(second)
  );
}

function getPersistedDependencyClosureOrder(
  patch: PatchmarkPatch,
  importedById: Map<string, PatchmarkPatch>,
  importedIndexById: Map<string, number>
): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (patchId: string) => {
    if (visited.has(patchId)) {
      return;
    }
    if (visiting.has(patchId)) {
      throw new PatchDependencyValidationError({
        code: "patch_dependency_cycle",
        message: `Patch dependency cycle detected at ${patchId}.`,
        patchKey: patch.source_patch_key
      });
    }

    const current = importedById.get(patchId);
    if (!current) {
      throw new PatchDependencyValidationError({
        code: "missing_patch_dependency",
        dependencyKey: patchId,
        message: `Missing imported patch dependency ${patchId}.`,
        patchKey: patch.source_patch_key
      });
    }

    visiting.add(patchId);
    for (const dependencyId of sortPersistedDependencyIds(
      current.depends_on_patch_ids ?? [],
      importedById,
      importedIndexById
    )) {
      visit(dependencyId);
    }
    visiting.delete(patchId);
    visited.add(patchId);
    order.push(patchId);
  };

  for (const dependencyId of sortPersistedDependencyIds(
    patch.depends_on_patch_ids ?? [],
    importedById,
    importedIndexById
  )) {
    visit(dependencyId);
  }

  return order;
}

function sortPersistedDependencyIds(
  dependencyIds: string[],
  importedById: Map<string, PatchmarkPatch>,
  importedIndexById: Map<string, number>
): string[] {
  return [...dependencyIds].sort(
    (first, second) =>
      (importedIndexById.get(first) ?? Number.MAX_SAFE_INTEGER) -
        (importedIndexById.get(second) ?? Number.MAX_SAFE_INTEGER) ||
      (importedById.get(first)?.source_patch_key ?? first).localeCompare(
        importedById.get(second)?.source_patch_key ?? second
      )
  );
}

function collectPersistedDependencyClosure(
  patch: PatchmarkPatch,
  byId: Map<string, PatchmarkPatch>
): { cycleDetected: boolean; ids: string[]; invalidIds: Set<string> } {
  const ids: string[] = [];
  const invalidIds = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  let cycleDetected = false;

  const visit = (patchId: string) => {
    if (visited.has(patchId)) {
      return;
    }
    if (visiting.has(patchId)) {
      cycleDetected = true;
      return;
    }

    visiting.add(patchId);
    const current = byId.get(patchId);

    if (
      !current ||
      !isValidPersistedDependencyOwnership({
        dependency: current,
        owner: patch
      })
    ) {
      invalidIds.add(patchId);
    } else {
      for (const dependencyId of current.depends_on_patch_ids ?? []) {
        visit(dependencyId);
      }
    }

    visiting.delete(patchId);
    visited.add(patchId);
    ids.push(patchId);
  };

  for (const dependencyId of patch.depends_on_patch_ids ?? []) {
    visit(dependencyId);
  }

  return { cycleDetected, ids, invalidIds };
}

function isValidPersistedDependencyOwnership({
  dependency,
  expectedKey,
  owner
}: {
  dependency: PatchmarkPatch;
  expectedKey?: string;
  owner: PatchmarkPatch;
}): boolean {
  return (
    Boolean(owner.source_import_id) &&
    dependency.source_import_id === owner.source_import_id &&
    dependency.comment_id === owner.comment_id &&
    (!expectedKey || dependency.source_patch_key === expectedKey)
  );
}

function createSimulationTargetError({
  appliedPrerequisites,
  baseDocumentState,
  dependentPatch,
  failedPatch,
  kind,
  prerequisite
}: {
  appliedPrerequisites: PatchmarkPatch[];
  baseDocumentState: PatchDependencyBaseDocumentState;
  dependentPatch: PatchmarkPatch;
  failedPatch: PatchmarkPatch;
  kind: "ambiguous" | "not_found" | "stale";
  prerequisite: boolean;
}): PatchDependencyValidationError {
  const overlapsAppliedPrerequisite =
    prerequisite &&
    appliedPrerequisites.some(
      (appliedPatch) =>
        appliedPatch.original_text.includes(failedPatch.original_text) ||
        failedPatch.original_text.includes(appliedPatch.original_text)
    );
  const dependentKey =
    dependentPatch.source_patch_key ?? dependentPatch.id;
  const failedKey = failedPatch.source_patch_key ?? failedPatch.id;

  if (!prerequisite && appliedPrerequisites.length === 0) {
    const exportedBase = baseDocumentState === "current";
    const code: PatchDependencyErrorCode =
      kind === "ambiguous"
        ? exportedBase
          ? "exported_document_patch_target_ambiguous"
          : "current_document_patch_target_ambiguous"
        : exportedBase
          ? "exported_document_patch_target_missing"
          : "current_document_patch_target_missing";
    const message =
      kind === "ambiguous"
        ? exportedBase
          ? `Patch ${dependentKey} could not be validated because its target is ambiguous in the document exported with this Review Batch.`
          : `Patch ${dependentKey} could not be validated because its target is ambiguous in the current saved document.${baseDocumentState === "changed" ? " The document changed after the prompt was exported." : ""}`
        : exportedBase
          ? `Patch ${dependentKey} does not match the document state exported with this Review Batch.`
          : `Patch ${dependentKey} no longer matches the current saved document.${baseDocumentState === "changed" ? " The document changed after the prompt was exported." : ""}`;

    return new PatchDependencyValidationError({
      code,
      message,
      patchKey: dependentPatch.source_patch_key,
      repairPromptEligible: exportedBase
    });
  }

  if (!prerequisite) {
    const prerequisiteKeys = appliedPrerequisites.map(
      (appliedPatch) => appliedPatch.source_patch_key ?? appliedPatch.id
    );
    const lastPrerequisite = prerequisiteKeys.at(-1);

    return new PatchDependencyValidationError({
      code:
        kind === "ambiguous"
          ? "dependent_patch_target_ambiguous_after_prerequisites"
          : "dependent_patch_stale_after_prerequisites",
      dependencyKey: lastPrerequisite,
      message:
        kind === "ambiguous"
          ? `Patch ${dependentKey} could not be validated because its target is ambiguous after declared prerequisite${prerequisiteKeys.length === 1 ? "" : "s"} ${prerequisiteKeys.join(", ")} ${prerequisiteKeys.length === 1 ? "was" : "were"} applied.`
          : `Patch ${dependentKey} became stale after declared prerequisite${prerequisiteKeys.length === 1 ? "" : "s"} ${prerequisiteKeys.join(", ")} changed its target.`,
      patchKey: dependentPatch.source_patch_key
    });
  }

  const code: PatchDependencyErrorCode =
    kind === "ambiguous"
      ? "dependency_patch_target_ambiguous"
      : kind === "stale" || overlapsAppliedPrerequisite
        ? "dependency_patch_overlap_conflict"
        : "dependency_patch_target_missing";

  return new PatchDependencyValidationError({
    code,
    dependencyKey: failedPatch.source_patch_key,
    message:
      kind === "ambiguous"
        ? `Declared prerequisite ${failedKey} has an ambiguous target before ${dependentKey} can be validated.`
        : `Declared prerequisite ${failedKey} cannot be applied deterministically before ${dependentKey}.`,
    patchKey: dependentPatch.source_patch_key
  });
}

function validateSimulatedPatchSources({
  appliedPrerequisites,
  finalMarkdown,
  patch
}: {
  appliedPrerequisites: PatchmarkPatch[];
  finalMarkdown: string;
  patch: PatchmarkPatch;
}): void {
  let initialSourceError: SourceReferenceValidationError | null = null;

  try {
    validateSuggestedTextReferenceDates({
      originalText: patch.original_text,
      sources: patch.suggested_text_sources ?? [],
      suggestedText: patch.suggested_text
    });
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !SOURCE_DATE_ERRORS.has(error.message)
    ) {
      throw error;
    }

    initialSourceError =
      error instanceof SourceReferenceValidationError ? error : null;

    if (appliedPrerequisites.length === 0) {
      throw createDependencySourceDateCoverageError({
        error: initialSourceError ?? error,
        patch,
        status: "absent"
      });
    }
  }

  const coverageMarkdown = getRelevantPrerequisiteCoverage({
    appliedPrerequisites,
    finalMarkdown,
    patch
  });

  try {
    validateSuggestedTextReferenceDatesWithCoverage({
      coverageMarkdown,
      originalText: patch.original_text,
      sources: patch.suggested_text_sources ?? [],
      suggestedText: patch.suggested_text
    });
  } catch (error) {
    throw createDependencySourceDateCoverageError({
      error:
        error instanceof SourceReferenceValidationError
          ? error
          : initialSourceError ?? error,
      patch,
      status: coverageMarkdown ? "invalid" : "unrelated"
    });
  }
}

function createDependencySourceDateCoverageError({
  error,
  patch,
  status
}: {
  error: unknown;
  patch: PatchmarkPatch;
  status: "absent" | "invalid" | "unrelated";
}): PatchDependencyValidationError {
  const sourceError =
    error instanceof SourceReferenceValidationError ? error : null;
  const patchKey = patch.source_patch_key ?? patch.id;
  const sourceDetails = sourceError
    ? ` Source ${sourceError.sourceUrl}${
        sourceError.observedAt
          ? ` requires observation date ${sourceError.observedAt}`
          : ""
      }.`
    : "";
  const statusDetails =
    status === "absent"
      ? " No disclosure prerequisite is declared."
      : status === "unrelated"
        ? " The declared prerequisites do not add disclosure coverage in the same or a containing section."
        : " The declared prerequisite disclosure does not match the source date metadata.";

  return new PatchDependencyValidationError({
    code: "dependency_source_date_coverage_failed",
    disclosurePrerequisiteStatus: status,
    message: `Patch ${patchKey} failed dependency-aware source-date validation.${sourceDetails}${statusDetails}`,
    observedAt: sourceError?.observedAt,
    patchKey: patch.source_patch_key,
    sourceUrl: sourceError?.sourceUrl
  });
}

function getRelevantPrerequisiteCoverage({
  appliedPrerequisites,
  finalMarkdown,
  patch
}: {
  appliedPrerequisites: PatchmarkPatch[];
  finalMarkdown: string;
  patch: PatchmarkPatch;
}): string {
  const targetRange = getMarkdownHeadingSectionRange(
    finalMarkdown,
    patch.target_heading
  );

  if (!targetRange || !normalizeMarkdownHeading(patch.target_heading)) {
    return "";
  }

  return appliedPrerequisites
    .filter((prerequisite) => {
      const prerequisiteRange = getMarkdownHeadingSectionRange(
        finalMarkdown,
        prerequisite.target_heading
      );

      if (
        !prerequisiteRange ||
        prerequisiteRange.start > targetRange.start ||
        prerequisiteRange.end < targetRange.end ||
        prerequisite.suggested_text.trim().length === 0
      ) {
        return false;
      }

      const prerequisiteSection = finalMarkdown.slice(
        prerequisiteRange.start,
        prerequisiteRange.end
      );

      return prerequisiteSection.includes(prerequisite.suggested_text.trim());
    })
    .map((prerequisite) => prerequisite.suggested_text)
    .join("\n");
}

function validateSimulatedSourcePreservation({
  finalMarkdown,
  patch
}: {
  finalMarkdown: string;
  patch: PatchmarkPatch;
}): void {
  if (
    patch.suggested_text.trim().length > 0 ||
    !SOURCE_SECTION_HEADING_PATTERN.test(
      `${patch.target_heading ?? ""}\n${patch.original_text}`
    )
  ) {
    return;
  }

  const requiredUrls = new Set(
    Array.from(patch.original_text.matchAll(VISIBLE_URL_PATTERN), (match) =>
      normalizeVisibleUrl(match[0])
    )
  );
  const preservedUrls = new Set(
    Array.from(finalMarkdown.matchAll(VISIBLE_URL_PATTERN), (match) =>
      normalizeVisibleUrl(match[0])
    )
  );
  const missingUrls = [...requiredUrls].filter(
    (url) => !preservedUrls.has(url)
  );

  if (missingUrls.length > 0) {
    throw new PatchDependencyValidationError({
      code: "dependency_source_preservation_failed",
      message: `Deleting the source section would remove ${missingUrls.length} visible source URL${missingUrls.length === 1 ? "" : "s"}; first missing source: ${missingUrls[0]}.`,
      patchKey: patch.source_patch_key,
      sourceUrl: missingUrls[0]
    });
  }
}

function normalizeVisibleUrl(url: string): string {
  return url.replace(/\\&/g, "&").replace(/[.,;:!?]+$/, "");
}
