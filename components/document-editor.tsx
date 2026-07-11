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
  readProjectPatches,
  saveProjectDocument,
  writeProjectContextPack,
  writeProjectComments,
  writeProjectImport,
  writeProjectPatches,
  type LoadedPatchmarkProject,
  type PatchmarkProjectHandle
} from "@/lib/project/patchmark-project";
import {
  type PatchmarkComment,
  type PatchmarkCommentAnchor,
  type PatchmarkCommentActionContext,
  type PatchmarkCommentActionIntent,
  type PatchmarkCommentType,
  type PatchmarkCommentReplyImport,
  type PatchmarkCommentThreadEntry,
  type PatchmarkPatch,
  type PatchmarkSelectedTextAnchorContext,
  type PatchmarkSelectedTextAnchorContextKind,
  type PatchmarkSuggestedUserAction,
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
type SelectedTextAnchor = Extract<
  PatchmarkCommentAnchor,
  { kind: "selected_text" }
>;
type SelectedCommentAnchorDraft = {
  anchorSource: "visual" | "markdown";
  anchorContext: PatchmarkSelectedTextAnchorContext;
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
type ChatGptPromptDialogState = {
  commentIds: string[];
  exportId: string;
  exportedAt: string;
  payloadFileName: string;
  promptFileName: string;
  jsonText: string;
  promptText: string;
};
type ChatGptImportDialogState = {
  error: string | null;
  responseJson: string;
  sourceChatUrl: string;
};
type ChatGptImportSummary = {
  openQuestionsAttached: number;
  patchProposalsStored: number;
  repliesAttached: number;
  warnings: string[];
};
type CommentPositionMeasurementInput = {
  comments: PatchmarkComment[];
  container: HTMLElement | null;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  mode: EditorMode;
  workspace: HTMLElement | null;
};
type VisualSelectionSnapshot = {
  blockText: string;
  blockKind: PatchmarkSelectedTextAnchorContextKind;
  selectedEndInBlock?: number;
  selectedStartInBlock?: number;
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

const ANCHOR_CONTEXT_CHARS = 160;
const SHORT_SELECTION_HELP =
  "Could not create a reliable anchor. Try selecting a larger phrase or add a section comment.";
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
  const [patches, setPatches] = useState<PatchmarkPatch[]>([]);
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
  const [chatGptPromptDialog, setChatGptPromptDialog] =
    useState<ChatGptPromptDialogState | null>(null);
  const [chatGptImportDialog, setChatGptImportDialog] =
    useState<ChatGptImportDialogState | null>(null);

  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);
  const markdownSelectionDraft = useMemo(
    () => createMarkdownSelectionDraft(markdown, markdownSelection),
    [markdown, markdownSelection]
  );
  const selectedCommentDraft =
    mode === "markdown" ? markdownSelectionDraft : visualSelectionDraft;
  const selectedCommentHeading = useMemo(
    () =>
      typeof getDraftMarkdownStartOffset(selectedCommentDraft) === "number"
        ? getHeadingContainingOffset(
            markdown,
            headings,
            getDraftMarkdownStartOffset(selectedCommentDraft) ?? 0
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
  const selectedCommentAnchorContextKind =
    selectedCommentDraft?.anchorContext.kind ?? null;
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
  const pendingPatchCountsByCommentId = useMemo(
    () => getPendingPatchCountsByCommentId(patches),
    [patches]
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
      setPatches([]);
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

    void readProjectPatches(projectHandle)
      .then((projectPatches) => {
        if (!isCancelled) {
          setPatches(projectPatches);
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setPatches([]);
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
    let isCancelled = false;
    let animationFrameId: number | null = null;
    const delayedSyncTimeoutIds: number[] = [];
    const editorContainer = editorDocumentRef.current;
    const workspace = documentWorkspaceRef.current;

    function syncCommentAnchors() {
      if (isCancelled) {
        return;
      }

      const nextCommentPositions = measureCommentPositions({
        comments,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode,
        workspace: documentWorkspaceRef.current
      });

      setCommentPositions((currentCommentPositions) =>
        areCommentPositionsEqual(currentCommentPositions, nextCommentPositions)
          ? currentCommentPositions
          : nextCommentPositions
      );

      updateVisualCommentHighlights({
        comments,
        container: editorDocumentRef.current,
        headings,
        markdown,
        mode
      });
    }

    function scheduleCommentAnchorSync() {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        syncCommentAnchors();
      });
    }

    scheduleCommentAnchorSync();

    for (const delay of [60, 180, 420, 900]) {
      delayedSyncTimeoutIds.push(
        window.setTimeout(scheduleCommentAnchorSync, delay)
      );
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleCommentAnchorSync);
    const mutationObserver =
      typeof MutationObserver === "undefined" || !editorContainer
        ? null
        : new MutationObserver(scheduleCommentAnchorSync);

    if (resizeObserver) {
      if (editorContainer) {
        resizeObserver.observe(editorContainer);
      }

      if (workspace) {
        resizeObserver.observe(workspace);
      }
    }

    if (mutationObserver && editorContainer) {
      mutationObserver.observe(editorContainer, {
        characterData: true,
        childList: true,
        subtree: true
      });
    }
    window.addEventListener("resize", scheduleCommentAnchorSync);

    return () => {
      isCancelled = true;

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      for (const timeoutId of delayedSyncTimeoutIds) {
        window.clearTimeout(timeoutId);
      }

      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleCommentAnchorSync);
      clearVisualCommentHighlights();
    };
  }, [comments, documentVersion, headings, markdown, mode]);

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
    setPatches([]);
    setCommentsError(null);
    setChatGptPromptDialog(null);
    setChatGptImportDialog(null);
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
    setPatches([]);
    setCommentsError(null);
    setChatGptPromptDialog(null);
    setChatGptImportDialog(null);
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

  function handleGenerateChatGptPrompt() {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "ChatGPT prompt generation is available in Project Folder Mode."
      });
      return;
    }

    const focusedComments = getFocusedCommentsForExport(comments);

    if (focusedComments.length === 0) {
      setSaveFeedback({
        kind: "info",
        message:
          "No focused comments to export. Reply to a comment or mark it for ChatGPT first."
      });
      return;
    }

    const exportedAt = new Date().toISOString();
    const exportId = createCommentExportId(exportedAt);
    const fileTimestamp = createFileSafeTimestamp(exportedAt);
    const exportPayload = createFocusedCommentsExportPayload({
      comments: focusedComments,
      exportedAt,
      exportId,
      headings,
      markdown,
      project: projectHandle
    });
    const jsonText = `${JSON.stringify(exportPayload, null, 2)}\n`;
    const promptText = createFocusedCommentsChatGptPrompt(jsonText);

    setChatGptPromptDialog({
      commentIds: focusedComments.map((comment) => comment.id),
      exportedAt,
      exportId,
      payloadFileName: `${fileTimestamp}-focused-comments-payload.json`,
      promptFileName: `${fileTimestamp}-focused-comments-prompt.md`,
      jsonText,
      promptText
    });
    setSaveFeedback({
      kind: "info",
      message: `Generated a ChatGPT prompt for ${focusedComments.length} focused comment${
        focusedComments.length === 1 ? "" : "s"
      }.`
    });
  }

  async function handleCopyChatGptPrompt() {
    if (!chatGptPromptDialog) {
      return;
    }

    if (!navigator.clipboard) {
      setSaveFeedback({
        kind: "error",
        message: "Clipboard copy is not available in this browser."
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(chatGptPromptDialog.promptText);
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: "Prompt copied. Focused comments marked as exported."
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleSaveChatGptPrompt() {
    if (!projectHandle || !chatGptPromptDialog) {
      return;
    }

    try {
      const filePath = await writeProjectContextPack({
        contents: chatGptPromptDialog.promptText,
        fileName: chatGptPromptDialog.promptFileName,
        project: projectHandle
      });
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: `Prompt saved to ${filePath}. Focused comments marked as exported.`
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setSaveFeedback({
        kind: "error",
        message
      });
    }
  }

  async function handleCopyFocusedJsonPayload() {
    if (!chatGptPromptDialog) {
      return;
    }

    if (!navigator.clipboard) {
      setSaveFeedback({
        kind: "error",
        message: "Clipboard copy is not available in this browser."
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(chatGptPromptDialog.jsonText);
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: "JSON payload copied. Focused comments marked as exported."
      });
    } catch (error) {
      setSaveFeedback({
        kind: "error",
        message: getProjectErrorMessage(error)
      });
    }
  }

  async function handleSaveFocusedJsonPayload() {
    if (!projectHandle || !chatGptPromptDialog) {
      return;
    }

    try {
      const filePath = await writeProjectContextPack({
        contents: chatGptPromptDialog.jsonText,
        fileName: chatGptPromptDialog.payloadFileName,
        project: projectHandle
      });
      await markFocusedExportCommentsAsExported(chatGptPromptDialog);
      setSaveFeedback({
        kind: "success",
        message: `JSON payload saved to ${filePath}. Focused comments marked as exported.`
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setSaveFeedback({
        kind: "error",
        message
      });
    }
  }

  function handleOpenChatGptImportDialog() {
    if (!projectHandle) {
      setSaveFeedback({
        kind: "info",
        message: "ChatGPT response import is available in Project Folder Mode."
      });
      return;
    }

    setChatGptImportDialog({
      error: null,
      responseJson: "",
      sourceChatUrl: ""
    });
  }

  async function handleImportChatGptResponse(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!projectHandle || !chatGptImportDialog || isCommentBusy) {
      return;
    }

    let parsedResponse: PatchmarkCommentReplyImport;
    let sourceChatUrl: string | undefined;

    try {
      parsedResponse = parsePatchmarkCommentReplyImport(
        chatGptImportDialog.responseJson
      );
      sourceChatUrl = normalizeSourceChatUrl(
        chatGptImportDialog.sourceChatUrl
      );
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setChatGptImportDialog({
        ...chatGptImportDialog,
        error: message
      });
      setSaveFeedback({
        kind: "error",
        message
      });
      return;
    }

    setIsCommentBusy(true);
    setCommentsError(null);
    setSaveFeedback(null);

    try {
      const importedAt = new Date().toISOString();
      const importId = createCommentImportId(importedAt);
      const safeTimestamp = createFileSafeTimestamp(importedAt);
      const knownCommentIds = new Set(comments.map((comment) => comment.id));
      const unknownCommentIds = getUnknownImportCommentIds(
        parsedResponse,
        knownCommentIds
      );
      const importedCommentIds = getKnownImportCommentIds(
        parsedResponse,
        knownCommentIds
      );
      const existingPatches = await readProjectPatches(projectHandle);
      const importedPatches = createImportedPatchProposals({
        existingPatches,
        importedAt,
        importId,
        knownCommentIds,
        patchProposals: parsedResponse.patch_proposals,
        sourceChatUrl
      });
      const { nextComments, openQuestionsAttached, repliesAttached } =
        createImportedCommentThreads({
          comments,
          importedAt,
          importId,
          importedCommentIds,
          openQuestions: parsedResponse.open_questions,
          replies: parsedResponse.replies,
          sourceChatUrl
        });
      const importWarnings = unknownCommentIds.map(
        (commentId) =>
          `Response referenced a comment that was not found: ${commentId}`
      );
      const importWrapper = {
        import_id: importId,
        imported_at: importedAt,
        source_chat_url: sourceChatUrl,
        raw_response: parsedResponse,
        warnings: importWarnings
      };

      await writeProjectImport({
        contents: `${JSON.stringify(importWrapper, null, 2)}\n`,
        fileName: `${safeTimestamp}-comment-reply-import.json`,
        project: projectHandle
      });

      if (importedPatches.length > 0) {
        await writeProjectPatches(projectHandle, [
          ...existingPatches,
          ...importedPatches
        ]);
      }

      await writeProjectComments(projectHandle, nextComments);

      setComments(nextComments);
      setPatches([...existingPatches, ...importedPatches]);
      setChatGptImportDialog(null);
      setSaveFeedback({
        kind: importWarnings.length > 0 ? "info" : "success",
        message: createChatGptImportSummaryMessage({
          openQuestionsAttached,
          patchProposalsStored: importedPatches.length,
          repliesAttached,
          warnings: importWarnings
        })
      });
    } catch (error) {
      const message = getProjectErrorMessage(error);
      setCommentsError(message);
      setChatGptImportDialog({
        ...chatGptImportDialog,
        error: message
      });
      setSaveFeedback({
        kind: "error",
        message
      });
    } finally {
      setIsCommentBusy(false);
    }
  }

  async function markFocusedExportCommentsAsExported(
    exportDialog: ChatGptPromptDialogState
  ) {
    const exportedCommentIds = new Set(exportDialog.commentIds);
    const nextComments = comments.map((comment) =>
      exportedCommentIds.has(comment.id) && comment.status === "open"
        ? {
            ...comment,
            export_state: {
              ...comment.export_state,
              focus_state: "exported" as const,
              last_exported_at: exportDialog.exportedAt,
              last_export_id: exportDialog.exportId
            },
            updated_at: exportDialog.exportedAt
          }
        : comment
    );

    await persistComments(nextComments, "Marked focused comments as exported.");
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
      thread: [],
      export_state: {
        focus_state: "idle"
      },
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
            anchor: refreshCommentAnchorActionContext(
              comment.anchor,
              values.type
            ),
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
            export_state: {
              ...comment.export_state,
              focus_state: "idle" as const,
              marked_for_export_at: undefined
            },
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
            export_state: {
              ...comment.export_state,
              focus_state: "idle" as const,
              marked_for_export_at: undefined
            },
            resolved_at: undefined,
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Reopened comment.");
  }

  async function handleReplyToComment(commentId: string, content: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId && comment.status === "open"
        ? {
            ...comment,
            thread: [
              ...comment.thread,
              {
                id: createNextThreadEntryId(comment),
                role: "user" as const,
                content,
                created_at: now
              }
            ],
            export_state: {
              ...comment.export_state,
              focus_state: "in_focus" as const,
              marked_for_export_at: now
            },
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Added reply and marked comment for ChatGPT.");
  }

  async function handleMarkCommentForExport(commentId: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId && comment.status === "open"
        ? {
            ...comment,
            export_state: {
              ...comment.export_state,
              focus_state: "in_focus" as const,
              marked_for_export_at: now
            },
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Marked comment for ChatGPT.");
  }

  async function handleUnmarkCommentForExport(commentId: string) {
    const now = new Date().toISOString();
    const nextComments = comments.map((comment) =>
      comment.id === commentId && comment.status === "open"
        ? {
            ...comment,
            export_state: {
              ...comment.export_state,
              focus_state: "idle" as const,
              marked_for_export_at: undefined
            },
            updated_at: now
          }
        : comment
    );

    await persistComments(nextComments, "Removed comment from ChatGPT export queue.");
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
        message: resolution.detail ?? "Open Markdown Mode and review manually."
      });
      return;
    }

    if (
      comment.anchor.kind === "selected_text" &&
      resolution.contextStart !== undefined
    ) {
      jumpToMarkdownSelection(
        resolution.contextStart,
        resolution.contextEnd ?? resolution.contextStart
      );
      setSaveFeedback({
        kind: "info",
        message: "Exact selected text was not found. Showing anchor context."
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

    const selectedDraft =
      commentContextMenu.selectedDraft?.anchorSource === "visual"
        ? commentContextMenu.selectedDraft
        : null;
    const positionTop = measurePendingCommentTop({
      scope,
      selectedDraft: commentContextMenu.selectedDraft,
      targetHeadingLine: commentContextMenu.defaultHeadingLine
    });

    setVisualSelectionDraft(
      selectedDraft
    );
    setCommentAddRequest({
      nonce: Date.now(),
      positionTop,
      scope,
      targetHeadingLine: commentContextMenu.defaultHeadingLine
    });
    setCommentContextMenu(null);
  }

  function measurePendingCommentTop({
    scope,
    selectedDraft,
    targetHeadingLine
  }: {
    scope: CommentAnchorScope;
    selectedDraft: SelectedCommentAnchorDraft | null;
    targetHeadingLine: number | null;
  }): number | null {
    const container = editorDocumentRef.current;
    const workspace = documentWorkspaceRef.current;

    if (!container || !workspace) {
      return scope === "document" ? 0 : null;
    }

    try {
      const anchor = createCommentAnchor({
        headings,
        markdown,
        selection: markdownSelection,
        selectedDraft,
        values: {
          anchorScope: scope,
          comment: "",
          targetHeadingLine,
          type: "note"
        }
      });
      const previewComment: PatchmarkComment = {
        id: "PM-COMMENT-DRAFT",
        type: "note",
        status: "open",
        anchor,
        comment: "",
        thread: [],
        export_state: {
          focus_state: "idle"
        },
        created_at: "",
        updated_at: ""
      };
      const workspaceRect = workspace.getBoundingClientRect();
      const editorRect = container.getBoundingClientRect();
      const editorTop = Math.max(0, editorRect.top - workspaceRect.top);

      return computeCommentPreferredTop({
        comment: previewComment,
        container,
        editorTop,
        headings,
        markdown,
        mode,
        workspaceRect
      });
    } catch {
      return scope === "document" ? 0 : null;
    }
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
    setPatches([]);
    setCommentsError(null);
    setChatGptPromptDialog(null);
    setChatGptImportDialog(null);
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
            <button
              type="button"
              disabled={isSaving || isCommentBusy}
              onClick={handleGenerateChatGptPrompt}
            >
              Generate ChatGPT Prompt
            </button>
            <button
              type="button"
              disabled={isSaving || isCommentBusy}
              onClick={handleOpenChatGptImportDialog}
            >
              Import ChatGPT Response
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
          onMarkCommentForExport={handleMarkCommentForExport}
          onReopenComment={handleReopenComment}
          onReplyComment={handleReplyToComment}
          onResolveComment={handleResolveComment}
          onUnmarkCommentForExport={handleUnmarkCommentForExport}
          pendingPatchCountsByCommentId={pendingPatchCountsByCommentId}
          selectedTextPreview={selectedCommentText || null}
          selectedAnchorContextKind={selectedCommentAnchorContextKind}
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

      {chatGptPromptDialog ? (
        <div className="snapshot-dialog-backdrop">
          <section
            className="comment-export-dialog"
            aria-label="Generate ChatGPT prompt"
          >
            <header className="snapshot-dialog-header">
              <div>
                <span>Focused comments</span>
                <h2>Generate ChatGPT Prompt</h2>
                <p>
                  This Markdown prompt is ready to paste into ChatGPT. Copying
                  or saving marks focused comments as exported, but does not
                  resolve them.
                </p>
              </div>
              <button type="button" onClick={() => setChatGptPromptDialog(null)}>
                Close
              </button>
            </header>
            <div className="comment-export-actions">
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleCopyChatGptPrompt}
              >
                Copy Prompt
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleSaveChatGptPrompt}
              >
                Save Prompt
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleCopyFocusedJsonPayload}
              >
                Copy JSON Payload
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={handleSaveFocusedJsonPayload}
              >
                Save JSON Payload
              </button>
              <span>{chatGptPromptDialog.promptFileName}</span>
            </div>
            <label className="comment-export-json">
              <span>Generated prompt</span>
              <textarea readOnly value={chatGptPromptDialog.promptText} />
            </label>
            <details className="comment-export-payload-details">
              <summary>JSON Payload</summary>
              <textarea readOnly value={chatGptPromptDialog.jsonText} />
            </details>
          </section>
        </div>
      ) : null}

      {chatGptImportDialog ? (
        <div className="snapshot-dialog-backdrop">
          <form
            className="comment-import-dialog"
            aria-label="Import ChatGPT response"
            onSubmit={handleImportChatGptResponse}
          >
            <header className="snapshot-dialog-header">
              <div>
                <span>Focused comments</span>
                <h2>Import ChatGPT Response</h2>
                <p>
                  Paste the JSON response from ChatGPT. Patchmark will attach
                  replies to matching comments and store patch proposals for
                  review.
                </p>
              </div>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={() => setChatGptImportDialog(null)}
              >
                Cancel
              </button>
            </header>
            {chatGptImportDialog.error ? (
              <p className="comment-import-error" role="alert">
                {chatGptImportDialog.error}
              </p>
            ) : null}
            <div className="comment-import-fields">
              <label>
                <span>Optional ChatGPT chat URL</span>
                <input
                  type="url"
                  placeholder="https://chatgpt.com/..."
                  value={chatGptImportDialog.sourceChatUrl}
                  onChange={(event) =>
                    setChatGptImportDialog({
                      ...chatGptImportDialog,
                      error: null,
                      sourceChatUrl: event.target.value
                    })
                  }
                />
              </label>
              <label>
                <span>ChatGPT response JSON</span>
                <textarea
                  required
                  value={chatGptImportDialog.responseJson}
                  onChange={(event) =>
                    setChatGptImportDialog({
                      ...chatGptImportDialog,
                      error: null,
                      responseJson: event.target.value
                    })
                  }
                />
              </label>
            </div>
            <div className="comment-import-actions">
              <button type="submit" disabled={isCommentBusy}>
                Import
              </button>
              <button
                type="button"
                disabled={isCommentBusy}
                onClick={() => setChatGptImportDialog(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
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

function getDraftMarkdownStartOffset(
  draft: SelectedCommentAnchorDraft | null
): number | undefined {
  return (
    draft?.markdownStartOffset ?? draft?.anchorContext.markdown_start_offset
  );
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

function createNextThreadEntryId(comment: PatchmarkComment): string {
  const nextNumber =
    comment.thread.reduce((maxNumber, entry) => {
      const match = /^PM-THREAD-(\d+)$/.exec(entry.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) + 1;

  return `PM-THREAD-${String(nextNumber).padStart(4, "0")}`;
}

function getFocusedCommentsForExport(
  comments: PatchmarkComment[]
): PatchmarkComment[] {
  return comments.filter(
    (comment) =>
      comment.status === "open" &&
      (comment.export_state.focus_state === "in_focus" ||
        comment.export_state.focus_state === "awaiting_reply")
  );
}

function createCommentExportId(exportedAt: string): string {
  return `comment-export-${createFileSafeTimestamp(exportedAt)}`;
}

function createFileSafeTimestamp(exportedAt: string): string {
  return exportedAt
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "-$1")
    .replace("T", "-")
    .replace("Z", "");
}

function createFocusedCommentsChatGptPrompt(jsonText: string): string {
  return `# Patchmark Focused Comments Review

You are helping review and improve a Markdown document through Patchmark.

Patchmark is the source of truth for the document. You are not editing the document directly. You are replying to focused comments and, when useful, proposing reviewable patches.

Patchmark is the document control layer. ChatGPT is the reasoning/review layer. The human user is the bridge.

## Collaboration Rules

- Reply to each exported comment by \`comment_id\`.
- Do not resolve comments.
- Only the human user can resolve comments in Patchmark.
- If a comment needs clarification, ask a question linked to that \`comment_id\`.
- If you suggest a document change, return a patch proposal linked to the \`comment_id\`.
- Patch proposals must use exact Markdown from the supplied context as \`original_text\`.
- Do not rewrite the whole document unless explicitly requested.
- Preserve Markdown structure.
- Be clear about reason and risk/tradeoff.
- Drafting support only. Legal review may still be required.

## Required Response Format

Return only valid JSON.

Do not wrap the JSON in Markdown fences.

Use this exact protocol:

\`\`\`json
{
  "protocol": "patchmark.comment_reply_import",
  "protocol_version": 1,
  "summary": "Brief summary of what you did.",
  "replies": [
    {
      "comment_id": "PM-COMMENT-0001",
      "reply": "Your reply to the comment.",
      "suggested_user_action": "review"
    }
  ],
  "patch_proposals": [
    {
      "comment_id": "PM-COMMENT-0001",
      "target_heading": "## Example Heading",
      "original_text": "Exact Markdown text to replace.",
      "suggested_text": "Replacement Markdown text.",
      "reason": "Why this change helps.",
      "risk": "Tradeoff or caution."
    }
  ],
  "open_questions": [
    {
      "comment_id": "PM-COMMENT-0001",
      "question": "Question for the human user."
    }
  ]
}
\`\`\`

Allowed \`suggested_user_action\` values:

- \`review\`
- \`clarify\`
- \`apply_patch\`
- \`keep_open\`
- \`resolve_manually\`

If no patch is needed, return an empty \`patch_proposals\` array.

If no clarification is needed, return an empty \`open_questions\` array.

Remember: you may suggest \`resolve_manually\`, but you must not claim the comment is resolved. Only the human user resolves comments in Patchmark.

## Patchmark Export Payload

\`\`\`json
${jsonText.trimEnd()}
\`\`\`
`;
}

function parsePatchmarkCommentReplyImport(
  rawInput: string
): PatchmarkCommentReplyImport {
  let parsedResponse: unknown;

  try {
    parsedResponse = JSON.parse(stripMarkdownJsonFence(rawInput));
  } catch {
    throw new Error("Invalid JSON. Paste a valid ChatGPT JSON response.");
  }

  if (!isRecord(parsedResponse)) {
    throw new Error("Invalid Patchmark response. Expected a JSON object.");
  }

  if (parsedResponse.protocol !== "patchmark.comment_reply_import") {
    throw new Error(
      "Invalid Patchmark response. Expected protocol `patchmark.comment_reply_import`."
    );
  }

  if (parsedResponse.protocol_version !== 1) {
    throw new Error(
      "Invalid Patchmark response. Expected protocol_version 1."
    );
  }

  if (
    !Array.isArray(parsedResponse.replies) ||
    !Array.isArray(parsedResponse.patch_proposals) ||
    !Array.isArray(parsedResponse.open_questions)
  ) {
    throw new Error(
      "Invalid Patchmark response. Expected replies, patch_proposals, and open_questions arrays."
    );
  }

  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary:
      typeof parsedResponse.summary === "string"
        ? parsedResponse.summary
        : undefined,
    replies: parsedResponse.replies.map(normalizeImportedReply),
    patch_proposals:
      parsedResponse.patch_proposals.map(normalizeImportedPatchProposal),
    open_questions:
      parsedResponse.open_questions.map(normalizeImportedOpenQuestion)
  };
}

function stripMarkdownJsonFence(rawInput: string): string {
  const trimmedInput = rawInput.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmedInput);

  return fencedMatch ? fencedMatch[1].trim() : trimmedInput;
}

function normalizeImportedReply(
  reply: unknown
): PatchmarkCommentReplyImport["replies"][number] {
  if (
    !isRecord(reply) ||
    typeof reply.comment_id !== "string" ||
    typeof reply.reply !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each reply needs comment_id and reply."
    );
  }

  return {
    comment_id: reply.comment_id,
    reply: reply.reply,
    suggested_user_action: isSuggestedUserAction(reply.suggested_user_action)
      ? reply.suggested_user_action
      : undefined
  };
}

function normalizeImportedPatchProposal(
  patchProposal: unknown
): PatchmarkCommentReplyImport["patch_proposals"][number] {
  if (
    !isRecord(patchProposal) ||
    typeof patchProposal.comment_id !== "string" ||
    typeof patchProposal.original_text !== "string" ||
    typeof patchProposal.suggested_text !== "string" ||
    typeof patchProposal.reason !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each patch proposal needs comment_id, original_text, suggested_text, and reason."
    );
  }

  return {
    comment_id: patchProposal.comment_id,
    target_heading:
      typeof patchProposal.target_heading === "string"
        ? patchProposal.target_heading
        : undefined,
    original_text: patchProposal.original_text,
    suggested_text: patchProposal.suggested_text,
    reason: patchProposal.reason,
    risk:
      typeof patchProposal.risk === "string" ? patchProposal.risk : undefined
  };
}

function normalizeImportedOpenQuestion(
  openQuestion: unknown
): PatchmarkCommentReplyImport["open_questions"][number] {
  if (
    !isRecord(openQuestion) ||
    typeof openQuestion.comment_id !== "string" ||
    typeof openQuestion.question !== "string"
  ) {
    throw new Error(
      "Invalid Patchmark response. Each open question needs comment_id and question."
    );
  }

  return {
    comment_id: openQuestion.comment_id,
    question: openQuestion.question
  };
}

function normalizeSourceChatUrl(sourceChatUrl: string): string | undefined {
  const trimmedUrl = sourceChatUrl.trim();

  if (!trimmedUrl) {
    return undefined;
  }

  try {
    const url = new URL(trimmedUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Invalid protocol.");
    }

    return url.toString();
  } catch {
    throw new Error("Source ChatGPT URL must be a valid http(s) URL.");
  }
}

function createCommentImportId(importedAt: string): string {
  return `PM-IMPORT-${createFileSafeTimestamp(importedAt)}`;
}

function getUnknownImportCommentIds(
  response: PatchmarkCommentReplyImport,
  knownCommentIds: Set<string>
): string[] {
  const referencedCommentIds = [
    ...response.replies.map((reply) => reply.comment_id),
    ...response.patch_proposals.map((patchProposal) => patchProposal.comment_id),
    ...response.open_questions.map((openQuestion) => openQuestion.comment_id)
  ];

  return Array.from(
    new Set(
      referencedCommentIds.filter((commentId) => !knownCommentIds.has(commentId))
    )
  );
}

function getKnownImportCommentIds(
  response: PatchmarkCommentReplyImport,
  knownCommentIds: Set<string>
): Set<string> {
  return new Set(
    [
      ...response.replies.map((reply) => reply.comment_id),
      ...response.patch_proposals.map((patchProposal) => patchProposal.comment_id),
      ...response.open_questions.map((openQuestion) => openQuestion.comment_id)
    ].filter((commentId) => knownCommentIds.has(commentId))
  );
}

function createImportedCommentThreads({
  comments,
  importedAt,
  importId,
  importedCommentIds,
  openQuestions,
  replies,
  sourceChatUrl
}: {
  comments: PatchmarkComment[];
  importedAt: string;
  importId: string;
  importedCommentIds: Set<string>;
  openQuestions: PatchmarkCommentReplyImport["open_questions"];
  replies: PatchmarkCommentReplyImport["replies"];
  sourceChatUrl?: string;
}): {
  nextComments: PatchmarkComment[];
  openQuestionsAttached: number;
  repliesAttached: number;
} {
  let openQuestionsAttached = 0;
  let repliesAttached = 0;

  const nextComments = comments.map((comment) => {
    const matchingReplies = replies.filter(
      (reply) => reply.comment_id === comment.id
    );
    const matchingOpenQuestions = openQuestions.filter(
      (openQuestion) => openQuestion.comment_id === comment.id
    );

    if (
      matchingReplies.length === 0 &&
      matchingOpenQuestions.length === 0 &&
      !importedCommentIds.has(comment.id)
    ) {
      return comment;
    }

    let nextThread = comment.thread;

    for (const reply of matchingReplies) {
      nextThread = [
        ...nextThread,
        createChatGptThreadEntry({
          content: reply.reply,
          createdAt: importedAt,
          importId,
          sourceChatUrl,
          suggestedUserAction: reply.suggested_user_action,
          thread: nextThread
        })
      ];
      repliesAttached += 1;
    }

    for (const openQuestion of matchingOpenQuestions) {
      nextThread = [
        ...nextThread,
        createChatGptThreadEntry({
          content: `Question: ${openQuestion.question}`,
          createdAt: importedAt,
          importId,
          sourceChatUrl,
          suggestedUserAction: "clarify",
          thread: nextThread
        })
      ];
      openQuestionsAttached += 1;
    }

    return {
      ...comment,
      thread: nextThread,
      export_state: {
        ...comment.export_state,
        focus_state: "reply_received" as const,
        marked_for_export_at: undefined,
        last_imported_at: importedAt,
        last_import_id: importId
      },
      updated_at: importedAt
    };
  });

  return {
    nextComments,
    openQuestionsAttached,
    repliesAttached
  };
}

function createChatGptThreadEntry({
  content,
  createdAt,
  importId,
  sourceChatUrl,
  suggestedUserAction,
  thread
}: {
  content: string;
  createdAt: string;
  importId: string;
  sourceChatUrl?: string;
  suggestedUserAction?: PatchmarkSuggestedUserAction;
  thread: PatchmarkCommentThreadEntry[];
}): PatchmarkCommentThreadEntry {
  return {
    id: createNextThreadEntryIdFromEntries(thread),
    role: "chatgpt",
    content,
    created_at: createdAt,
    source_import_id: importId,
    source_chat_url: sourceChatUrl,
    suggested_user_action: suggestedUserAction
  };
}

function createImportedPatchProposals({
  existingPatches,
  importedAt,
  importId,
  knownCommentIds,
  patchProposals,
  sourceChatUrl
}: {
  existingPatches: PatchmarkPatch[];
  importedAt: string;
  importId: string;
  knownCommentIds: Set<string>;
  patchProposals: PatchmarkCommentReplyImport["patch_proposals"];
  sourceChatUrl?: string;
}): PatchmarkPatch[] {
  return patchProposals
    .filter((patchProposal) => knownCommentIds.has(patchProposal.comment_id))
    .map((patchProposal, index) => ({
      id: createNextPatchId(existingPatches, index),
      status: "pending" as const,
      comment_id: patchProposal.comment_id,
      source_import_id: importId,
      source_chat_url: sourceChatUrl,
      target_heading: patchProposal.target_heading,
      original_text: patchProposal.original_text,
      suggested_text: patchProposal.suggested_text,
      reason: patchProposal.reason,
      risk: patchProposal.risk,
      created_at: importedAt
    }));
}

function createNextThreadEntryIdFromEntries(
  thread: PatchmarkCommentThreadEntry[]
): string {
  const nextNumber =
    thread.reduce((maxNumber, entry) => {
      const match = /^PM-THREAD-(\d+)$/.exec(entry.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) + 1;

  return `PM-THREAD-${String(nextNumber).padStart(4, "0")}`;
}

function createNextPatchId(
  patches: PatchmarkPatch[],
  offset: number
): string {
  const nextNumber =
    patches.reduce((maxNumber, patch) => {
      const match = /^PM-PATCH-(\d+)$/.exec(patch.id);

      if (!match) {
        return maxNumber;
      }

      return Math.max(maxNumber, Number(match[1]));
    }, 0) +
    offset +
    1;

  return `PM-PATCH-${String(nextNumber).padStart(4, "0")}`;
}

function getPendingPatchCountsByCommentId(
  patches: PatchmarkPatch[]
): Record<string, number> {
  return patches.reduce<Record<string, number>>((counts, patch) => {
    if (patch.status !== "pending" || !patch.comment_id) {
      return counts;
    }

    counts[patch.comment_id] = (counts[patch.comment_id] ?? 0) + 1;
    return counts;
  }, {});
}

function createChatGptImportSummaryMessage({
  openQuestionsAttached,
  patchProposalsStored,
  repliesAttached,
  warnings
}: ChatGptImportSummary): string {
  const summary = [
    "Imported ChatGPT response.",
    `Replies attached: ${repliesAttached}`,
    `Open questions attached: ${openQuestionsAttached}`,
    `Patch proposals stored: ${patchProposalsStored}`,
    `Warnings: ${warnings.length}`
  ];

  if (warnings.length > 0) {
    summary.push(`Some response items referenced comments that were not found: ${
      warnings
        .map((warning) => warning.split(": ").at(-1))
        .filter(Boolean)
        .join(", ")
    }`);
  }

  return summary.join(" ");
}

function isSuggestedUserAction(
  value: unknown
): value is PatchmarkSuggestedUserAction {
  return (
    typeof value === "string" &&
    [
      "review",
      "clarify",
      "apply_patch",
      "keep_open",
      "resolve_manually"
    ].includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createFocusedCommentsExportPayload({
  comments,
  exportedAt,
  exportId,
  headings,
  markdown,
  project
}: {
  comments: PatchmarkComment[];
  exportedAt: string;
  exportId: string;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
  project: PatchmarkProjectHandle;
}) {
  return {
    protocol: "patchmark.comment_export",
    protocol_version: 1,
    export_id: exportId,
    project: {
      project_name: project.manifest.project_name,
      document_file: project.manifest.document_file,
      exported_at: exportedAt
    },
    instructions_for_chatgpt: {
      role:
        "You are helping review and improve a Markdown document through Patchmark comments.",
      rules: [
        "Reply to each exported comment by comment_id.",
        "Do not resolve comments. Only the human resolves comments.",
        "If you suggest a document change, return a patch proposal linked to the comment_id.",
        "If more information is needed, ask a clarification question linked to the comment_id.",
        "Preserve Markdown structure.",
        "Drafting support only. Legal review may still be required."
      ],
      expected_response_format: "patchmark.comment_reply_import"
    },
    comments: comments.map((comment) =>
      createFocusedCommentExportEntry({
        comment,
        headings,
        markdown
      })
    )
  };
}

function createFocusedCommentExportEntry({
  comment,
  headings,
  markdown
}: {
  comment: PatchmarkComment;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}) {
  const actionContext =
    comment.anchor.action_context ??
    getDefaultCommentActionContext(comment.type, comment.anchor.kind);

  return {
    comment_id: comment.id,
    type: comment.type,
    intent: actionContext.intent_hint,
    anchor: createExportAnchor(comment.anchor),
    action_context: actionContext,
    comment: comment.comment,
    thread: comment.thread.map(createExportThreadEntry),
    context: createExportContext({
      actionContext,
      anchor: comment.anchor,
      headings,
      markdown
    })
  };
}

function createExportThreadEntry(entry: PatchmarkCommentThreadEntry) {
  return {
    id: entry.id,
    role: entry.role,
    content: entry.content,
    created_at: entry.created_at
  };
}

function createExportAnchor(anchor: PatchmarkCommentAnchor) {
  if (anchor.kind === "document") {
    return {
      kind: "document"
    };
  }

  if (anchor.kind === "section") {
    return {
      kind: "section",
      heading: anchor.heading,
      heading_level: anchor.heading_level,
      heading_line: anchor.heading_line,
      heading_path: anchor.heading_path
    };
  }

  return {
    kind: "selected_text",
    selected_text: anchor.selected_text,
    anchor_context: anchor.anchor_context,
    containing_heading: anchor.containing_heading,
    containing_heading_level: anchor.containing_heading_level,
    containing_heading_line: anchor.containing_heading_line,
    containing_heading_path: anchor.containing_heading_path,
    anchor_source: anchor.anchor_source
  };
}

function createExportContext({
  actionContext,
  anchor,
  headings,
  markdown
}: {
  actionContext: PatchmarkCommentActionContext;
  anchor: PatchmarkCommentAnchor;
  headings: ReturnType<typeof parseMarkdownHeadings>;
  markdown: string;
}) {
  const containingSectionMarkdown = getContainingSectionMarkdown(
    anchor,
    markdown,
    headings
  );

  return {
    document_brief: null,
    display_target: getCommentDisplayTarget(anchor),
    anchor_context:
      anchor.kind === "selected_text" ? anchor.anchor_context ?? null : null,
    containing_section_markdown:
      actionContext.default_scope === "containing_section"
        ? containingSectionMarkdown
        : null,
    full_document_markdown:
      actionContext.default_scope === "full_document" ? markdown : null,
    related_open_comments: []
  };
}

function getCommentDisplayTarget(anchor: PatchmarkCommentAnchor): string {
  if (anchor.kind === "document") {
    return "Whole document";
  }

  if (anchor.kind === "section") {
    return `${"#".repeat(anchor.heading_level ?? 1)} ${anchor.heading}`;
  }

  return anchor.selected_text;
}

function getContainingSectionMarkdown(
  anchor: PatchmarkCommentAnchor,
  markdown: string,
  headings: ReturnType<typeof parseMarkdownHeadings>
): string | null {
  if (anchor.kind === "document") {
    return null;
  }

  if (anchor.kind === "section") {
    const heading = findMatchingHeading(headings, {
      level: anchor.heading_level,
      text: anchor.heading
    });

    if (!heading) {
      return null;
    }

    const sectionRange = getSectionRange(markdown, headings, heading);

    return markdown.slice(sectionRange.start, sectionRange.end);
  }

  const containingHeading = anchor.containing_heading
    ? findMatchingHeading(headings, {
        level: anchor.containing_heading_level,
        text: anchor.containing_heading
      })
    : null;

  if (containingHeading) {
    const sectionRange = getSectionRange(markdown, headings, containingHeading);

    return markdown.slice(sectionRange.start, sectionRange.end);
  }

  if (
    typeof anchor.fallback_section_start_offset === "number" &&
    typeof anchor.fallback_section_end_offset === "number"
  ) {
    return markdown.slice(
      anchor.fallback_section_start_offset,
      anchor.fallback_section_end_offset
    );
  }

  if (typeof anchor.markdown_start_offset === "number") {
    const heading = getHeadingContainingOffset(
      markdown,
      headings,
      anchor.markdown_start_offset
    );

    if (heading) {
      const sectionRange = getSectionRange(markdown, headings, heading);

      return markdown.slice(sectionRange.start, sectionRange.end);
    }
  }

  return null;
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
  const anchorContext = createAnchorContextFromMarkdownRange(
    markdown,
    selectedRange
  );

  if (!anchorContext) {
    return {
      draft: null,
      help: SHORT_SELECTION_HELP
    };
  }

  return {
    draft: {
      anchorSource: "markdown",
      anchorContext,
      markdownEndOffset: selectedRange.end,
      markdownStartOffset: selectedRange.start,
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

  const anchorContext = createAnchorContextFromVisualSnapshot(snapshot, markdown);

  if (!anchorContext) {
    return {
      draft: null,
      help: SHORT_SELECTION_HELP
    };
  }

  const selectedOffsets = findSelectedMarkdownOffsetsFromAnchorContext(
    anchorContext,
    snapshot.selectedText
  );
  const selectedTextMatches = findExactTextMatches(markdown, snapshot.selectedText);
  const uniqueSelectedTextMatch =
    selectedTextMatches.length === 1 ? selectedTextMatches[0] : null;

  return {
    draft: {
      anchorSource: "visual",
      anchorContext,
      markdownEndOffset: selectedOffsets?.end ?? uniqueSelectedTextMatch?.end,
      markdownStartOffset: selectedOffsets?.start ?? uniqueSelectedTextMatch?.start,
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
      "p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6, pre, code"
    ) ?? null;
  const blockText = normalizeDomText(blockElement?.textContent ?? selectedText);
  const selectedRangeInBlock = blockElement
    ? getSelectionOffsetsInsideElement(blockElement, range, selectedText)
    : null;

  return {
    blockText,
    blockKind: getVisualAnchorContextKind(blockElement),
    selectedEndInBlock: selectedRangeInBlock?.end,
    selectedStartInBlock: selectedRangeInBlock?.start,
    selectedText
  };
}

function createAnchorContextFromMarkdownRange(
  markdown: string,
  selectedRange: { end: number; start: number }
): PatchmarkSelectedTextAnchorContext | null {
  const blockRange = getMarkdownBlockRange(markdown, selectedRange);
  const trimmedBlockRange = trimRange(markdown, blockRange.start, blockRange.end);
  const blockText = markdown.slice(trimmedBlockRange.start, trimmedBlockRange.end);
  const blockKind = getMarkdownAnchorContextKind(blockText);
  const sentenceRange = getSentenceRangeWithinText(
    markdown.slice(blockRange.start, blockRange.end),
    selectedRange.start - blockRange.start,
    selectedRange.end - blockRange.start
  );

  if (sentenceRange && blockKind === "paragraph") {
    const absoluteSentenceRange = trimRange(
      markdown,
      blockRange.start + sentenceRange.start,
      blockRange.start + sentenceRange.end
    );

    return createAnchorContextFromMarkdownContextRange({
      kind: "sentence",
      markdown,
      contextRange: absoluteSentenceRange,
      selectedRange
    });
  }

  if (!blockText.trim()) {
    return null;
  }

  return createAnchorContextFromMarkdownContextRange({
    kind: blockKind,
    markdown,
    contextRange: trimmedBlockRange,
    selectedRange
  });
}

function createAnchorContextFromMarkdownContextRange({
  contextRange,
  kind,
  markdown,
  selectedRange
}: {
  contextRange: { end: number; start: number };
  kind: PatchmarkSelectedTextAnchorContextKind;
  markdown: string;
  selectedRange: { end: number; start: number };
}): PatchmarkSelectedTextAnchorContext {
  const markdownText = markdown.slice(contextRange.start, contextRange.end);

  return {
    kind,
    plain_text: normalizeDomText(markdownText),
    markdown_text: markdownText,
    selected_start_in_context: Math.max(0, selectedRange.start - contextRange.start),
    selected_end_in_context: Math.max(0, selectedRange.end - contextRange.start),
    markdown_start_offset: contextRange.start,
    markdown_end_offset: contextRange.end
  };
}

function createAnchorContextFromVisualSnapshot(
  snapshot: VisualSelectionSnapshot,
  markdown: string
): PatchmarkSelectedTextAnchorContext | null {
  if (!snapshot.blockText.trim()) {
    return null;
  }

  const exactContextMatches = findExactTextMatches(markdown, snapshot.blockText);
  const markdownPlainContextMatches = findMarkdownPlainTextMatches(
    markdown,
    snapshot.blockText
  );
  const contextMatches = dedupeTextMatches([
    ...exactContextMatches,
    ...markdownPlainContextMatches
  ]);
  const uniqueContextMatch = contextMatches.length === 1 ? contextMatches[0] : null;

  return {
    kind: snapshot.blockKind,
    plain_text: snapshot.blockText,
    markdown_text: uniqueContextMatch
      ? markdown.slice(uniqueContextMatch.start, uniqueContextMatch.end)
      : undefined,
    selected_start_in_context: snapshot.selectedStartInBlock,
    selected_end_in_context: snapshot.selectedEndInBlock,
    markdown_start_offset: uniqueContextMatch?.start,
    markdown_end_offset: uniqueContextMatch?.end
  };
}

function findSelectedMarkdownOffsetsFromAnchorContext(
  anchorContext: PatchmarkSelectedTextAnchorContext,
  selectedText: string
): { end: number; start: number } | null {
  if (
    typeof anchorContext.markdown_start_offset === "number" &&
    typeof anchorContext.selected_start_in_context === "number" &&
    typeof anchorContext.selected_end_in_context === "number"
  ) {
    const start =
      anchorContext.markdown_start_offset + anchorContext.selected_start_in_context;
    const end =
      anchorContext.markdown_start_offset + anchorContext.selected_end_in_context;

    if (anchorContext.markdown_text?.slice(
      anchorContext.selected_start_in_context,
      anchorContext.selected_end_in_context
    ) === selectedText) {
      return { end, start };
    }
  }

  if (
    typeof anchorContext.markdown_start_offset !== "number" ||
    !anchorContext.markdown_text
  ) {
    return null;
  }

  const contextMatches = findExactTextMatches(
    anchorContext.markdown_text,
    selectedText
  );
  const uniqueContextMatch =
    contextMatches.length === 1 ? contextMatches[0] : null;

  return uniqueContextMatch
    ? {
        start: anchorContext.markdown_start_offset + uniqueContextMatch.start,
        end: anchorContext.markdown_start_offset + uniqueContextMatch.end
      }
    : null;
}

function getSelectionOffsetsInsideElement(
  element: Element,
  selectionRange: Range,
  selectedText: string
): { end: number; start: number } | null {
  const beforeSelectionRange = document.createRange();
  beforeSelectionRange.selectNodeContents(element);
  beforeSelectionRange.setEnd(
    selectionRange.startContainer,
    selectionRange.startOffset
  );

  const start = normalizeDomText(beforeSelectionRange.toString()).length;
  beforeSelectionRange.detach();

  const blockText = normalizeDomText(element.textContent ?? "");
  const directEnd = start + selectedText.length;

  if (blockText.slice(start, directEnd) === selectedText) {
    return {
      end: directEnd,
      start
    };
  }

  const selectedTextMatches = findExactTextMatches(blockText, selectedText);

  return selectedTextMatches.length === 1 ? selectedTextMatches[0] : null;
}

function getVisualAnchorContextKind(
  element: Element | null
): PatchmarkSelectedTextAnchorContextKind {
  if (!element) {
    return "block";
  }

  const tagName = element.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tagName)) {
    return "heading";
  }

  if (tagName === "li") {
    return "list_item";
  }

  if (tagName === "td" || tagName === "th") {
    return "table_cell";
  }

  if (tagName === "blockquote") {
    return "blockquote";
  }

  if (tagName === "p") {
    return "paragraph";
  }

  return "block";
}

function getMarkdownAnchorContextKind(
  markdownText: string
): PatchmarkSelectedTextAnchorContextKind {
  const trimmedMarkdown = markdownText.trim();

  if (/^#{1,6}\s+/.test(trimmedMarkdown)) {
    return "heading";
  }

  if (/^([-*+]\s+|\d+\.\s+)/.test(trimmedMarkdown)) {
    return "list_item";
  }

  if (/^\|.*\|$/.test(trimmedMarkdown)) {
    return "table_cell";
  }

  if (/^>/.test(trimmedMarkdown)) {
    return "blockquote";
  }

  return "paragraph";
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
  const preferredPositions: Record<string, number> = {};

  for (const comment of comments) {
    const top = computeCommentPreferredTop({
      comment,
      container,
      editorTop,
      headings,
      markdown,
      mode,
      workspaceRect
    });

    if (top !== null) {
      preferredPositions[comment.id] = top;
    }
  }

  return preferredPositions;
}

function computeCommentPreferredTop({
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
      const visualTextTop = findVisualSelectedTextTopForResolvedAnchor({
        anchor,
        container,
        markdown,
        resolution,
        workspaceRect
      });

      if (visualTextTop !== null) {
        return visualTextTop;
      }

      const visualContextTop = findVisualAnchorContextTopForResolvedAnchor({
        anchor,
        container,
        markdown,
        resolution,
        workspaceRect
      });

      if (visualContextTop !== null) {
        return visualContextTop;
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

  if (resolution.contextStart !== undefined) {
    if (mode === "visual") {
      const visualContextTop = findVisualAnchorContextTopForResolvedAnchor({
        anchor,
        container,
        markdown,
        resolution,
        workspaceRect
      });

      if (visualContextTop !== null) {
        return visualContextTop;
      }
    }

    return estimateTopForOffset(markdown, resolution.contextStart, editorTop);
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

function areCommentPositionsEqual(
  firstPositions: Record<string, number>,
  secondPositions: Record<string, number>
): boolean {
  const firstIds = Object.keys(firstPositions);
  const secondIds = Object.keys(secondPositions);

  if (firstIds.length !== secondIds.length) {
    return false;
  }

  return firstIds.every(
    (commentId) => firstPositions[commentId] === secondPositions[commentId]
  );
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

function findVisualSelectedTextTopForResolvedAnchor({
  anchor,
  container,
  markdown,
  resolution,
  workspaceRect
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  markdown: string;
  resolution: CommentAnchorResolution;
  workspaceRect: DOMRect;
}): number | null {
  const contextMatch = findVisualAnchorContextMatchForResolvedAnchor({
    anchor,
    container,
    markdown,
    resolution
  });

  if (contextMatch) {
    const selectedMatch = findVisualSelectedTextMatchInsideResolvedContext({
      anchor,
      container,
      contextMatch,
      markdown,
      resolution
    });

    if (selectedMatch) {
      return Math.max(0, selectedMatch.top - workspaceRect.top);
    }

    return Math.max(0, contextMatch.top - workspaceRect.top);
  }

  return findVisualSelectedTextTop({ anchor, container, workspaceRect });
}

function findVisualAnchorContextTop({
  anchor,
  container,
  workspaceRect
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  workspaceRect: DOMRect;
}): number | null {
  const contextMatch = findUniqueVisualAnchorContextMatch({ anchor, container });

  return contextMatch ? Math.max(0, contextMatch.top - workspaceRect.top) : null;
}

function findVisualAnchorContextTopForResolvedAnchor({
  anchor,
  container,
  markdown,
  resolution,
  workspaceRect
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  markdown: string;
  resolution: CommentAnchorResolution;
  workspaceRect: DOMRect;
}): number | null {
  const contextMatch = findVisualAnchorContextMatchForResolvedAnchor({
    anchor,
    container,
    markdown,
    resolution
  });

  if (contextMatch) {
    return Math.max(0, contextMatch.top - workspaceRect.top);
  }

  return findVisualAnchorContextTop({ anchor, container, workspaceRect });
}

function findUniqueVisualSelectedTextMatch({
  anchor,
  container
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
}): VisualTextMatch | null {
  const selectedMatches = findVisualTextMatches({
    container,
    searchText: anchor.selected_text
  });
  const contextMatches = findVisualAnchorContextMatches({ anchor, container });

  if (contextMatches.length === 1) {
    const selectedMatchesInsideContext = selectedMatches.filter((match) =>
      isRangeInsideRange(match.range, contextMatches[0].range)
    );

    if (selectedMatchesInsideContext.length === 1) {
      return selectedMatchesInsideContext[0];
    }

    return null;
  }

  if (contextMatches.length > 1) {
    return null;
  }

  return selectedMatches.length === 1 ? selectedMatches[0] : null;
}

function findVisualSelectedTextMatchInsideResolvedContext({
  anchor,
  container,
  contextMatch,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  contextMatch: VisualTextMatch;
  markdown: string;
  resolution: CommentAnchorResolution;
}): VisualTextMatch | null {
  const selectedMatchesInsideContext = findVisualTextMatches({
    container,
    searchText: anchor.selected_text
  }).filter((match) => isRangeInsideRange(match.range, contextMatch.range));

  if (selectedMatchesInsideContext.length <= 1) {
    return selectedMatchesInsideContext[0] ?? null;
  }

  const selectedOrdinal = getSelectedTextOrdinalInsideResolvedContext({
    anchor,
    markdown,
    resolution
  });

  return typeof selectedOrdinal === "number"
    ? selectedMatchesInsideContext[selectedOrdinal] ?? null
    : null;
}

function findVisualAnchorContextMatchForResolvedAnchor({
  anchor,
  container,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
  markdown: string;
  resolution: CommentAnchorResolution;
}): VisualTextMatch | null {
  const contextMatches = findVisualAnchorContextMatches({ anchor, container });

  if (contextMatches.length <= 1) {
    return contextMatches[0] ?? null;
  }

  const contextOrdinal = getAnchorContextOrdinalForResolution({
    anchor,
    markdown,
    resolution
  });

  return typeof contextOrdinal === "number"
    ? contextMatches[contextOrdinal] ?? null
    : null;
}

function getAnchorContextOrdinalForResolution({
  anchor,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  markdown: string;
  resolution: CommentAnchorResolution;
}): number | null {
  if (!anchor.anchor_context) {
    return null;
  }

  const contextMatches = findAnchorContextMatches(markdown, anchor.anchor_context);
  const resolvedContextStart =
    resolution.contextStart ??
    getContextStartContainingSelectedRange({
      contextMatches,
      selectedStart: resolution.start
    }) ??
    getStoredContextStartIfCurrent(markdown, anchor);

  if (typeof resolvedContextStart !== "number") {
    return null;
  }

  const contextOrdinal = contextMatches.findIndex(
    (match) => match.start === resolvedContextStart
  );

  return contextOrdinal >= 0 ? contextOrdinal : null;
}

function getSelectedTextOrdinalInsideResolvedContext({
  anchor,
  markdown,
  resolution
}: {
  anchor: SelectedTextAnchor;
  markdown: string;
  resolution: CommentAnchorResolution;
}): number | null {
  if (!anchor.anchor_context || typeof resolution.start !== "number") {
    return null;
  }

  const contextMatches = findAnchorContextMatches(markdown, anchor.anchor_context);
  const contextMatch = contextMatches.find(
    (match) =>
      resolution.start !== undefined &&
      resolution.start >= match.start &&
      resolution.start <= match.end
  );

  if (!contextMatch) {
    return null;
  }

  const selectedMatches = findSelectedTextMatchesInsideContext(
    markdown,
    contextMatch,
    anchor
  );
  const selectedOrdinal = selectedMatches.findIndex(
    (match) => match.start === resolution.start
  );

  return selectedOrdinal >= 0 ? selectedOrdinal : null;
}

function getContextStartContainingSelectedRange({
  contextMatches,
  selectedStart
}: {
  contextMatches: Array<{ end: number; start: number }>;
  selectedStart?: number;
}): number | null {
  if (typeof selectedStart !== "number") {
    return null;
  }

  return (
    contextMatches.find(
      (contextMatch) =>
        selectedStart >= contextMatch.start && selectedStart <= contextMatch.end
    )?.start ?? null
  );
}

function getStoredContextStartIfCurrent(
  markdown: string,
  anchor: SelectedTextAnchor
): number | null {
  const anchorContext = anchor.anchor_context;

  if (
    !anchorContext ||
    typeof anchorContext.markdown_start_offset !== "number" ||
    typeof anchorContext.markdown_end_offset !== "number" ||
    !anchorContext.markdown_text
  ) {
    return null;
  }

  return markdown.slice(
    anchorContext.markdown_start_offset,
    anchorContext.markdown_end_offset
  ) === anchorContext.markdown_text
    ? anchorContext.markdown_start_offset
    : null;
}

function findUniqueVisualAnchorContextMatch({
  anchor,
  container
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
}): VisualTextMatch | null {
  const contextMatches = findVisualAnchorContextMatches({ anchor, container });

  return contextMatches.length === 1 ? contextMatches[0] : null;
}

function findVisualAnchorContextMatches({
  anchor,
  container
}: {
  anchor: SelectedTextAnchor;
  container: HTMLElement;
}): VisualTextMatch[] {
  if (!anchor.anchor_context?.plain_text) {
    return [];
  }

  const matches = findVisualTextMatches({
    container,
    searchText: anchor.anchor_context.plain_text
  });

  if (
    matches.length === 0 &&
    anchor.anchor_context.markdown_text &&
    anchor.anchor_context.markdown_text !== anchor.anchor_context.plain_text
  ) {
    return findVisualTextMatches({
      container,
      searchText: anchor.anchor_context.markdown_text
    });
  }

  return matches;
}

function isRangeInsideRange(range: Range, containingRange: Range): boolean {
  return (
    range.compareBoundaryPoints(Range.START_TO_START, containingRange) >= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, containingRange) <= 0
  );
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
  contextEnd?: number;
  contextStart?: number;
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
      kind: "document",
      action_context: getDefaultCommentActionContext(values.type, "document")
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
      section_end_offset: sectionRange.end,
      action_context: getDefaultCommentActionContext(values.type, "section")
    };
  }

  const usableSelectedDraft =
    selectedDraft ?? createMarkdownSelectionDraft(markdown, selection);
  const selectedText =
    usableSelectedDraft?.selectedText ??
    markdown.slice(selection.start, selection.end);

  if (!selectedText.trim()) {
    throw new Error("Select text in the editor before saving this comment.");
  }

  if (!usableSelectedDraft?.anchorContext) {
    throw new Error(SHORT_SELECTION_HELP);
  }

  const markdownStartOffset = usableSelectedDraft
    ? usableSelectedDraft.markdownStartOffset
    : selection.start;
  const markdownEndOffset = usableSelectedDraft
    ? usableSelectedDraft.markdownEndOffset
    : selection.end;
  const contextStartOffset =
    usableSelectedDraft.anchorContext.markdown_start_offset;
  const contextEndOffset = usableSelectedDraft.anchorContext.markdown_end_offset;
  const containingHeadingFromSelection =
    typeof markdownStartOffset === "number"
      ? getHeadingContainingOffset(markdown, headings, markdownStartOffset)
      : undefined;
  const containingHeadingFromContext =
    typeof contextStartOffset === "number"
      ? getHeadingContainingOffset(markdown, headings, contextStartOffset)
      : undefined;
  const containingHeadingFromForm = values.targetHeadingLine
    ? headings.find((heading) => heading.line === values.targetHeadingLine)
    : undefined;

  const containingHeading =
    containingHeadingFromSelection ??
    containingHeadingFromContext ??
    containingHeadingFromForm;
  const fallbackSectionRange = containingHeading
    ? getSectionRange(markdown, headings, containingHeading)
    : null;
  const contextBeforeStart = markdownStartOffset ?? contextStartOffset;
  const contextAfterEnd = markdownEndOffset ?? contextEndOffset;

  return {
    kind: "selected_text",
    selected_text: selectedText,
    anchor_context: usableSelectedDraft.anchorContext,
    markdown_start_offset: markdownStartOffset,
    markdown_end_offset: markdownEndOffset,
    context_before:
      typeof contextBeforeStart !== "number"
        ? undefined
        : markdown.slice(
            Math.max(0, contextBeforeStart - ANCHOR_CONTEXT_CHARS),
            contextBeforeStart
          ),
    context_after:
      typeof contextAfterEnd !== "number"
        ? undefined
        : markdown.slice(
            contextAfterEnd,
            Math.min(markdown.length, contextAfterEnd + ANCHOR_CONTEXT_CHARS)
          ),
    containing_heading: containingHeading?.text,
    containing_heading_level: containingHeading?.level,
    containing_heading_line: containingHeading?.line,
    containing_heading_path: containingHeading
      ? getHeadingPath(headings, containingHeading)
      : undefined,
    anchor_source: usableSelectedDraft.anchorSource,
    fallback_section_start_offset: fallbackSectionRange?.start,
    fallback_section_end_offset: fallbackSectionRange?.end,
    action_context: getDefaultCommentActionContext(values.type, "selected_text")
  };
}

function getDefaultCommentActionContext(
  commentType: PatchmarkCommentType,
  anchorKind: PatchmarkCommentAnchor["kind"]
): PatchmarkCommentActionContext {
  return anchorKind === "document"
      ? {
          default_scope: "full_document",
          include_document_brief: true,
          include_open_comments: "focused_only",
          intent_hint: getActionIntentForCommentType(commentType)
        }
    : {
        default_scope: "containing_section",
        include_document_brief: true,
        include_open_comments: "same_section",
        intent_hint: getActionIntentForCommentType(commentType)
      };
}

function refreshCommentAnchorActionContext(
  anchor: PatchmarkCommentAnchor,
  commentType: PatchmarkCommentType
): PatchmarkCommentAnchor {
  return {
    ...anchor,
    action_context: {
      ...getDefaultCommentActionContext(commentType, anchor.kind),
      ...anchor.action_context,
      intent_hint: getActionIntentForCommentType(commentType)
    }
  };
}

function getActionIntentForCommentType(
  commentType: PatchmarkCommentType
): PatchmarkCommentActionIntent {
  if (commentType === "question" || commentType === "decision_needed") {
    return "decision";
  }

  if (commentType === "risk") {
    return "risk_review";
  }

  if (commentType === "research_needed") {
    return "research";
  }

  return "note";
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

  if (
    typeof offsetStart === "number" &&
    typeof offsetEnd === "number" &&
    markdown.slice(offsetStart, offsetEnd) === anchor.selected_text
  ) {
    return {
      end: offsetEnd,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      start: offsetStart,
      status: "active"
    };
  }

  const contextResolution = resolveSelectedAnchorViaContext(markdown, anchor);

  if (contextResolution.status === "active") {
    return {
      contextEnd: contextResolution.contextEnd,
      contextStart: contextResolution.contextStart,
      end: contextResolution.end,
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      start: contextResolution.start,
      status: "active"
    };
  }

  if (contextResolution.status === "ambiguous") {
    return {
      detail: "Could not identify a unique surrounding context.",
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "ambiguous"
    };
  }

  if (contextResolution.status === "context_found") {
    return {
      contextEnd: contextResolution.contextEnd,
      contextStart: contextResolution.contextStart,
      detail: "Exact selected text not found, surrounding context still exists.",
      label: `Selected text in ${getSelectedTextHeadingLabel(anchor)}`,
      status: "not_found"
    };
  }

  let matches = findExactTextMatches(markdown, anchor.selected_text);

  if (!anchor.anchor_context && matches.length > 1) {
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
      detail: anchor.anchor_context
        ? "Could not identify a unique surrounding context."
        : "Multiple matches for selected text.",
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

type SelectedAnchorContextResolution =
  | {
      contextEnd: number;
      contextStart: number;
      end: number;
      start: number;
      status: "active";
    }
  | {
      status: "ambiguous";
    }
  | {
      contextEnd: number;
      contextStart: number;
      status: "context_found";
    }
  | {
      status: "not_found";
    };

function resolveSelectedAnchorViaContext(
  markdown: string,
  anchor: SelectedTextAnchor
): SelectedAnchorContextResolution {
  if (!anchor.anchor_context) {
    return {
      status: "not_found"
    };
  }

  const contextMatches = findAnchorContextMatches(markdown, anchor.anchor_context);

  if (contextMatches.length === 0) {
    return {
      status: "not_found"
    };
  }

  const selectedMatches = contextMatches.flatMap((contextMatch) =>
    findSelectedTextMatchesInsideContext(markdown, contextMatch, anchor)
  );

  if (selectedMatches.length === 1) {
    return {
      ...selectedMatches[0],
      status: "active"
    };
  }

  if (selectedMatches.length > 1 || contextMatches.length > 1) {
    return {
      status: "ambiguous"
    };
  }

  return {
    contextEnd: contextMatches[0].end,
    contextStart: contextMatches[0].start,
    status: "context_found"
  };
}

function findAnchorContextMatches(
  markdown: string,
  anchorContext: PatchmarkSelectedTextAnchorContext
): Array<{ end: number; start: number }> {
  const matches: Array<{ end: number; start: number }> = [];

  if (
    typeof anchorContext.markdown_start_offset === "number" &&
    typeof anchorContext.markdown_end_offset === "number" &&
    anchorContext.markdown_text &&
    markdown.slice(
      anchorContext.markdown_start_offset,
      anchorContext.markdown_end_offset
    ) === anchorContext.markdown_text
  ) {
    matches.push({
      start: anchorContext.markdown_start_offset,
      end: anchorContext.markdown_end_offset
    });
  }

  if (anchorContext.markdown_text) {
    matches.push(...findExactTextMatches(markdown, anchorContext.markdown_text));
  }

  if (
    anchorContext.plain_text &&
    anchorContext.plain_text !== anchorContext.markdown_text
  ) {
    matches.push(...findExactTextMatches(markdown, anchorContext.plain_text));
    matches.push(...findNormalizedTextMatches(markdown, anchorContext.plain_text));
    matches.push(...findMarkdownPlainTextMatches(markdown, anchorContext.plain_text));
  }

  return dedupeTextMatches(matches);
}

function findSelectedTextMatchesInsideContext(
  markdown: string,
  contextMatch: { end: number; start: number },
  anchor: SelectedTextAnchor
): Array<{ contextEnd: number; contextStart: number; end: number; start: number }> {
  const contextText = markdown.slice(contextMatch.start, contextMatch.end);
  const directStart = anchor.anchor_context?.selected_start_in_context;
  const directEnd = anchor.anchor_context?.selected_end_in_context;

  if (
    typeof directStart === "number" &&
    typeof directEnd === "number" &&
    contextText.slice(directStart, directEnd) === anchor.selected_text
  ) {
    return [
      {
        contextEnd: contextMatch.end,
        contextStart: contextMatch.start,
        end: contextMatch.start + directEnd,
        start: contextMatch.start + directStart
      }
    ];
  }

  return findExactTextMatches(contextText, anchor.selected_text).map((match) => ({
    contextEnd: contextMatch.end,
    contextStart: contextMatch.start,
    end: contextMatch.start + match.end,
    start: contextMatch.start + match.start
  }));
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

function findNormalizedTextMatches(
  text: string,
  searchText: string
): Array<{ end: number; start: number }> {
  const textIndex = buildNormalizedSourceTextIndex(text);
  const normalizedSearchText = normalizeDomText(searchText);
  const matches: Array<{ end: number; start: number }> = [];

  if (!normalizedSearchText) {
    return matches;
  }

  let nextIndex = textIndex.text.indexOf(normalizedSearchText);

  while (nextIndex !== -1) {
    const start = textIndex.positions[nextIndex];
    const end = textIndex.positions[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end: end + 1
      });
    }

    nextIndex = textIndex.text.indexOf(
      normalizedSearchText,
      nextIndex + normalizedSearchText.length
    );
  }

  return matches;
}

function findMarkdownPlainTextMatches(
  markdown: string,
  searchText: string
): Array<{ end: number; start: number }> {
  const textIndex = buildMarkdownPlainTextIndex(markdown);
  const normalizedSearchText = normalizeDomText(searchText);
  const matches: Array<{ end: number; start: number }> = [];

  if (!normalizedSearchText) {
    return matches;
  }

  let nextIndex = textIndex.text.indexOf(normalizedSearchText);

  while (nextIndex !== -1) {
    const start = textIndex.positions[nextIndex];
    const end = textIndex.positions[nextIndex + normalizedSearchText.length - 1];

    if (typeof start === "number" && typeof end === "number") {
      matches.push({
        start,
        end: end + 1
      });
    }

    nextIndex = textIndex.text.indexOf(
      normalizedSearchText,
      nextIndex + normalizedSearchText.length
    );
  }

  return matches;
}

function buildMarkdownPlainTextIndex(markdown: string): {
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];
  const lines = markdown.split(/(\n)/);
  let markdownOffset = 0;

  for (const lineOrBreak of lines) {
    if (lineOrBreak === "\n") {
      appendNormalizedIndexedCharacter({
        character: " ",
        sourceOffset: markdownOffset,
        positions,
        textParts
      });
      markdownOffset += 1;
      continue;
    }

    const line = lineOrBreak;
    const prefixMatch = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/.exec(line);
    let index = prefixMatch?.[0].length ?? 0;

    while (index < line.length) {
      const character = line[index];

      if (character === "(" && index > 0 && line[index - 1] === "]") {
        const closingIndex = line.indexOf(")", index);
        index = closingIndex === -1 ? line.length : closingIndex + 1;
        continue;
      }

      if (/[*_`\[\]\|\\]/.test(character)) {
        index += 1;
        continue;
      }

      appendNormalizedIndexedCharacter({
        character,
        sourceOffset: markdownOffset + index,
        positions,
        textParts
      });
      index += 1;
    }

    markdownOffset += line.length;
  }

  trimNormalizedTextIndex(textParts, positions);

  return {
    positions,
    text: textParts.join("")
  };
}

function buildNormalizedSourceTextIndex(text: string): {
  positions: number[];
  text: string;
} {
  const textParts: string[] = [];
  const positions: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    appendNormalizedIndexedCharacter({
      character: text[index],
      sourceOffset: index,
      positions,
      textParts
    });
  }

  trimNormalizedTextIndex(textParts, positions);

  return {
    positions,
    text: textParts.join("")
  };
}

function appendNormalizedIndexedCharacter({
  character,
  positions,
  sourceOffset,
  textParts
}: {
  character: string;
  positions: number[];
  sourceOffset: number;
  textParts: string[];
}): void {
  const isWhitespace = /\s/.test(character);
  const previousCharacter = textParts[textParts.length - 1];

  if (isWhitespace) {
    if (textParts.length > 0 && previousCharacter !== " ") {
      textParts.push(" ");
      positions.push(sourceOffset);
    }

    return;
  }

  textParts.push(character);
  positions.push(sourceOffset);
}

function trimNormalizedTextIndex(
  textParts: string[],
  positions: number[]
): void {
  while (textParts[0] === " ") {
    textParts.shift();
    positions.shift();
  }

  while (textParts[textParts.length - 1] === " ") {
    textParts.pop();
    positions.pop();
  }
}

function dedupeTextMatches(
  matches: Array<{ end: number; start: number }>
): Array<{ end: number; start: number }> {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.start}:${match.end}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
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
