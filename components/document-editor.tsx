"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CommentsPanel,
  type CommentFormValues
} from "@/components/comments-panel";
import { DocumentActions } from "@/components/document-actions";
import { MarkdownFileLoader } from "@/components/markdown-file-loader";
import { MarkdownSourceEditor } from "@/components/markdown-source-editor";
import { DocumentOutline } from "@/components/document-outline";
import { DocumentStatus, type DocumentStatusKind } from "@/components/document-status";
import { DraftRestoreBanner } from "@/components/draft-restore-banner";
import {
  SnapshotDialog,
  type SnapshotDialogState
} from "@/components/snapshot-dialog";
import { VersionHistoryPanel } from "@/components/version-history-panel";
import { VisualMarkdownEditor } from "@/components/visual-markdown-editor";
import { downloadMarkdown } from "@/lib/files/download-markdown";
import {
  canSaveMarkdownFilePicker,
  saveMarkdownAsFile,
  saveMarkdownToFileHandle,
  type LoadedMarkdownFile,
  type MarkdownFileHandle
} from "@/lib/files/file-system-access";
import { parseMarkdownHeadings } from "@/lib/markdown/parse-headings";
import {
  canOpenProjectFolder,
  createProjectFromMarkdown,
  createProjectSnapshot,
  listProjectVersions,
  openProjectFolder,
  readProjectVersionMarkdown,
  readProjectComments,
  saveProjectDocument,
  writeProjectComments,
  type LoadedPatchmarkProject,
  type PatchmarkProjectHandle
} from "@/lib/project/patchmark-project";
import {
  type PatchmarkComment,
  type PatchmarkVersionEntry
} from "@/lib/project/project-types";
import {
  deleteDocumentDraft,
  readMostRecentDocumentDraft,
  saveDocumentDraft,
  type DocumentDraft
} from "@/lib/storage/document-draft-storage";

type EditorMode = "visual" | "markdown";
type SaveStatus = "idle" | "saving" | "failed" | "unavailable";
type SaveFeedback = {
  kind: "success" | "error" | "info";
  message: string;
};

export function DocumentEditor() {
  const [fileName, setFileName] = useState<string | null>(null);
  // Markdown is the source of truth across both editing modes.
  const [markdown, setMarkdown] = useState("");
  const [baselineMarkdown, setBaselineMarkdown] = useState<string | null>(null);
  const [activeFileHandle, setActiveFileHandle] =
    useState<MarkdownFileHandle | null>(null);
  const [projectHandle, setProjectHandle] =
    useState<PatchmarkProjectHandle | null>(null);
  const [restoredMarkdown, setRestoredMarkdown] = useState<string | null>(null);
  const [availableDraft, setAvailableDraft] = useState<DocumentDraft | null>(null);
  const [mode, setMode] = useState<EditorMode>("visual");
  const [documentVersion, setDocumentVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const [versionEntries, setVersionEntries] = useState<PatchmarkVersionEntry[]>(
    []
  );
  const [comments, setComments] = useState<PatchmarkComment[]>([]);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [isCommentBusy, setIsCommentBusy] = useState(false);
  const [snapshotDialog, setSnapshotDialog] =
    useState<SnapshotDialogState | null>(null);

  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);
  const isDirty =
    fileName !== null &&
    (baselineMarkdown === null || markdown !== baselineMarkdown);
  const isSaving = saveStatus === "saving";
  const isProjectMode = projectHandle !== null;
  const documentStatus: DocumentStatusKind = getDocumentStatus({
    isDirty,
    markdown,
    restoredMarkdown,
    saveStatus
  });

  useEffect(() => {
    setAvailableDraft(readMostRecentDocumentDraft());
  }, []);

  useEffect(() => {
    let isCancelled = false;

    if (!projectHandle) {
      setVersionEntries([]);
      setComments([]);
      setCommentsError(null);
      return;
    }

    void listProjectVersions(projectHandle).then((versions) => {
      if (!isCancelled) {
        setVersionEntries(versions);
      }
    });

    void readProjectComments(projectHandle)
      .then((projectComments) => {
        if (!isCancelled) {
          setComments(projectComments);
          setCommentsError(null);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setComments([]);
          setCommentsError(getProjectErrorMessage(error));
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [projectHandle]);

  useEffect(() => {
    if (!fileName) {
      return;
    }

    saveDocumentDraft({
      fileName,
      markdown,
      updatedAt: new Date().toISOString()
    });
  }, [fileName, markdown]);

  useEffect(() => {
    if (!isDirty) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const handleSaveChanges = useCallback(async () => {
    if (!fileName || isSaving) {
      return;
    }

    if (typeof markdown !== "string") {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: "Save failed because Markdown content is invalid."
      });
      return;
    }

    if (projectHandle) {
      setSaveStatus("saving");
      setSaveFeedback(null);

      try {
        const nextProjectHandle = await saveProjectDocument(
          projectHandle,
          markdown
        );
        setProjectHandle(nextProjectHandle);
        setBaselineMarkdown(markdown);
        setRestoredMarkdown(null);
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message: "Saved changes to project document.md."
        });
      } catch (error) {
        setSaveStatus("failed");
        setSaveFeedback({
          kind: "error",
          message: getSaveErrorMessage(error)
        });
      }

      return;
    }

    if (!activeFileHandle) {
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "error",
        message:
          "Direct save is not available for this document. Use Save As or Download .md instead."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      await saveMarkdownToFileHandle(activeFileHandle, markdown);
      setBaselineMarkdown(markdown);
      setRestoredMarkdown(null);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Saved changes to the Markdown file."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getSaveErrorMessage(error)
      });
    }
  }, [activeFileHandle, fileName, isSaving, markdown, projectHandle]);

  useEffect(() => {
    if (!fileName) {
      return;
    }

    function handleSaveShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveChanges();
      }
    }

    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [fileName, handleSaveChanges]);

  function handleFileLoaded(loadedFile: LoadedMarkdownFile) {
    setFileName(loadedFile.fileName);
    setMarkdown(loadedFile.markdown);
    setBaselineMarkdown(loadedFile.markdown);
    setActiveFileHandle(loadedFile.fileHandle);
    setProjectHandle(null);
    setRestoredMarkdown(null);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSaveFeedback(null);
    setSnapshotDialog(null);
    setComments([]);
    setCommentsError(null);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  function handleRestoreDraft() {
    if (!availableDraft) {
      return;
    }

    setFileName(availableDraft.fileName);
    setMarkdown(availableDraft.markdown);
    setBaselineMarkdown(null);
    setActiveFileHandle(null);
    setProjectHandle(null);
    setRestoredMarkdown(availableDraft.markdown);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSaveFeedback(null);
    setSnapshotDialog(null);
    setComments([]);
    setCommentsError(null);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  function handleDiscardDraft() {
    if (!availableDraft) {
      return;
    }

    deleteDocumentDraft(availableDraft.fileName);
    setAvailableDraft(null);
  }

  function handleMarkdownChange(nextMarkdown: string) {
    setMarkdown(nextMarkdown);

    if (saveStatus !== "saving") {
      setSaveStatus("idle");
      setSaveFeedback(null);
    }
  }

  async function handleSaveAs() {
    if (!fileName || isSaving) {
      return;
    }

    if (typeof markdown !== "string") {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: "Save failed because Markdown content is invalid."
      });
      return;
    }

    if (!canSaveMarkdownFilePicker()) {
      downloadMarkdown(fileName, markdown);
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "info",
        message:
          "Direct Save As is not available in this browser. Downloaded a Markdown copy instead."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const fileHandle = await saveMarkdownAsFile(fileName, markdown);

      if (!fileHandle) {
        setSaveStatus("idle");
        return;
      }

      if (projectHandle) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "success",
          message:
            "Saved an exported Markdown copy. The project folder remains active."
        });
        return;
      }

      setActiveFileHandle(fileHandle);
      setFileName(fileHandle.name);
      setBaselineMarkdown(markdown);
      setRestoredMarkdown(null);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Saved Markdown to the selected file."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getSaveErrorMessage(error)
      });
    }
  }

  function handleDownload() {
    setSaveFeedback({
      kind: "info",
      message: "Downloaded a Markdown copy. Save status is unchanged."
    });
  }

  async function handleOpenProjectFolder() {
    if (isSaving) {
      return;
    }

    if (!canOpenProjectFolder()) {
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "info",
        message:
          "Project folders require a browser with File System Access API support. You can continue using Single File Mode."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const loadedProject = await openProjectFolder();

      if (!loadedProject) {
        setSaveStatus("idle");
        return;
      }

      loadProjectIntoEditor(loadedProject);
      setSaveFeedback({
        kind: "success",
        message: "Opened Patchmark project folder."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleCreateProjectFromCurrentDocument() {
    if (!fileName || isSaving) {
      return;
    }

    if (typeof markdown !== "string") {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: "Project creation failed because Markdown content is invalid."
      });
      return;
    }

    if (!canOpenProjectFolder()) {
      setSaveStatus("unavailable");
      setSaveFeedback({
        kind: "info",
        message:
          "Project folders require a browser with File System Access API support. You can continue using Single File Mode."
      });
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const loadedProject = await createProjectFromMarkdown({
        markdown,
        suggestedProjectName: fileName
      });

      if (!loadedProject) {
        setSaveStatus("idle");
        return;
      }

      loadProjectIntoEditor(loadedProject);
      setSaveFeedback({
        kind: "success",
        message: "Created Patchmark project from the current document."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleCreateSnapshot() {
    if (!projectHandle || isSaving) {
      return;
    }

    setSaveStatus("saving");
    setSaveFeedback(null);

    try {
      const snapshotResult = await createProjectSnapshot({
        project: projectHandle,
        markdown
      });

      if (!snapshotResult.created) {
        setSaveStatus("idle");
        setSaveFeedback({
          kind: "info",
          message: "No changes since latest snapshot."
        });
        return;
      }

      setProjectHandle(snapshotResult.project);
      setSaveStatus("idle");
      setSaveFeedback({
        kind: "success",
        message: "Created a Markdown snapshot in .patchmark/versions/."
      });
    } catch (error) {
      setSaveStatus("failed");
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleViewSnapshot(version: PatchmarkVersionEntry) {
    if (!projectHandle) {
      return;
    }

    try {
      const snapshotMarkdown = await readProjectVersionMarkdown(
        projectHandle,
        version
      );
      setSnapshotDialog({
        kind: "view",
        snapshotMarkdown,
        version
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleCompareSnapshot(version: PatchmarkVersionEntry) {
    if (!projectHandle) {
      return;
    }

    try {
      const snapshotMarkdown = await readProjectVersionMarkdown(
        projectHandle,
        version
      );
      setSnapshotDialog({
        currentMarkdown: markdown,
        kind: "compare",
        snapshotMarkdown,
        version
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleAddComment(values: CommentFormValues) {
    if (!projectHandle) {
      return;
    }

    const now = new Date().toISOString();
    const targetHeading = values.targetHeadingLine
      ? headings.find((heading) => heading.line === values.targetHeadingLine)
      : undefined;
    const nextComment: PatchmarkComment = {
      id: createNextCommentId(comments),
      type: values.type,
      status: "open",
      target_heading: targetHeading?.text,
      target_heading_level: targetHeading?.level,
      target_heading_line: targetHeading?.line,
      target_heading_path: targetHeading
        ? getHeadingPath(headings, targetHeading)
        : undefined,
      comment: values.comment,
      created_at: now,
      updated_at: now
    };
    const nextComments = [...comments, nextComment];

    await persistComments(nextComments, "Added comment.");
  }

  async function handleEditComment(
    commentId: string,
    values: Pick<CommentFormValues, "comment" | "type">
  ) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? {
            ...comment,
            type: values.type,
            comment: values.comment,
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Updated comment.");
  }

  async function handleResolveComment(commentId: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? {
            ...comment,
            status: "resolved" as const,
            resolved_at: now,
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Resolved comment.");
  }

  async function handleReopenComment(commentId: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId
        ? {
            ...comment,
            status: "open" as const,
            resolved_at: undefined,
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Reopened comment.");
  }

  async function handleDeleteComment(commentId: string) {
    const nextComments = comments.filter((comment) => comment.id !== commentId);

    await persistComments(nextComments, "Deleted comment.");
  }

  async function persistComments(
    nextComments: PatchmarkComment[],
    successMessage: string
  ) {
    if (!projectHandle || isCommentBusy) {
      return;
    }

    setIsCommentBusy(true);
    setCommentsError(null);

    try {
      await writeProjectComments(projectHandle, nextComments);
      setComments(nextComments);
      setSaveFeedback({
        kind: "success",
        message: successMessage
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setSaveFeedback({
        kind: "error",
        message
      });
      throw error;
    } finally {
      setIsCommentBusy(false);
    }
  }

  function loadProjectIntoEditor(loadedProject: LoadedPatchmarkProject) {
    setProjectHandle(loadedProject.project);
    setFileName(loadedProject.project.manifest.document_file);
    setMarkdown(loadedProject.markdown);
    setBaselineMarkdown(loadedProject.markdown);
    setActiveFileHandle(null);
    setRestoredMarkdown(null);
    setAvailableDraft(null);
    setSaveStatus("idle");
    setSnapshotDialog(null);
    setCommentsError(null);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  return (
    <section className="document-workspace" aria-label="Patchmark editor">
      <aside className="document-sidebar" aria-label="Document navigation">
        <DocumentOutline headings={headings} />
        <VersionHistoryPanel
          isProjectMode={isProjectMode}
          versions={versionEntries}
          onCompareVersion={handleCompareSnapshot}
          onViewVersion={handleViewSnapshot}
        />
        <CommentsPanel
          comments={comments}
          error={commentsError}
          headings={headings}
          isBusy={isCommentBusy}
          isProjectMode={isProjectMode}
          onAddComment={handleAddComment}
          onDeleteComment={handleDeleteComment}
          onEditComment={handleEditComment}
          onReopenComment={handleReopenComment}
          onResolveComment={handleResolveComment}
        />
      </aside>

      <div className="editor-panel">
        <div className="document-toolbar">
          <div className="document-toolbar-primary">
            <div className="loader-row">
              <MarkdownFileLoader onFileLoaded={handleFileLoaded} />
              <span className="file-loader-help">Accepts .md and .markdown</span>
            </div>

            <div className="project-actions" aria-label="Project folder actions">
              <button
                type="button"
                disabled={isSaving}
                onClick={handleOpenProjectFolder}
              >
                Open Project Folder
              </button>
              <button
                type="button"
                disabled={!fileName || isSaving}
                onClick={handleCreateProjectFromCurrentDocument}
              >
                Create Project From Current Document
              </button>
            </div>

            <div className="workspace-status" aria-label="Workspace status">
              <span>
                Mode:{" "}
                {isProjectMode ? "Patchmark Project" : "Single Markdown File"}
              </span>
              {projectHandle ? (
                <>
                  <span>Project: {projectHandle.manifest.project_name}</span>
                  <span>Document: {projectHandle.manifest.document_file}</span>
                </>
              ) : null}
            </div>

            {fileName ? (
              <div className="document-meta">
                <span>{isProjectMode ? "Project document" : "Loaded file"}</span>
                <strong title={fileName}>{fileName}</strong>
                <DocumentStatus status={documentStatus} />
              </div>
            ) : null}
          </div>

          {fileName ? (
            <div className="document-toolbar-controls">
              <DocumentActions
                fileName={fileName}
                isSaving={isSaving}
                markdown={markdown}
                onCreateSnapshot={handleCreateSnapshot}
                onDownload={handleDownload}
                onSaveAs={handleSaveAs}
                onSaveChanges={handleSaveChanges}
                showCreateSnapshot={isProjectMode}
              />
              <div className="mode-switcher" aria-label="Editor mode">
                <button
                  type="button"
                  aria-pressed={mode === "visual"}
                  onClick={() => setMode("visual")}
                >
                  Visual Mode
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "markdown"}
                  onClick={() => setMode("markdown")}
                >
                  Markdown Mode
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {saveFeedback ? (
          <div
            className={`document-save-banner document-save-banner-${saveFeedback.kind}`}
            role={saveFeedback.kind === "error" ? "alert" : "status"}
          >
            {saveFeedback.message}
          </div>
        ) : null}

        {!fileName && availableDraft ? (
          <DraftRestoreBanner
            draft={availableDraft}
            onRestore={handleRestoreDraft}
            onDiscard={handleDiscardDraft}
          />
        ) : null}

        <div className="editor-body">
          {fileName ? (
            mode === "visual" ? (
              <VisualMarkdownEditor
                key={documentVersion}
                markdown={markdown}
                onMarkdownChange={handleMarkdownChange}
              />
            ) : (
              <MarkdownSourceEditor
                markdown={markdown}
                onMarkdownChange={handleMarkdownChange}
              />
            )
          ) : (
            <div className="empty-state">
              <div>
                <h2>Load a Markdown file to begin.</h2>
                <p>
                  Markdown is the source of truth across Visual Mode and
                  Markdown Mode.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {snapshotDialog ? (
        <SnapshotDialog
          dialog={snapshotDialog}
          onClose={() => setSnapshotDialog(null)}
        />
      ) : null}
    </section>
  );
}

function getDocumentStatus({
  isDirty,
  markdown,
  restoredMarkdown,
  saveStatus
}: {
  isDirty: boolean;
  markdown: string;
  restoredMarkdown: string | null;
  saveStatus: SaveStatus;
}): DocumentStatusKind {
  if (saveStatus === "saving") {
    return "saving";
  }

  if (saveStatus === "failed") {
    return "saveFailed";
  }

  if (saveStatus === "unavailable") {
    return "saveUnavailable";
  }

  if (restoredMarkdown !== null && markdown === restoredMarkdown) {
    return "restored";
  }

  return isDirty ? "dirty" : "saved";
}

function getSaveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Save failed: ${error.message}`;
  }

  return "Save failed. Your unsaved changes are still in Patchmark.";
}

function getProjectErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Project folder action failed. Your Markdown is still in Patchmark.";
}

function createNextCommentId(comments: PatchmarkComment[]): string {
  const nextNumber =
    comments.reduce((maxNumber, comment) => {
      const match = /^PM-COMMENT-(\d+)$/.exec(comment.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) + 1;

  return `PM-COMMENT-${String(nextNumber).padStart(4, "0")}`;
}

function getHeadingPath(
  headings: ReturnType<typeof parseMarkdownHeadings>,
  targetHeading: ReturnType<typeof parseMarkdownHeadings>[number]
): string[] {
  const path: ReturnType<typeof parseMarkdownHeadings> = [];

  for (const heading of headings) {
    while (path.length > 0 && path[path.length - 1].level >= heading.level) {
      path.pop();
    }

    path.push(heading);

    if (heading.line === targetHeading.line) {
      return path.map((pathHeading) => pathHeading.text);
    }
  }

  return [targetHeading.text];
}
