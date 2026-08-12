"use client";

import { useMemo, useState } from "react";
import {
  analyzeLegacyProjectIdentityCompatibility,
  cleanupIncompleteLegacyProjectAssembly,
  createLegacyProjectAssemblyPlan,
  createSuggestedLegacyDocumentPath,
  executeLegacyProjectAssembly,
  inspectIncompleteLegacyProjectAssembly,
  pickLegacyProjectAssemblyDestination,
  pickLegacyProjectAssemblySource,
  type LegacyProjectAssemblyPlan,
  type IncompleteLegacyProjectAssembly,
  type LegacyProjectAssemblySource
} from "@/lib/project/legacy-project-assembly.ts";
import {
  type PatchmarkDocumentRole,
  type ProjectDirectoryHandle
} from "@/lib/project/multi-document-project.ts";
import { type LoadedPatchmarkProject } from "@/lib/project/patchmark-project.ts";

type ConfiguredSource = {
  source: LegacyProjectAssemblySource;
  destinationPath: string;
  displayTitle: string;
  role: PatchmarkDocumentRole;
};

type AssemblyStep = "sources" | "configure" | "review";

export function LegacyProjectAssemblyDialog({
  onClose,
  onComplete
}: {
  onClose: () => void;
  onComplete: (loaded: LoadedPatchmarkProject) => void;
}) {
  const [step, setStep] = useState<AssemblyStep>("sources");
  const [sources, setSources] = useState<ConfiguredSource[]>([]);
  const [projectTitle, setProjectTitle] = useState("");
  const [destination, setDestination] =
    useState<ProjectDirectoryHandle | null>(null);
  const [incompleteAssembly, setIncompleteAssembly] =
    useState<IncompleteLegacyProjectAssembly | null>(null);
  const [plan, setPlan] = useState<LegacyProjectAssemblyPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const identityAnalysis = useMemo(
    () =>
      analyzeLegacyProjectIdentityCompatibility(
        sources.map(({ source }) => source)
      ),
    [sources]
  );
  const allowedDuplicates = identityAnalysis.allowedDocumentLocalDuplicates;
  const unsafeCollisions = identityAnalysis.unsafeCollisions;
  const totals = useMemo(
    () =>
      sources.reduce(
        (result, { source }) => ({
          comments: result.comments + source.summary.comments,
          patches: result.patches + source.summary.patches,
          replies: result.replies + source.summary.replies,
          versions: result.versions + source.summary.versions
        }),
        { comments: 0, patches: 0, replies: 0, versions: 0 }
      ),
    [sources]
  );

  async function handleAddSource() {
    setError(null);
    setIsBusy(true);
    try {
      const source = await pickLegacyProjectAssemblySource();
      if (!source) {
        return;
      }
      for (const configured of sources) {
        if (
          configured.source.directoryHandle.isSameEntry &&
          (await configured.source.directoryHandle.isSameEntry(
            source.directoryHandle
          ))
        ) {
          throw new Error("The same source project cannot be selected twice.");
        }
      }
      const usedPaths = sources.map(({ destinationPath }) => destinationPath);
      setSources((current) => [
        ...current,
        {
          source,
          destinationPath: createSuggestedLegacyDocumentPath(source, usedPaths),
          displayTitle: source.summary.suggestedDisplayTitle,
          role: null
        }
      ]);
      setProjectTitle((current) => current || source.summary.sourceProjectName);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleChooseDestination() {
    setError(null);
    setIsBusy(true);
    try {
      const selected = await pickLegacyProjectAssemblyDestination();
      if (selected) {
        setDestination(selected);
        setIncompleteAssembly(
          await inspectIncompleteLegacyProjectAssembly(selected)
        );
      }
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCleanupIncompleteAssembly() {
    if (!destination || !incompleteAssembly) {
      return;
    }
    setError(null);
    setIsBusy(true);
    try {
      await cleanupIncompleteLegacyProjectAssembly(destination);
      setIncompleteAssembly(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleReview() {
    if (!destination) {
      setError("Choose an empty destination folder.");
      return;
    }
    setError(null);
    setIsBusy(true);
    try {
      const nextPlan = await createLegacyProjectAssemblyPlan({
        destination,
        projectTitle,
        documents: sources.map((configured) => ({
          source: configured.source,
          destinationPath: configured.destinationPath,
          displayTitle: configured.displayTitle,
          role: configured.role
        }))
      });
      setPlan(nextPlan);
      setStep("review");
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreate() {
    if (!plan) {
      return;
    }
    setError(null);
    setIsBusy(true);
    setProgress("Revalidating sources…");
    try {
      const result = await executeLegacyProjectAssembly(plan, {
        onStage({ stage, sourceLabel }) {
          setProgress(getStageLabel(stage, sourceLabel));
        }
      });
      onComplete(result.loaded);
    } catch (caught) {
      setError(getErrorMessage(caught));
      setProgress(null);
    } finally {
      setIsBusy(false);
    }
  }

  function updateSource(index: number, changes: Partial<ConfiguredSource>) {
    setSources((current) =>
      current.map((configured, sourceIndex) =>
        sourceIndex === index ? { ...configured, ...changes } : configured
      )
    );
  }

  function moveSource(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sources.length) {
      return;
    }
    setSources((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <div className="snapshot-dialog-backdrop workspace-dialog-backdrop legacy-assembly-backdrop">
      <section
        className="legacy-assembly-dialog workspace-dialog-surface"
        aria-label="Create project from existing Patchmark projects"
        aria-modal="true"
        role="dialog"
      >
        <header className="snapshot-dialog-header">
          <div>
            <span>Project creation</span>
            <h2>Create project from existing Patchmark projects</h2>
            <p>
              Copy two or more legacy projects into independent document stores.
              Source projects remain unchanged.
            </p>
          </div>
          <button type="button" disabled={isBusy} onClick={onClose}>
            Cancel
          </button>
        </header>

        <ol className="legacy-assembly-steps" aria-label="Assembly steps">
          <li aria-current={step === "sources" ? "step" : undefined}>
            1. Sources
          </li>
          <li aria-current={step === "configure" ? "step" : undefined}>
            2. Configure
          </li>
          <li aria-current={step === "review" ? "step" : undefined}>
            3. Review
          </li>
        </ol>

        <div className="legacy-assembly-body">
          {error ? (
            <div className="legacy-assembly-error" role="alert">
              <strong>Assembly blocked</strong>
              <p>{error}</p>
            </div>
          ) : null}

          {step === "sources" ? (
            <>
              <div className="legacy-assembly-section-heading">
                <div>
                  <h3>Validated legacy sources</h3>
                  <p>Add at least two single-document Patchmark projects.</p>
                </div>
                <button type="button" disabled={isBusy} onClick={handleAddSource}>
                  {isBusy ? "Validating…" : "Add Source Project"}
                </button>
              </div>
              <div className="legacy-source-list">
                {sources.length === 0 ? (
                  <p className="legacy-assembly-empty">
                    No source projects selected yet.
                  </p>
                ) : (
                  sources.map(({ source }, index) => (
                    <article className="legacy-source-card" key={source.sourceId}>
                      <div className="legacy-source-card-header">
                        <div>
                          <span>Ready to import</span>
                          <h4>{source.summary.sourceProjectName}</h4>
                          <small>Folder: {source.summary.sourceLabel}</small>
                        </div>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            setSources((current) =>
                              current.filter((_, sourceIndex) => sourceIndex !== index)
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                      <dl className="legacy-source-counts">
                        <div><dt>Document</dt><dd>document.md</dd></div>
                        <div><dt>Comments</dt><dd>{source.summary.comments}</dd></div>
                        <div><dt>Replies</dt><dd>{source.summary.replies}</dd></div>
                        <div><dt>Patches</dt><dd>{source.summary.patches}</dd></div>
                        <div><dt>Versions</dt><dd>{source.summary.versions}</dd></div>
                        <div><dt>Generation</dt><dd>{source.summary.saveGeneration}</dd></div>
                      </dl>
                      {source.summary.warnings.length > 0 ? (
                        <details className="legacy-source-warnings">
                          <summary>
                            {source.summary.warnings.length} preserved legacy warning
                            {source.summary.warnings.length === 1 ? "" : "s"}
                          </summary>
                          <ul>
                            {source.summary.warnings.map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
              {allowedDuplicates.length > 0 ? (
                <div className="legacy-assembly-compatible-duplicates" role="status">
                  <strong>
                    {allowedDuplicates.length} document-local duplicate ID
                    {allowedDuplicates.length === 1 ? "" : "s"}
                  </strong>
                  <p>
                    {formatAllowedDuplicateSummary(allowedDuplicates)}. The
                    duplicate IDs belong to separate documents and are safely
                    isolated.
                  </p>
                </div>
              ) : null}
              {unsafeCollisions.length > 0 ? (
                <div className="legacy-assembly-collision" role="status">
                  {unsafeCollisions.length} unsafe identity collision
                  {unsafeCollisions.length === 1 ? "" : "s"} detected. Resolve
                  source IDs outside this flow before assembly.
                </div>
              ) : null}
            </>
          ) : null}

          {step === "configure" ? (
            <>
              <div className="legacy-assembly-project-fields">
                <label>
                  <span>Destination project title</span>
                  <input
                    disabled={isBusy}
                    maxLength={240}
                    value={projectTitle}
                    onChange={(event) => setProjectTitle(event.target.value)}
                  />
                </label>
                <div>
                  <span>Destination folder</span>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={handleChooseDestination}
                  >
                    {destination
                      ? `Selected: ${destination.name}`
                      : "Choose Empty Folder"}
                  </button>
                </div>
              </div>
              {incompleteAssembly ? (
                <div className="legacy-incomplete-assembly" role="status">
                  <div>
                    <strong>Incomplete Patchmark assembly detected</strong>
                    <p>
                      {incompleteAssembly.destinationTitle} stopped at{" "}
                      {incompleteAssembly.stage}. Clean its generated files before
                      retrying.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isBusy || !incompleteAssembly.canCleanSafely}
                    onClick={() => void handleCleanupIncompleteAssembly()}
                  >
                    {incompleteAssembly.canCleanSafely
                      ? "Clean Incomplete Assembly"
                      : "Unexpected Files Require Manual Review"}
                  </button>
                </div>
              ) : null}
              <div className="legacy-configured-list">
                {sources.map((configured, index) => (
                  <article className="legacy-configured-card" key={configured.source.sourceId}>
                    <header>
                      <div>
                        <span>Document {index + 1}</span>
                        <strong>{configured.source.summary.sourceProjectName}</strong>
                      </div>
                      <div className="legacy-order-actions">
                        <button
                          type="button"
                          disabled={isBusy || index === 0}
                          onClick={() => moveSource(index, -1)}
                        >
                          Move Up
                        </button>
                        <button
                          type="button"
                          disabled={isBusy || index === sources.length - 1}
                          onClick={() => moveSource(index, 1)}
                        >
                          Move Down
                        </button>
                      </div>
                    </header>
                    <div className="legacy-document-fields">
                      <label>
                        <span>Display title</span>
                        <input
                          disabled={isBusy}
                          maxLength={240}
                          value={configured.displayTitle}
                          onChange={(event) =>
                            updateSource(index, { displayTitle: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>Destination filename</span>
                        <input
                          disabled={isBusy}
                          value={configured.destinationPath}
                          onChange={(event) =>
                            updateSource(index, { destinationPath: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>Role</span>
                        <select
                          disabled={isBusy}
                          value={configured.role ?? ""}
                          onChange={(event) =>
                            updateSource(index, {
                              role: (event.target.value || null) as PatchmarkDocumentRole
                            })
                          }
                        >
                          <option value="">None</option>
                          <option value="decision">Decision</option>
                          <option value="research">Research</option>
                          <option value="evidence">Evidence</option>
                          <option value="summary">Summary</option>
                        </select>
                      </label>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}

          {step === "review" && plan ? (
            <div className="legacy-assembly-review">
              <div className="legacy-assembly-review-summary">
                <span>Create project</span>
                <h3>{plan.manifest.title}</h3>
                <p>
                  {plan.entries.length} documents · {totals.comments} comments ·{" "}
                  {totals.replies} replies · {totals.patches} patch proposals ·{" "}
                  {totals.versions} versions
                </p>
                <strong>{unsafeCollisions.length} unsafe collisions</strong>
                {allowedDuplicates.length > 0 ? (
                  <p>
                    {formatAllowedDuplicateSummary(allowedDuplicates)}. These
                    local IDs remain unchanged and are isolated by destination
                    document ownership.
                  </p>
                ) : (
                  <p>No document-local duplicate IDs detected.</p>
                )}
              </div>
              <ol className="legacy-review-documents">
                {plan.entries.map((entry) => (
                  <li key={entry.document.document_id}>
                    <div>
                      <strong>{entry.document.display_title}</strong>
                      <span>{entry.source.summary.sourceProjectName}</span>
                    </div>
                    <code>{entry.document.path}</code>
                    <span>{entry.document.role ?? "No role"}</span>
                  </li>
                ))}
              </ol>
              <div className="legacy-assembly-source-promise">
                The source projects will remain unchanged. The destination is a
                true portable copy with new project and document identities.
              </div>
              {progress ? <p className="legacy-assembly-progress">{progress}</p> : null}
            </div>
          ) : null}
        </div>

        <footer className="legacy-assembly-actions">
          {step !== "sources" ? (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => {
                setError(null);
                setProgress(null);
                setPlan(null);
                setStep(step === "review" ? "configure" : "sources");
              }}
            >
              Back
            </button>
          ) : <span />}
          {step === "sources" ? (
            <button
              className="document-action-primary"
              type="button"
              disabled={
                isBusy || sources.length < 2 || unsafeCollisions.length > 0
              }
              onClick={() => {
                setError(null);
                setStep("configure");
              }}
            >
              Configure Destination
            </button>
          ) : null}
          {step === "configure" ? (
            <button
              className="document-action-primary"
              type="button"
              disabled={
                isBusy ||
                !destination ||
                !projectTitle.trim() ||
                Boolean(incompleteAssembly)
              }
              onClick={() => void handleReview()}
            >
              Review Assembly
            </button>
          ) : null}
          {step === "review" ? (
            <button
              className="document-action-primary"
              type="button"
              disabled={isBusy}
              onClick={() => void handleCreate()}
            >
              {isBusy ? "Creating Project…" : "Create Project"}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function getStageLabel(stage: string, sourceLabel?: string): string {
  switch (stage) {
    case "preflight":
      return "Preflight complete. Creating incomplete destination…";
    case "staging":
      return "Staging destination document stores…";
    case "before_source_copy":
      return `Revalidating ${sourceLabel ?? "source"}…`;
    case "source_copied":
      return `Copied and verified ${sourceLabel ?? "source"}.`;
    case "verified":
      return "All staged documents verified. Committing manifest…";
    case "manifest_committed":
      return "Project committed. Reopening through the normal loader…";
    case "reopened":
      return "Destination reopened. Verifying source immutability…";
    case "sources_verified":
      return "Sources unchanged. Completing transaction…";
    case "complete":
      return "Assembly complete.";
    default:
      return "Creating project…";
  }
}

function formatAllowedDuplicateSummary(
  duplicates: readonly { namespace: string }[]
): string {
  const counts = new Map<string, number>();
  for (const duplicate of duplicates) {
    counts.set(
      duplicate.namespace,
      (counts.get(duplicate.namespace) ?? 0) + 1
    );
  }
  return [...counts]
    .map(([namespace, count]) =>
      `${count} document-local duplicate ${namespace.replaceAll("_", " ")} ID${
        count === 1 ? "" : "s"
      }`
    )
    .join(", ");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
