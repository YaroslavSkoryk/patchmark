"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CommentsPanel,
  type CommentAddRequest,
  type CommentAnchorSummary,
  type CommentAnchorScope,
  type CommentFormValues
} from "@/components/comments-panel";
import { DocumentActions } from "@/components/document-actions";
import { MarkdownFileLoader } from "@/components/markdown-file-loader";
import {
  MarkdownSourceEditor,
  type MarkdownSelection
} from "@/components/markdown-source-editor";
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
  type PatchmarkCommentAnchor,
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
type SelectedCommentAnchorDraft = {
  anchorSource: "visual" | "markdown";
  anchorText: string;
  anchorTextSource: "selected" | "expanded_sentence" | "expanded_block";
  markdownEndOffset?: number;
  markdownStartOffset?: number;
  selectedText: string;
};
type SelectedCommentAnchorDraftResult = {
  draft: SelectedCommentAnchorDraft | null;
  help: string | null;
};
type CommentContextMenuState = {
  defaultHeadingLine: number | null;
  selectedDraft: SelectedCommentAnchorDraft | null;
  selectionHelp: string | null;
  x: number;
  y: number;
};
type CommentPositionMeasurementInput = {
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  workspace: HTMLElement | null;
};
type AnchorTextCandidate = {
  end: number;
  source: "selected" | "expanded_sentence" | "expanded_block";
  start: number;
  text: string;
};
type VisualSelectionSnapshot = {
  blockText: string;
  selectedText: string;
};
type VisualTextMatch = {
  range: Range;
  searchText: string;
  top: number;
};
type VisualTextPosition = {
  node: Text;
  offset: number;
};
type VisualTextIndex = {
  positions: VisualTextPosition[];
  text: string;
};
type CssHighlightRegistry = {
  delete: (name: string) => void;
  set: (name: string, highlight: unknown) => void;
};
type CssHighlightConstructor = new (...ranges: Range[]) => unknown;

const MIN_SELECTED_TEXT_CHARS = 24;
const MIN_SELECTED_TEXT_WORDS = 4;
const ANCHOR_CONTEXT_CHARS = 160;
const SHORT_SELECTION_HELP =
  "Select a longer phrase or use Add Comment to Section.";
const COMMENT_HIGHLIGHT_NAME = "patchmark-comment-anchors";

export function DocumentEditor() {
  const documentWorkspaceRef = useRef<HTMLElement>(null);
  const editorDocumentRef = useRef<HTMLDivElement>(null);
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
  const [markdownSelection, setMarkdownSelection] =
    useState<MarkdownSelection>({
      end: 0,
      start: 0
    });
  const [markdownSelectionRequest, setMarkdownSelectionRequest] = useState<
    (MarkdownSelection & { nonce: number }) | null
  >(null);
  const [visualSelectionDraft, setVisualSelectionDraft] =
    useState<SelectedCommentAnchorDraft | null>(null);
  const [commentAddRequest, setCommentAddRequest] =
    useState<CommentAddRequest | null>(null);
  const [commentContextMenu, setCommentContextMenu] =
    useState<CommentContextMenuState | null>(null);
  const [commentPositions, setCommentPositions] = useState<Record<string, number>>(
    {}
  );
  const [snapshotDialog, setSnapshotDialog] =
    useState<SnapshotDialogState | null>(null);

  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);
  const markdownSelectionDraft = useMemo(
    () => createMarkdownSelectionDraft(markdown, markdownSelection),
    [markdown, markdownSelection]
  );
  const selectedCommentDraft =
    mode === "markdown" ? markdownSelectionDraft : visualSelectionDraft;
  const selectedCommentHeading = useMemo(
    () =>
      typeof selectedCommentDraft?.markdownStartOffset === "number"
        ? getHeadingContainingOffset(
            markdown,
            headings,
            selectedCommentDraft.markdownStartOffset
          )
        : undefined,
    [headings, markdown, selectedCommentDraft]
  );
  const defaultCommentHeading = useMemo(
    () =>
      selectedCommentHeading ??
      getHeadingContainingOffset(markdown, headings, markdownSelection.start),
    [headings, markdown, markdownSelection.start, selectedCommentHeading]
  );
  const selectedCommentText = selectedCommentDraft?.selectedText.trim()
    ? selectedCommentDraft.selectedText
    : "";
  const selectedCommentAnchorText =
    selectedCommentDraft?.anchorText &&
    selectedCommentDraft.anchorText !== selectedCommentDraft.selectedText
      ? selectedCommentDraft.anchorText
      : "";
  const commentAnchorSummaries = useMemo(
    () =>
      Object.fromEntries(
        comments.map((comment) => [
          comment.id,
          getCommentAnchorSummary(comment, markdown, headings)
        ])
      ),
    [comments, headings, markdown]
  );
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

  useEffect(() => {
    if (!commentContextMenu) {
      return;
    }

    function closeCommentContextMenu() {
      setCommentContextMenu(null);
    }

    function handleContextMenuKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeCommentContextMenu();
      }
    }

    window.addEventListener("click", closeCommentContextMenu);
    window.addEventListener("keydown", handleContextMenuKeyDown);
    window.addEventListener("scroll", closeCommentContextMenu, true);

    return () => {
      window.removeEventListener("click", closeCommentContextMenu);
      window.removeEventListener("keydown", handleContextMenuKeyDown);
      window.removeEventListener("scroll", closeCommentContextMenu, true);
    };
  }, [commentContextMenu]);

  useEffect(() => {
    const animationFrameId = window.requestAnimationFrame(() => {
      setCommentPositions(
        measureCommentPositions({
          comments,
          container: editorDocumentRef.current,
          headings,
          markdown,
          mode,
          workspace: documentWorkspaceRef.current
        })
      );
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [comments, headings, markdown, mode]);

  useEffect(() => {
    const animationFrameId = window.requestAnimationFrame(() => {
      updateVisualCommentHighlights({
        comments,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode
      });
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      clearVisualCommentHighlights();
    };
  }, [comments, headings, markdown, mode]);

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
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentContextMenu(null);
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
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentContextMenu(null);
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
    const nextComment: PatchmarkComment = {
      id: createNextCommentId(comments),
      type: values.type,
      status: "open",
      anchor: createCommentAnchor({
        headings,
        markdown,
        selection: markdownSelection,
        selectedDraft: selectedCommentDraft,
        values
      }),
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

  async function handleFindComment(comment: PatchmarkComment) {
    const resolution = resolveCommentAnchor(comment, markdown, headings);

    if (comment.anchor.kind === "document") {
      setSaveFeedback({
        kind: "info",
        message: "This is a whole-document comment."
      });
      return;
    }

    if (resolution.status === "active" && resolution.start !== undefined) {
      jumpToMarkdownSelection(
        resolution.start,
        resolution.end ?? resolution.start
      );
      setSaveFeedback({
        kind: "success",
        message: "Showing comment anchor in Markdown Mode."
      });
      return;
    }

    if (resolution.status === "ambiguous") {
      setSaveFeedback({
        kind: "info",
        message:
          "Multiple matching anchors found. Open Markdown Mode and review manually."
      });
      return;
    }

    if (
      comment.anchor.kind === "selected_text" &&
      resolution.fallbackStart !== undefined
    ) {
      jumpToMarkdownSelection(
        resolution.fallbackStart,
        resolution.fallbackEnd ?? resolution.fallbackStart
      );
      setSaveFeedback({
        kind: "info",
        message: "Selected text was not found. Showing fallback section."
      });
      return;
    }

    setSaveFeedback({
      kind: "error",
      message:
        comment.anchor.kind === "section"
          ? "Target section not found."
          : "Selected text anchor not found. The text may have changed."
    });
  }

  function jumpToMarkdownSelection(start: number, end: number) {
    setMode("markdown");
    setMarkdownSelectionRequest({
      end,
      nonce: Date.now(),
      start
    });
  }

  function handleEditorMouseUp() {
    if (mode !== "visual") {
      return;
    }

    setVisualSelectionDraft(
      createVisualSelectionDraftResult({
        container: editorDocumentRef.current,
        markdown
      }).draft
    );
  }

  function handleEditorContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    if (!fileName || isToolbarContextMenuTarget(event.target)) {
      return;
    }

    event.preventDefault();

    const selectionResult =
      mode === "markdown"
        ? createMarkdownSelectionDraftResult(markdown, markdownSelection)
        : createVisualSelectionDraftResult({
            container: editorDocumentRef.current,
            markdown
          });
    const selectedDraft = selectionResult.draft;
    const headingForSelection =
      typeof selectedDraft?.markdownStartOffset === "number"
        ? getHeadingContainingOffset(
            markdown,
            headings,
            selectedDraft.markdownStartOffset
          )
        : mode === "visual"
          ? findVisualHeadingForPoint({
              container: editorDocumentRef.current,
              headings,
              pointY: event.clientY
            }) ?? defaultCommentHeading
          : defaultCommentHeading;

    if (mode === "visual") {
      setVisualSelectionDraft(selectedDraft);
    }

    setCommentContextMenu({
      defaultHeadingLine: headingForSelection?.line ?? null,
      selectionHelp: selectionResult.help,
      selectedDraft,
      x: event.clientX,
      y: event.clientY
    });
  }

  function handleOpenCommentFromMenu(scope: CommentAnchorScope) {
    if (!commentContextMenu) {
      return;
    }

    setVisualSelectionDraft(
      commentContextMenu.selectedDraft?.anchorSource === "visual"
        ? commentContextMenu.selectedDraft
        : null
    );
    setCommentAddRequest({
      nonce: Date.now(),
      scope,
      targetHeadingLine: commentContextMenu.defaultHeadingLine
    });
    setCommentContextMenu(null);
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
    setMarkdownSelection({ end: 0, start: 0 });
    setMarkdownSelectionRequest(null);
    setVisualSelectionDraft(null);
    setCommentAddRequest(null);
    setCommentContextMenu(null);
    setCommentsError(null);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  return (
    <section
      ref={documentWorkspaceRef}
      className="document-workspace"
      aria-label="Patchmark editor"
    >
      <aside className="document-sidebar" aria-label="Document navigation">
        <DocumentOutline headings={headings} />
        <VersionHistoryPanel
          isProjectMode={isProjectMode}
          versions={versionEntries}
          onCompareVersion={handleCompareSnapshot}
          onViewVersion={handleViewSnapshot}
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

        <div
          ref={editorDocumentRef}
          className="editor-body"
          onContextMenu={handleEditorContextMenu}
          onMouseUp={handleEditorMouseUp}
        >
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
                onSelectionChange={setMarkdownSelection}
                selectionRequest={markdownSelectionRequest}
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

      <aside className="comments-rail" aria-label="Document comments">
        <CommentsPanel
          addRequest={commentAddRequest}
          anchorSummaries={commentAnchorSummaries}
          commentPositions={commentPositions}
          comments={comments}
          defaultSectionLine={defaultCommentHeading?.line ?? null}
          error={commentsError}
          headings={headings}
          isBusy={isCommentBusy}
          isProjectMode={isProjectMode}
          onAddComment={handleAddComment}
          onDeleteComment={handleDeleteComment}
          onEditComment={handleEditComment}
          onFindComment={handleFindComment}
          onReopenComment={handleReopenComment}
          onResolveComment={handleResolveComment}
          selectedTextPreview={selectedCommentText || null}
          selectedAnchorTextPreview={selectedCommentAnchorText || null}
          selectedAnchorTextSource={selectedCommentDraft?.anchorTextSource ?? null}
        />
      </aside>

      {commentContextMenu ? (
        <div
          className="comment-context-menu"
          style={{ left: commentContextMenu.x, top: commentContextMenu.y }}
          role="menu"
          aria-label="Patchmark comment menu"
          onClick={(event) => event.stopPropagation()}
        >
          {!isProjectMode ? (
            <span className="comment-context-menu-note">
              Comments require Project Folder Mode.
            </span>
          ) : null}
          {commentContextMenu.selectedDraft || commentContextMenu.selectionHelp ? (
            <button
              type="button"
              role="menuitem"
              disabled={!isProjectMode || !commentContextMenu.selectedDraft}
              onClick={() => handleOpenCommentFromMenu("selected_text")}
            >
              Add Comment to Selection
            </button>
          ) : null}
          {isProjectMode && commentContextMenu.selectionHelp ? (
            <span className="comment-context-menu-note">
              {SHORT_SELECTION_HELP}
            </span>
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={!isProjectMode || !commentContextMenu.defaultHeadingLine}
            onClick={() => handleOpenCommentFromMenu("section")}
          >
            Add Comment to Section
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!isProjectMode}
            onClick={() => handleOpenCommentFromMenu("document")}
          >
            Add Comment to Document
          </button>
          {isProjectMode && !commentContextMenu.defaultHeadingLine ? (
            <span className="comment-context-menu-note">
              No section detected here.
            </span>
          ) : null}
        </div>
      ) : null}

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

function createMarkdownSelectionDraft(
  markdown: string,
  selection: MarkdownSelection
): SelectedCommentAnchorDraft | null {
  return createMarkdownSelectionDraftResult(markdown, selection).draft;
}

function createMarkdownSelectionDraftResult(
  markdown: string,
  selection: MarkdownSelection
): SelectedCommentAnchorDraftResult {
  if (selection.end <= selection.start) {
    return {
      draft: null,
      help: null
    };
  }

  const selectedRange = trimRange(markdown, selection.start, selection.end);

  if (selectedRange.end <= selectedRange.start) {
    return {
      draft: null,
      help: null
    };
  }

  const selectedText = markdown.slice(selectedRange.start, selectedRange.end);
  const anchorCandidate = createAnchorTextCandidateFromMarkdownRange(
    markdown,
    selectedRange
  );

  if (!anchorCandidate) {
    return {
      draft: null,
      help:
        "Selection is too short to anchor reliably. Select a longer phrase or add a section comment."
    };
  }

  return {
    draft: {
      anchorSource: "markdown",
      anchorText: anchorCandidate.text,
      anchorTextSource: anchorCandidate.source,
      markdownEndOffset: anchorCandidate.end,
      markdownStartOffset: anchorCandidate.start,
      selectedText
    },
    help: null
  };
}

function createVisualSelectionDraftResult({
  container,
  markdown
}: {
  container: HTMLElement | null;
  markdown: string;
}): SelectedCommentAnchorDraftResult {
  const snapshot = getBrowserSelectionSnapshotWithin(container);

  if (!snapshot) {
    return {
      draft: null,
      help: null
    };
  }

  const anchorCandidate = createAnchorTextCandidateFromVisualSnapshot(snapshot);

  if (!anchorCandidate) {
    return {
      draft: null,
      help:
        "Selection is too short to anchor reliably. Select a longer phrase or add a section comment."
    };
  }

  const exactMatches = findExactTextMatches(markdown, anchorCandidate.text);
  const uniqueMatch = exactMatches.length === 1 ? exactMatches[0] : null;

  return {
    draft: {
      anchorSource: "visual",
      anchorText: anchorCandidate.text,
      anchorTextSource: anchorCandidate.source,
      markdownEndOffset: uniqueMatch?.end,
      markdownStartOffset: uniqueMatch?.start,
      selectedText: snapshot.selectedText
    },
    help: null
  };
}

function getBrowserSelectionSnapshotWithin(
  container: HTMLElement | null
): VisualSelectionSnapshot | null {
  if (!container || typeof window === "undefined") {
    return null;
  }

  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const { anchorNode, focusNode } = selection;

  if (
    !anchorNode ||
    !focusNode ||
    !container.contains(anchorNode) ||
    !container.contains(focusNode)
  ) {
    return null;
  }

  const selectedText = normalizeDomText(selection.toString());

  if (!selectedText) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  const blockElement =
    commonAncestor?.closest(
      "p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6"
    ) ?? null;
  const blockText = normalizeDomText(blockElement?.textContent ?? selectedText);

  return {
    blockText,
    selectedText
  };
}

function createAnchorTextCandidateFromMarkdownRange(
  markdown: string,
  selectedRange: { end: number; start: number }
): AnchorTextCandidate | null {
  const selectedText = markdown.slice(selectedRange.start, selectedRange.end);

  if (isReliableAnchorText(selectedText)) {
    return {
      end: selectedRange.end,
      source: "selected",
      start: selectedRange.start,
      text: selectedText
    };
  }

  const blockRange = getMarkdownBlockRange(markdown, selectedRange);
  const sentenceRange = getSentenceRangeWithinText(
    markdown.slice(blockRange.start, blockRange.end),
    selectedRange.start - blockRange.start,
    selectedRange.end - blockRange.start
  );

  if (sentenceRange) {
    const absoluteSentenceRange = trimRange(
      markdown,
      blockRange.start + sentenceRange.start,
      blockRange.start + sentenceRange.end
    );
    const sentenceText = markdown.slice(
      absoluteSentenceRange.start,
      absoluteSentenceRange.end
    );

    if (isReliableAnchorText(sentenceText)) {
      return {
        end: absoluteSentenceRange.end,
        source: "expanded_sentence",
        start: absoluteSentenceRange.start,
        text: sentenceText
      };
    }
  }

  const trimmedBlockRange = trimRange(markdown, blockRange.start, blockRange.end);
  const blockText = markdown.slice(trimmedBlockRange.start, trimmedBlockRange.end);

  if (isReliableAnchorText(blockText)) {
    return {
      end: trimmedBlockRange.end,
      source: "expanded_block",
      start: trimmedBlockRange.start,
      text: blockText
    };
  }

  return null;
}

function createAnchorTextCandidateFromVisualSnapshot(
  snapshot: VisualSelectionSnapshot
): Pick<AnchorTextCandidate, "source" | "text"> | null {
  if (isReliableAnchorText(snapshot.selectedText)) {
    return {
      source: "selected",
      text: snapshot.selectedText
    };
  }

  const sentenceText = getSentenceTextAroundSelection(
    snapshot.blockText,
    snapshot.selectedText
  );

  if (sentenceText && isReliableAnchorText(sentenceText)) {
    return {
      source: "expanded_sentence",
      text: sentenceText
    };
  }

  if (isReliableAnchorText(snapshot.blockText)) {
    return {
      source: "expanded_block",
      text: snapshot.blockText
    };
  }

  return null;
}

function isReliableAnchorText(text: string): boolean {
  const normalizedText = text.trim();

  return (
    normalizedText.length >= MIN_SELECTED_TEXT_CHARS &&
    getWordCount(normalizedText) >= MIN_SELECTED_TEXT_WORDS
  );
}

function getWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function trimRange(
  text: string,
  start: number,
  end: number
): { end: number; start: number } {
  let nextStart = Math.max(0, Math.min(start, text.length));
  let nextEnd = Math.max(nextStart, Math.min(end, text.length));

  while (nextStart < nextEnd && /\s/.test(text[nextStart])) {
    nextStart += 1;
  }

  while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1])) {
    nextEnd -= 1;
  }

  return {
    end: nextEnd,
    start: nextStart
  };
}

function getMarkdownBlockRange(
  markdown: string,
  range: { end: number; start: number }
): { end: number; start: number } {
  const beforeSelection = markdown.slice(0, range.start);
  const afterSelection = markdown.slice(range.end);
  const previousBlankLineIndex = beforeSelection.search(/\n\s*\n[^\n]*$/);
  const nextBlankLineMatch = /\n\s*\n/.exec(afterSelection);
  const start =
    previousBlankLineIndex === -1
      ? 0
      : beforeSelection.lastIndexOf("\n", previousBlankLineIndex) + 1;
  const end = nextBlankLineMatch
    ? range.end + nextBlankLineMatch.index
    : markdown.length;

  return {
    end,
    start
  };
}

function getSentenceRangeWithinText(
  text: string,
  selectionStart: number,
  selectionEnd: number
): { end: number; start: number } | null {
  const safeStart = Math.max(0, Math.min(selectionStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd, text.length));
  let sentenceStart = 0;
  let sentenceEnd = text.length;

  for (let index = safeStart - 1; index >= 0; index -= 1) {
    if (/[.!?]/.test(text[index])) {
      sentenceStart = index + 1;
      break;
    }
  }

  for (let index = safeEnd; index < text.length; index += 1) {
    if (/[.!?]/.test(text[index])) {
      sentenceEnd = index + 1;
      break;
    }
  }

  const trimmedRange = trimRange(text, sentenceStart, sentenceEnd);

  return trimmedRange.end > trimmedRange.start ? trimmedRange : null;
}

function getSentenceTextAroundSelection(
  blockText: string,
  selectedText: string
): string | null {
  const selectedIndex = blockText.indexOf(selectedText);

  if (selectedIndex === -1) {
    return null;
  }

  const sentenceRange = getSentenceRangeWithinText(
    blockText,
    selectedIndex,
    selectedIndex + selectedText.length
  );

  return sentenceRange
    ? blockText.slice(sentenceRange.start, sentenceRange.end)
    : null;
}

function isToolbarContextMenuTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(target.closest(".mdxeditor-toolbar"));
}

function measureCommentPositions({
  comments,
  container,
  headings,
  markdown,
  mode,
  workspace
}: CommentPositionMeasurementInput): Record<string, number> {
  if (!container || !workspace || comments.length === 0) {
    return {};
  }

  const workspaceRect = workspace.getBoundingClientRect();
  const editorRect = container.getBoundingClientRect();
  const editorTop = Math.max(0, editorRect.top - workspaceRect.top);
  const rawPositions: Array<{ id: string; top: number }> = [];

  for (const comment of comments) {
    const top = measureCommentTop({
      comment,
      container,
      editorTop,
      headings,
      markdown,
      mode,
      workspaceRect
    });

    if (top !== null) {
      rawPositions.push({
        id: comment.id,
        top
      });
    }
  }

  return stackCommentPositions(rawPositions);
}

function measureCommentTop({
  comment,
  container,
  editorTop,
  headings,
  markdown,
  mode,
  workspaceRect
}: {
  comment: PatchmarkComment;
  container: HTMLElement;
  editorTop: number;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  workspaceRect: DOMRect;
}): number | null {
  const { anchor } = comment;

  if (anchor.kind === "document") {
    return 0;
  }

  if (anchor.kind === "section") {
    const currentHeading = findMatchingHeading(headings, {
      level: anchor.heading_level,
      text: anchor.heading
    });

    if (!currentHeading) {
      return null;
    }

    if (mode === "visual") {
      return (
        findVisualHeadingTop({
          container,
          heading: currentHeading,
          workspaceRect
        }) ?? estimateTopForLine(currentHeading.line, editorTop)
      );
    }

    return estimateTopForLine(currentHeading.line, editorTop);
  }

  const resolution = resolveCommentAnchor(comment, markdown, headings);

  if (resolution.status === "ambiguous") {
    return null;
  }

  if (resolution.status === "active" && resolution.start !== undefined) {
    if (mode === "visual") {
      const visualTextTop = findVisualSelectedTextTop({
        anchor,
        container,
        workspaceRect
      });

      if (visualTextTop !== null) {
        return visualTextTop;
      }

      const fallbackHeading = anchor.containing_heading
        ? findMatchingHeading(headings, {
            level: anchor.containing_heading_level,
            text: anchor.containing_heading
          })
        : null;
      const fallbackVisualTop = fallbackHeading
        ? findVisualHeadingTop({
            container,
            heading: fallbackHeading,
            workspaceRect
          })
        : null;

      return fallbackVisualTop;
    }

    return estimateTopForOffset(markdown, resolution.start, editorTop);
  }

  if (resolution.fallbackStart !== undefined) {
    if (mode === "visual") {
      const fallbackHeading = anchor.containing_heading
        ? findMatchingHeading(headings, {
            level: anchor.containing_heading_level,
            text: anchor.containing_heading
          })
        : null;
      const fallbackVisualTop = fallbackHeading
        ? findVisualHeadingTop({
            container,
            heading: fallbackHeading,
            workspaceRect
          })
        : null;

      if (fallbackVisualTop !== null) {
        return fallbackVisualTop;
      }
    }

    return estimateTopForOffset(markdown, resolution.fallbackStart, editorTop);
  }

  return null;
}

function stackCommentPositions(
  rawPositions: Array<{ id: string; top: number }>
): Record<string, number> {
  const stackedPositions: Record<string, number> = {};
  let previousTop = -Infinity;
  const minimumGap = 148;

  for (const position of rawPositions.sort(
    (firstPosition, secondPosition) => firstPosition.top - secondPosition.top
  )) {
    const nextTop = Math.max(position.top, previousTop + minimumGap);
    stackedPositions[position.id] = nextTop;
    previousTop = nextTop;
  }

  return stackedPositions;
}

function findVisualHeadingForPoint({
  container,
  headings,
  pointY
}: {
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  pointY: number;
}): ReturnType<typeof parseMarkdownHeadings>[number] | undefined {
  if (!container) {
    return undefined;
  }

  const headingElements = getVisualHeadingElements(container);
  let nearestHeadingText = "";

  for (const headingElement of headingElements) {
    if (headingElement.getBoundingClientRect().top > pointY) {
      break;
    }

    nearestHeadingText = normalizeDomText(headingElement.textContent ?? "");
  }

  if (!nearestHeadingText) {
    return undefined;
  }

  return headings.find((heading) => heading.text === nearestHeadingText);
}

function findVisualHeadingTop({
  container,
  heading,
  workspaceRect
}: {
  container: HTMLElement;
  heading: ReturnType<typeof parseMarkdownHeadings>[number];
  workspaceRect: DOMRect;
}): number | null {
  const headingElement = getVisualHeadingElements(container).find(
    (element) => normalizeDomText(element.textContent ?? "") === heading.text
  );

  if (!headingElement) {
    return null;
  }

  return Math.max(0, headingElement.getBoundingClientRect().top - workspaceRect.top);
}

function findVisualHeadingRange({
  container,
  heading
}: {
  container: HTMLElement;
  heading: ReturnType<typeof parseMarkdownHeadings>[number];
}): Range | null {
  const headingElement = getVisualHeadingElements(container).find(
    (element) => normalizeDomText(element.textContent ?? "") === heading.text
  );

  if (!headingElement) {
    return null;
  }

  const range = document.createRange();
  range.selectNodeContents(headingElement);

  return range;
}

function findVisualSelectedTextTop({
  anchor,
  container,
  workspaceRect
}: {
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>;
  container: HTMLElement;
  workspaceRect: DOMRect;
}): number | null {
  const visualMatch = findUniqueVisualSelectedTextMatch({ anchor, container });

  return visualMatch ? Math.max(0, visualMatch.top - workspaceRect.top) : null;
}

function findUniqueVisualSelectedTextMatch({
  anchor,
  container
}: {
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>;
  container: HTMLElement;
}): VisualTextMatch | null {
  for (const searchText of getSelectedAnchorSearchTexts(anchor)) {
    const matches = findVisualTextMatches({
      container,
      searchText
    });

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      return null;
    }
  }

  return null;
}

function findVisualTextMatches({
  container,
  searchText
}: {
  container: HTMLElement;
  searchText: string;
}): VisualTextMatch[] {
  const trimmedSearchText = normalizeDomText(searchText);

  if (!trimmedSearchText) {
    return [];
  }

  const textIndex = buildVisualTextIndex(container);
  const matches: VisualTextMatch[] = [];
  let nextIndex = textIndex.text.indexOf(trimmedSearchText);

  while (nextIndex !== -1) {
    const range = createRangeFromVisualTextIndex(
      textIndex,
      nextIndex,
      nextIndex + trimmedSearchText.length
    );

    if (range) {
      const rect = range.getBoundingClientRect();

      if (rect.height > 0 || rect.width > 0) {
        matches.push({
          range,
          searchText: trimmedSearchText,
          top: Math.max(0, rect.top)
        });
      }
    }

    nextIndex = textIndex.text.indexOf(
      trimmedSearchText,
      nextIndex + trimmedSearchText.length
    );
  }

  return matches;
}

function buildVisualTextIndex(container: HTMLElement): VisualTextIndex {
  const root = getVisualSearchRoot(container);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      const parentElement = node.parentElement;

      if (
        parentElement?.closest(
          ".mdxeditor-toolbar, .comment-context-menu, script, style"
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textParts: string[] = [];
  const positions: VisualTextPosition[] = [];
  let currentNode = walker.nextNode() as Text | null;

  while (currentNode) {
    const nodeText = currentNode.textContent ?? "";

    for (let index = 0; index < nodeText.length; index += 1) {
      const character = nodeText[index];
      const isWhitespace = /\s/.test(character);
      const previousCharacter = textParts[textParts.length - 1];

      if (isWhitespace) {
        if (textParts.length > 0 && previousCharacter !== " ") {
          textParts.push(" ");
          positions.push({
            node: currentNode,
            offset: index
          });
        }
      } else {
        textParts.push(character);
        positions.push({
          node: currentNode,
          offset: index
        });
      }
    }

    currentNode = walker.nextNode() as Text | null;
  }

  while (textParts[0] === " ") {
    textParts.shift();
    positions.shift();
  }

  while (textParts[textParts.length - 1] === " ") {
    textParts.pop();
    positions.pop();
  }

  return {
    positions,
    text: textParts.join("")
  };
}

function createRangeFromVisualTextIndex(
  textIndex: VisualTextIndex,
  start: number,
  end: number
): Range | null {
  const startPosition = textIndex.positions[start];
  const endPosition = textIndex.positions[end - 1];

  if (!startPosition || !endPosition) {
    return null;
  }

  const range = document.createRange();
  range.setStart(startPosition.node, startPosition.offset);
  range.setEnd(endPosition.node, endPosition.offset + 1);

  return range;
}

function getVisualHeadingElements(container: HTMLElement): HTMLElement[] {
  const root = getVisualSearchRoot(container);

  return Array.from(
    root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
  );
}

function getVisualSearchRoot(container: HTMLElement): HTMLElement {
  return (
    container.querySelector<HTMLElement>(".patchmark-prose") ??
    container.querySelector<HTMLElement>(".visual-editor-fallback") ??
    container
  );
}

function updateVisualCommentHighlights({
  comments,
  container,
  headings,
  markdown,
  mode
}: {
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
}): void {
  const highlightApi = getCssHighlightApi();

  if (!highlightApi) {
    return;
  }

  if (!container || mode !== "visual") {
    highlightApi.registry.delete(COMMENT_HIGHLIGHT_NAME);
    return;
  }

  const ranges: Range[] = [];

  for (const comment of comments) {
    const resolution = resolveCommentAnchor(comment, markdown, headings);

    if (resolution.status !== "active") {
      continue;
    }

    if (comment.anchor.kind === "document") {
      continue;
    }

    if (comment.anchor.kind === "section") {
      const currentHeading = findMatchingHeading(headings, {
        level: comment.anchor.heading_level,
        text: comment.anchor.heading
      });
      const range = currentHeading
        ? findVisualHeadingRange({
            container,
            heading: currentHeading
          })
        : null;

      if (range) {
        ranges.push(range);
      }

      continue;
    }

    const match = findUniqueVisualSelectedTextMatch({
      anchor: comment.anchor,
      container
    });

    if (match) {
      ranges.push(match.range);
    }
  }

  if (ranges.length === 0) {
    highlightApi.registry.delete(COMMENT_HIGHLIGHT_NAME);
    return;
  }

  highlightApi.registry.set(
    COMMENT_HIGHLIGHT_NAME,
    new highlightApi.Highlight(...ranges)
  );
}

function clearVisualCommentHighlights(): void {
  const highlightApi = getCssHighlightApi();

  highlightApi?.registry.delete(COMMENT_HIGHLIGHT_NAME);
}

function getCssHighlightApi():
  | { Highlight: CssHighlightConstructor; registry: CssHighlightRegistry }
  | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return null;
  }

  const registry = (CSS as unknown as { highlights?: CssHighlightRegistry })
    .highlights;
  const HighlightConstructor = (
    window as unknown as { Highlight?: CssHighlightConstructor }
  ).Highlight;

  if (!registry || !HighlightConstructor) {
    return null;
  }

  return {
    Highlight: HighlightConstructor,
    registry
  };
}

function estimateTopForOffset(
  markdown: string,
  offset: number,
  editorTop: number
): number {
  const line = markdown.slice(0, offset).split(/\r?\n/).length;

  return estimateTopForLine(line, editorTop);
}

function estimateTopForLine(line: number, editorTop: number): number {
  return Math.max(0, editorTop + Math.max(0, line - 1) * 24);
}

function normalizeDomText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

type CommentAnchorResolution = CommentAnchorSummary & {
  end?: number;
  fallbackEnd?: number;
  fallbackStart?: number;
  start?: number;
};

function createCommentAnchor({
  headings,
  markdown,
  selection,
  selectedDraft,
  values
}: {
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  selection: MarkdownSelection;
  selectedDraft: SelectedCommentAnchorDraft | null;
  values: CommentFormValues;
}): PatchmarkCommentAnchor {
  if (values.anchorScope === "document") {
    return {
      kind: "document"
    };
  }

  if (values.anchorScope === "section") {
    const targetHeading = values.targetHeadingLine
      ? headings.find((heading) => heading.line === values.targetHeadingLine)
      : undefined;

    if (!targetHeading) {
      throw new Error("Choose a target section.");
    }

    const sectionRange = getSectionRange(markdown, headings, targetHeading);

    return {
      kind: "section",
      heading: targetHeading.text,
      heading_level: targetHeading.level,
      heading_line: targetHeading.line,
      heading_path: getHeadingPath(headings, targetHeading),
      section_start_offset: sectionRange.start,
      section_end_offset: sectionRange.end
    };
  }

  const selectedText =
    selectedDraft?.selectedText ?? markdown.slice(selection.start, selection.end);
  const anchorText = selectedDraft?.anchorText ?? selectedText;
  const anchorTextSource = selectedDraft?.anchorTextSource ?? "selected";

  if (!selectedText.trim()) {
    throw new Error("Select text in the editor before saving this comment.");
  }

  const markdownStartOffset = selectedDraft
    ? selectedDraft.markdownStartOffset
    : selection.start;
  const markdownEndOffset = selectedDraft
    ? selectedDraft.markdownEndOffset
    : selection.end;

  const containingHeading =
    typeof markdownStartOffset === "number"
      ? getHeadingContainingOffset(markdown, headings, markdownStartOffset)
      : undefined;
  const fallbackSectionRange = containingHeading
    ? getSectionRange(markdown, headings, containingHeading)
    : null;

  return {
    kind: "selected_text",
    selected_text: selectedText,
    anchor_text: anchorText,
    anchor_text_source: anchorTextSource,
    markdown_start_offset: markdownStartOffset,
    markdown_end_offset: markdownEndOffset,
    context_before:
      typeof markdownStartOffset !== "number"
        ? undefined
        : markdown.slice(
            Math.max(0, markdownStartOffset - ANCHOR_CONTEXT_CHARS),
            markdownStartOffset
          ),
    context_after:
      typeof markdownEndOffset !== "number"
        ? undefined
        : markdown.slice(
            markdownEndOffset,
            Math.min(markdown.length, markdownEndOffset + ANCHOR_CONTEXT_CHARS)
          ),
    containing_heading: containingHeading?.text,
    containing_heading_level: containingHeading?.level,
    containing_heading_line: containingHeading?.line,
    containing_heading_path: containingHeading
      ? getHeadingPath(headings, containingHeading)
      : undefined,
    anchor_source: selectedDraft?.anchorSource ?? "markdown",
    fallback_section_start_offset: fallbackSectionRange?.start,
    fallback_section_end_offset: fallbackSectionRange?.end
  };
}

function getCommentAnchorSummary(
  comment: PatchmarkComment,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): CommentAnchorSummary {
  const resolution = resolveCommentAnchor(comment, markdown, headings);

  return {
    detail: resolution.detail,
    label: resolution.label,
    status: resolution.status
  };
}

function resolveCommentAnchor(
  comment: PatchmarkComment,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): CommentAnchorResolution {
  const { anchor } = comment;

  if (anchor.kind === "document") {
    return {
      label: "Whole document",
      status: "document"
    };
  }

  if (anchor.kind === "section") {
    const currentHeading = findMatchingHeading(headings, {
      level: anchor.heading_level,
      text: anchor.heading
    });

    if (!currentHeading) {
      return {
        label: "Whole section: Target section not found",
        status: "not_found"
      };
    }

    const lineRange = getHeadingLineRange(markdown, currentHeading);

    return {
      end: lineRange.end,
      label: `Whole section: ${"#".repeat(currentHeading.level)} ${
        currentHeading.text
      }`,
      start: lineRange.start,
      status: "active"
    };
  }

  const offsetStart = anchor.markdown_start_offset;
  const offsetEnd = anchor.markdown_end_offset;
  const searchTexts = getSelectedAnchorSearchTexts(anchor);
  const primarySearchText = searchTexts[0];

  if (
    typeof offsetStart === "number" &&
    typeof offsetEnd === "number" &&
    markdown.slice(offsetStart, offsetEnd) === primarySearchText
  ) {
    return {
      end: offsetEnd,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      start: offsetStart,
      status: "active"
    };
  }

  let matches: Array<{ end: number; start: number }> = [];

  for (const searchText of searchTexts) {
    matches = findExactTextMatches(markdown, searchText);

    if (matches.length > 0) {
      break;
    }
  }

  if (matches.length > 1) {
    matches = filterMatchesByStoredContext(markdown, matches, anchor);
  }

  if (matches.length === 1) {
    return {
      end: matches[0].end,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      start: matches[0].start,
      status: "active"
    };
  }

  if (matches.length > 1) {
    return {
      detail:
        "Multiple matches found. Select a longer phrase next time or re-anchor this comment.",
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "ambiguous"
    };
  }

  const fallbackHeading = anchor.containing_heading
    ? findMatchingHeading(headings, {
        level: anchor.containing_heading_level,
        text: anchor.containing_heading
      })
    : null;

  if (fallbackHeading) {
    const lineRange = getHeadingLineRange(markdown, fallbackHeading);

    return {
      detail: "Text not found, section still exists.",
      fallbackEnd: lineRange.end,
      fallbackStart: lineRange.start,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "not_found"
    };
  }

  return {
    detail: "Anchor not found. The text may have changed.",
    label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
    status: "not_found"
  };
}

function filterMatchesByStoredContext(
  markdown: string,
  matches: Array<{ end: number; start: number }>,
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): Array<{ end: number; start: number }> {
  const contextBefore = anchor.context_before ?? "";
  const contextAfter = anchor.context_after ?? "";

  if (!contextBefore && !contextAfter) {
    return matches;
  }

  const contextMatches = matches.filter((match) => {
    const beforeWindow = markdown.slice(
      Math.max(0, match.start - contextBefore.length),
      match.start
    );
    const afterWindow = markdown.slice(
      match.end,
      Math.min(markdown.length, match.end + contextAfter.length)
    );
    const beforeMatches = !contextBefore || beforeWindow === contextBefore;
    const afterMatches = !contextAfter || afterWindow === contextAfter;

    return beforeMatches && afterMatches;
  });

  return contextMatches.length > 0 ? contextMatches : matches;
}

function getSelectedAnchorSearchTexts(
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): string[] {
  return [anchor.anchor_text, anchor.selected_text].filter(
    (text, index, texts): text is string =>
      typeof text === "string" &&
      text.trim().length > 0 &&
      texts.indexOf(text) === index
  );
}

function getSelectedTextHeadingLabel(
  anchor: Extract<PatchmarkCommentAnchor, { kind: "selected_text" }>
): string {
  if (!anchor.containing_heading) {
    return "document";
  }

  return `${"#".repeat(anchor.containing_heading_level ?? 1)} ${
    anchor.containing_heading
  }`;
}

function findExactTextMatches(
  markdown: string,
  selectedText: string
): Array<{ end: number; start: number }> {
  if (!selectedText) {
    return [];
  }

  const matches: Array<{ end: number; start: number }> = [];
  let nextIndex = markdown.indexOf(selectedText);

  while (nextIndex !== -1) {
    matches.push({
      end: nextIndex + selectedText.length,
      start: nextIndex
    });
    nextIndex = markdown.indexOf(selectedText, nextIndex + selectedText.length);
  }

  return matches;
}

function getHeadingContainingOffset(
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  offset: number
): ReturnType<typeof parseMarkdownHeadings>[number] | undefined {
  const lineOffsets = getLineStartOffsets(markdown);
  let containingHeading: ReturnType<typeof parseMarkdownHeadings>[number] | undefined;

  for (const heading of headings) {
    const headingOffset = lineOffsets[heading.line - 1] ?? 0;

    if (headingOffset > offset) {
      break;
    }

    containingHeading = heading;
  }

  return containingHeading;
}

function findMatchingHeading(
  headings: ReturnType<typeof parseMarkdownHeadings>,
  target: { level?: number; text: string }
) {
  return headings.find(
    (heading) =>
      heading.text === target.text &&
      (target.level === undefined || heading.level === target.level)
  );
}

function getSectionRange(
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>,
  targetHeading: ReturnType<typeof parseMarkdownHeadings>[number]
): { end: number; start: number } {
  const lineOffsets = getLineStartOffsets(markdown);
  const headingIndex = headings.findIndex(
    (heading) => heading.line === targetHeading.line
  );
  const nextPeerHeading = headings
    .slice(headingIndex + 1)
    .find((heading) => heading.level <= targetHeading.level);

  return {
    end: nextPeerHeading
      ? lineOffsets[nextPeerHeading.line - 1] ?? markdown.length
      : markdown.length,
    start: lineOffsets[targetHeading.line - 1] ?? 0
  };
}

function getHeadingLineRange(
  markdown: string,
  heading: ReturnType<typeof parseMarkdownHeadings>[number]
): { end: number; start: number } {
  const lineOffsets = getLineStartOffsets(markdown);
  const start = lineOffsets[heading.line - 1] ?? 0;
  const nextLineStart = lineOffsets[heading.line];

  return {
    end: nextLineStart ? Math.max(start, nextLineStart - 1) : markdown.length,
    start
  };
}

function getLineStartOffsets(markdown: string): number[] {
  const offsets = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  return offsets;
}
