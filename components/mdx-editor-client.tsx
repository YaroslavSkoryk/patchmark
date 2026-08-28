"use client";

import {
  Component,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SyntheticEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { flushSync } from "react-dom";
import {
  DeferredMdxHeavyEditorProvider,
  deferredCodeBlockEditorDescriptor,
  deferredSemanticCodeBlockPlugin,
  prepareMarkdownForDeferredCodeImport
} from "@/components/deferred-mdx-heavy-editors";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  GenericJsxEditor,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  type MDXEditorMethods,
  type Translation,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  frontmatterPlugin,
  headingsPlugin,
  imagePlugin,
  jsxPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  realmPlugin,
  rootEditor$,
  setMarkdown$,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin
} from "@mdxeditor/editor";
import { CLEAR_HISTORY_COMMAND } from "lexical";
import { normalizeMarkdownForVisualEditor } from "@/lib/markdown/normalize-for-visual-editor";
import type {
  DocumentEditorReadinessIdentity,
  DocumentEditorReadyDetail
} from "@/components/document-editor-readiness";
import {
  getLatestEditPerformanceOperationId,
  incrementEditPerformanceCounter,
  markEditPerformanceOperation
} from "@/lib/performance/edit-performance";
import {
  getLatestDocumentSwitchPerformanceOperationId,
  incrementDocumentSwitchPerformanceCounter,
  markDocumentSwitchPerformance,
  recordDocumentSwitchPerformanceDuration
} from "@/lib/performance/document-switch-performance";

type MdxEditorClientProps = {
  ariaLabel?: string;
  documentReadiness?: DocumentEditorReadinessIdentity | null;
  editorDocumentKey?: string | null;
  markdown: string;
  onDocumentPending?: (detail: DocumentEditorReadyDetail) => void;
  onDocumentReady?: (detail: DocumentEditorReadyDetail) => void;
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  resetKey: number;
  selectionOnly?: boolean;
  showToolbar?: boolean;
};

const clearHistoryAfterDocumentResetPlugin = realmPlugin({
  init(realm) {
    realm.sub(setMarkdown$, () => {
      const editor = realm.getValue(rootEditor$);
      queueMicrotask(() => {
        editor?.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      });
    });
  }
});

const StableMdxEditor = memo(MDXEditor);

class MdxEditorRenderBoundary extends Component<
  { children: ReactNode; onRenderError: (error: unknown) => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onRenderError(error);
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

export function MdxEditorClient({
  ariaLabel = "editable markdown",
  documentReadiness = null,
  editorDocumentKey = null,
  markdown,
  onDocumentPending,
  onDocumentReady,
  onMarkdownChange,
  readOnly = false,
  resetKey,
  selectionOnly = false,
  showToolbar = true
}: MdxEditorClientProps) {
  const slice7aDiagnosticAblations = useMemo(() => {
    if (
      process.env.NODE_ENV === "production" ||
      typeof window === "undefined"
    ) {
      return new Set<string>();
    }
    return new Set(
      new URLSearchParams(window.location.search)
        .get("patchmarkSlice7aAblate")
        ?.split(",")
        .filter(Boolean) ?? []
    );
  }, []);
  const visualMarkdown = useMemo(
    () => {
      const startedAt = performance.now();
      const normalized = normalizeMarkdownForVisualEditor(markdown);
      recordDocumentSwitchPerformanceDuration(
        getLatestDocumentSwitchPerformanceOperationId(),
        "parse_and_normalize_visual_markdown",
        performance.now() - startedAt
      );
      return normalized;
    },
    [markdown]
  );
  const editorTranslation = useMemo<Translation>(
    () => (key, defaultValue, interpolations = {}) => {
      let value =
        key === "contentArea.editableMarkdown" ? ariaLabel : defaultValue;
      for (const [name, replacement] of Object.entries(interpolations)) {
        value = value.replaceAll(`{{${name}}}`, String(replacement));
      }
      return value;
    },
    [ariaLabel]
  );
  const editorImportMarkdown = useMemo(
    () => prepareMarkdownForDeferredCodeImport(visualMarkdown),
    [visualMarkdown]
  );
  const editorPlugins = useMemo(
    () => {
      const startedAt = performance.now();
      const plugins = [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      clearHistoryAfterDocumentResetPlugin(),
      thematicBreakPlugin(),
      frontmatterPlugin(),
      ...(!slice7aDiagnosticAblations.has("table")
        ? [tablePlugin()]
        : []),
      deferredSemanticCodeBlockPlugin(),
      ...(!slice7aDiagnosticAblations.has("code")
        ? [
            codeBlockPlugin({
              codeBlockEditorDescriptors: [deferredCodeBlockEditorDescriptor],
              defaultCodeBlockLanguage: "markdown"
            }),
            codeMirrorPlugin({
              codeBlockLanguages: {
                "": "Plain text",
                markdown: "Markdown",
                md: "Markdown",
                text: "Plain text",
                json: "JSON",
                yaml: "YAML",
                yml: "YAML",
                js: "JavaScript",
                ts: "TypeScript",
                tsx: "TypeScript (React)",
                jsx: "JavaScript (React)",
                html: "HTML",
                css: "CSS"
              }
            })
          ]
        : []),
      imagePlugin({ disableImageResize: true }),
      jsxPlugin({
        jsxComponentDescriptors: [
          {
            name: "br",
            kind: "text",
            props: [],
            hasChildren: false,
            Editor: GenericJsxEditor
          }
        ]
      }),
      linkPlugin(),
      linkDialogPlugin(),
      markdownShortcutPlugin(),
      ...(!slice7aDiagnosticAblations.has("toolbar")
        ? [
            toolbarPlugin({
              toolbarContents: () => (
                <>
                  <UndoRedo />
                  <Separator />
                  <BlockTypeSelect />
                  <BoldItalicUnderlineToggles />
                  <ListsToggle />
                  <CreateLink />
                  <InsertCodeBlock />
                  <InsertTable />
                  <InsertImage />
                  <InsertThematicBreak />
                </>
              )
            })
          ]
        : [])
      ];
      recordDocumentSwitchPerformanceDuration(
        getLatestDocumentSwitchPerformanceOperationId(),
        "plugin_registration",
        performance.now() - startedAt
      );
      return plugins;
    },
    [slice7aDiagnosticAblations]
  );
  const readinessContentFingerprint =
    documentReadiness?.contentFingerprint ?? null;
  const readinessDocumentKey = documentReadiness?.documentKey ?? null;
  const readinessRequestGeneration =
    documentReadiness?.requestGeneration ?? null;
  const readinessSwitchOperationId =
    documentReadiness?.switchOperationId ?? null;
  const editorRef = useRef<MDXEditorMethods>(null);
  const editorInitialMarkdownRef = useRef(editorImportMarkdown);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const documentReadinessRef = useRef(documentReadiness);
  const editorConstructionStartedAtRef = useRef(performance.now());
  const initialMarkdownParsedRef = useRef<string | null>(null);
  const lastSyncedMarkdownRef = useRef(visualMarkdown);
  const lastResetKeyRef = useRef(resetKey);
  const renderErrorTimerRef = useRef<number | null>(null);
  const renderVerificationTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(false);
  const queuedRenderErrorRef = useRef<string | null>(null);
  const lastAutoRetryMarkdownRef = useRef<string | null>(null);
  const lastReportedPendingRef = useRef<string | null>(null);
  const lastReportedReadinessRef = useRef<string | null>(null);
  const readinessObserverRef = useRef<MutationObserver | null>(null);
  const onDocumentPendingRef = useRef(onDocumentPending);
  const onDocumentReadyRef = useRef(onDocumentReady);
  const markdownChangeHandlerRef = useRef(handleMarkdownChange);
  const reportDocumentReadyRef = useRef(reportDocumentReady);
  const renderErrorHandlerRef = useRef(queueRenderError);
  const stableMarkdownChangeHandler = useMemo(
    () => (nextMarkdown: string, initialMarkdownNormalize: boolean) =>
      markdownChangeHandlerRef.current(
        nextMarkdown,
        initialMarkdownNormalize
      ),
    []
  );
  const stableRenderErrorHandler = useMemo(
    () => (error: unknown) => renderErrorHandlerRef.current(error),
    []
  );
  const [renderError, setRenderError] = useState<string | null>(null);
  const [editorInstanceKey, setEditorInstanceKey] = useState(0);
  onDocumentPendingRef.current = onDocumentPending;
  onDocumentReadyRef.current = onDocumentReady;
  markdownChangeHandlerRef.current = handleMarkdownChange;
  reportDocumentReadyRef.current = reportDocumentReady;
  renderErrorHandlerRef.current = queueRenderError;
  documentReadinessRef.current = documentReadiness;

  useEffect(() => {
    isMountedRef.current = true;

    if (queuedRenderErrorRef.current !== null) {
      const queuedRenderError = queuedRenderErrorRef.current;
      queuedRenderErrorRef.current = null;
      setRenderError(queuedRenderError);
    }

    return () => {
      isMountedRef.current = false;

      if (renderErrorTimerRef.current !== null) {
        window.clearTimeout(renderErrorTimerRef.current);
      }

      if (renderVerificationTimerRef.current !== null) {
        window.clearTimeout(renderVerificationTimerRef.current);
      }

      readinessObserverRef.current?.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const operationId = getLatestEditPerformanceOperationId();
    incrementEditPerformanceCounter(operationId, "mdx_editor_effect_count");
    markEditPerformanceOperation(operationId, "mdx_editor_settled");
    const switchOperationId =
      documentReadiness?.switchOperationId ??
      getLatestDocumentSwitchPerformanceOperationId();
    incrementDocumentSwitchPerformanceCounter(
      switchOperationId,
      "mdx_editor_effect_count"
    );
    markDocumentSwitchPerformance(switchOperationId, "editor_initialized");
  }, [documentReadiness?.switchOperationId, visualMarkdown]);

  useLayoutEffect(() => {
    const content = editorShellRef.current?.querySelector<HTMLElement>(
      ".patchmark-prose"
    );

    if (!content) {
      return;
    }

    const ownsSelectionOnlySemantics = selectionOnly && !readOnly;
    if (ownsSelectionOnlySemantics) {
      content.setAttribute("aria-readonly", "true");
    } else if (content.getAttribute("contenteditable") === "true") {
      content.removeAttribute("aria-readonly");
    }

    return () => {
      if (
        ownsSelectionOnlySemantics &&
        content.getAttribute("contenteditable") === "true"
      ) {
        content.removeAttribute("aria-readonly");
      }
    };
  }, [editorInstanceKey, readOnly, selectionOnly]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    const shell = editorShellRef.current;
    const markdownChanged =
      visualMarkdown !== lastSyncedMarkdownRef.current;
    const sourceChanged =
      markdownChanged || resetKey !== lastResetKeyRef.current;

    readinessObserverRef.current?.disconnect();
    readinessObserverRef.current = null;

    if (
      readinessContentFingerprint === null ||
      readinessDocumentKey === null ||
      readinessRequestGeneration === null
    ) {
      shell?.removeAttribute("data-editor-content-fingerprint");
      lastReportedPendingRef.current = null;
      lastReportedReadinessRef.current = null;
      if (!editor || !sourceChanged) {
        return;
      }
      try {
        incrementDocumentSwitchPerformanceCounter(
          getLatestDocumentSwitchPerformanceOperationId(),
          "mdx_set_markdown_count"
        );
        editor.setMarkdown(editorImportMarkdown);
        lastSyncedMarkdownRef.current = visualMarkdown;
        lastResetKeyRef.current = resetKey;
        setRenderError(null);
      } catch (error) {
        setRenderError(normalizeVisualModeError(error));
      }
      return;
    }

    const readyDetail: DocumentEditorReadyDetail = {
      contentFingerprint: readinessContentFingerprint,
      documentKey: readinessDocumentKey,
      mode: "visual",
      requestGeneration: readinessRequestGeneration,
      switchOperationId: readinessSwitchOperationId
    };
    const readinessKey = JSON.stringify(readyDetail);
    shell?.removeAttribute("data-editor-content-fingerprint");
    if (lastReportedReadinessRef.current === readinessKey) {
      shell?.setAttribute(
        "data-editor-content-fingerprint",
        readinessContentFingerprint
      );
      return;
    }
    reportDocumentPending(readyDetail, readinessKey);

    if (!editor || !shell) {
      return;
    }

    const initialImportRepresentsTarget =
      initialMarkdownParsedRef.current === visualMarkdown;
    if (
      !markdownChanged &&
      (editorDocumentKey === readinessDocumentKey ||
        initialImportRepresentsTarget) &&
      editorDomHasContent(shell, visualMarkdown)
    ) {
      if (resetKey !== lastResetKeyRef.current) {
        incrementDocumentSwitchPerformanceCounter(
          readinessSwitchOperationId,
          "mdx_set_markdown_count"
        );
        editor.setMarkdown(editorImportMarkdown);
        lastResetKeyRef.current = resetKey;
      }
      markDocumentSwitchPerformance(
        readinessSwitchOperationId,
        "target_editor_identity_reused"
      );
      reportDocumentReadyRef.current(readyDetail, readinessKey);
      return;
    }

    let observedTargetMutation = false;
    const observer = new MutationObserver(() => {
      if (!observedTargetMutation) {
        observedTargetMutation = true;
        markDocumentSwitchPerformance(
          readinessSwitchOperationId,
          "first_target_editor_dom_mutation"
        );
      }
      if (
        queuedRenderErrorRef.current !== null ||
        !isCurrentDocumentReadiness(readyDetail) ||
        !editorDomHasContent(shell, visualMarkdown)
      ) {
        return;
      }
      observer.disconnect();
      if (readinessObserverRef.current === observer) {
        readinessObserverRef.current = null;
      }
      markDocumentSwitchPerformance(
        readinessSwitchOperationId,
        "target_editor_update_committed"
      );
      reportDocumentReadyRef.current(readyDetail, readinessKey, true);
    });
    observer.observe(shell, {
      childList: true,
      characterData: true,
      subtree: true
    });
    readinessObserverRef.current = observer;

    if (
      !markdownChanged &&
      editorDocumentKey === readinessDocumentKey &&
      (initialMarkdownParsedRef.current === null ||
        initialImportRepresentsTarget)
    ) {
      markDocumentSwitchPerformance(
        readinessSwitchOperationId,
        "target_initial_import_awaited"
      );
      return () => {
        observer.disconnect();
        if (readinessObserverRef.current === observer) {
          readinessObserverRef.current = null;
        }
      };
    }

    try {
      markDocumentSwitchPerformance(
        readinessSwitchOperationId,
        "target_editor_update_requested"
      );
      const importStartedAt = performance.now();
      incrementDocumentSwitchPerformanceCounter(
        readinessSwitchOperationId,
        "mdx_set_markdown_count"
      );
      editor.setMarkdown(editorImportMarkdown);
      recordDocumentSwitchPerformanceDuration(
        readinessSwitchOperationId,
        "mdx_markdown_import",
        performance.now() - importStartedAt
      );
      markDocumentSwitchPerformance(
        readinessSwitchOperationId,
        "target_markdown_parsed"
      );
      lastSyncedMarkdownRef.current = visualMarkdown;
      lastResetKeyRef.current = resetKey;
      setRenderError(null);
    } catch (error) {
      observer.disconnect();
      if (readinessObserverRef.current === observer) {
        readinessObserverRef.current = null;
      }
      setRenderError(normalizeVisualModeError(error));
    }

    return () => {
      observer.disconnect();
      if (readinessObserverRef.current === observer) {
        readinessObserverRef.current = null;
      }
    };
  }, [
    readinessContentFingerprint,
    readinessDocumentKey,
    readinessRequestGeneration,
    readinessSwitchOperationId,
    editorImportMarkdown,
    editorInstanceKey,
    editorDocumentKey,
    renderError,
    resetKey,
    visualMarkdown
  ]);

  useEffect(() => {
    if (renderError || visualMarkdown.trim().length === 0) {
      return;
    }

    if (renderVerificationTimerRef.current !== null) {
      window.clearTimeout(renderVerificationTimerRef.current);
    }

    renderVerificationTimerRef.current = window.setTimeout(() => {
      renderVerificationTimerRef.current = null;

      if (!isMountedRef.current) {
        return;
      }

      const content = editorShellRef.current?.querySelector(
        ".patchmark-prose"
      );

      if (content && content.childNodes.length === 0) {
        setRenderError(
          "MDXEditor initialized without rendering the loaded Markdown."
        );
      }
    }, 500);

    return () => {
      if (renderVerificationTimerRef.current !== null) {
        window.clearTimeout(renderVerificationTimerRef.current);
        renderVerificationTimerRef.current = null;
      }
    };
  }, [editorInstanceKey, renderError, visualMarkdown]);

  useEffect(() => {
    if (
      !renderError ||
      visualMarkdown === markdown ||
      lastAutoRetryMarkdownRef.current === visualMarkdown ||
      !renderError.includes("<br>")
    ) {
      return;
    }

    lastAutoRetryMarkdownRef.current = visualMarkdown;
    queuedRenderErrorRef.current = null;
    editorInitialMarkdownRef.current = editorImportMarkdown;
    setEditorInstanceKey((currentKey) => currentKey + 1);
    setRenderError(null);
  }, [editorImportMarkdown, markdown, renderError, visualMarkdown]);

  function queueRenderError(error: unknown) {
    queuedRenderErrorRef.current = normalizeVisualModeError(error);

    if (renderErrorTimerRef.current !== null) {
      window.clearTimeout(renderErrorTimerRef.current);
    }

    renderErrorTimerRef.current = window.setTimeout(() => {
      renderErrorTimerRef.current = null;

      if (!isMountedRef.current || queuedRenderErrorRef.current === null) {
        return;
      }

      const nextRenderError = queuedRenderErrorRef.current;
      queuedRenderErrorRef.current = null;
      setRenderError(nextRenderError);
    }, 0);
  }

  function handleFallbackMarkdownChange(nextMarkdown: string) {
    lastSyncedMarkdownRef.current = nextMarkdown;
    onMarkdownChange(nextMarkdown);
  }

  function handleRetryVisualMode() {
    queuedRenderErrorRef.current = null;
    lastAutoRetryMarkdownRef.current = null;
    editorInitialMarkdownRef.current = editorImportMarkdown;
    setEditorInstanceKey((currentKey) => currentKey + 1);
    setRenderError(null);
  }

  function handleMarkdownChange(
    nextMarkdown: string,
    initialMarkdownNormalize: boolean
  ) {
    if (
      initialMarkdownNormalize &&
      markdown.trim().length > 0 &&
      nextMarkdown.trim().length === 0
    ) {
      setRenderError("MDXEditor emitted empty Markdown during initialization.");
      return;
    }

    if (initialMarkdownNormalize) {
      initialMarkdownParsedRef.current = visualMarkdown;
      recordDocumentSwitchPerformanceDuration(
        readinessSwitchOperationId,
        "target_editor_construction_and_initial_parse",
        performance.now() - editorConstructionStartedAtRef.current
      );
      markDocumentSwitchPerformance(
        readinessSwitchOperationId,
        "target_markdown_parsed"
      );
      lastSyncedMarkdownRef.current = visualMarkdown;
      return;
    }

    lastSyncedMarkdownRef.current = nextMarkdown;
    queuedRenderErrorRef.current = null;
    setRenderError(null);
    onMarkdownChange(nextMarkdown);
  }

  function isCurrentDocumentReadiness(
    detail: DocumentEditorReadyDetail
  ): boolean {
    const current = documentReadinessRef.current;
    return Boolean(
      current &&
        current.contentFingerprint === detail.contentFingerprint &&
        current.documentKey === detail.documentKey &&
        current.requestGeneration === detail.requestGeneration &&
        current.switchOperationId === detail.switchOperationId
    );
  }

  function reportDocumentPending(
    detail: DocumentEditorReadyDetail,
    readinessKey: string
  ) {
    if (lastReportedPendingRef.current === readinessKey) {
      return;
    }
    lastReportedPendingRef.current = readinessKey;
    onDocumentPendingRef.current?.(detail);
  }

  function reportDocumentReady(
    detail: DocumentEditorReadyDetail,
    readinessKey: string,
    flushReadyState = false
  ) {
    if (
      !isCurrentDocumentReadiness(detail) ||
      lastReportedReadinessRef.current === readinessKey
    ) {
      return;
    }
    editorShellRef.current?.setAttribute(
      "data-editor-content-fingerprint",
      detail.contentFingerprint
    );
    lastReportedPendingRef.current = null;
    lastReportedReadinessRef.current = readinessKey;
    markDocumentSwitchPerformance(
      detail.switchOperationId,
      "target_content_fingerprint_visible"
    );
    markDocumentSwitchPerformance(
      detail.switchOperationId,
      "target_editor_semantically_ready"
    );
    if (flushReadyState) {
      flushSync(() => onDocumentReadyRef.current?.(detail));
    } else {
      onDocumentReadyRef.current?.(detail);
    }
  }

  function preventSelectionOnlyMutation(event: SyntheticEvent) {
    if (!selectionOnly) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  function handleSelectionOnlyKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>
  ) {
    if (!selectionOnly) {
      return;
    }

    const key = event.key.toLowerCase();
    const primaryModifier = event.metaKey || event.ctrlKey;
    const mutatingShortcut =
      primaryModifier &&
      ["b", "i", "k", "u", "v", "x", "y", "z"].includes(key);
    const mutatingKey =
      !primaryModifier &&
      !event.altKey &&
      (event.key.length === 1 ||
        ["Backspace", "Delete", "Enter", "Tab"].includes(event.key));

    if (mutatingShortcut || mutatingKey) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleSelectionOnlyClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (
      !selectionOnly ||
      !(event.target instanceof Element) ||
      !event.target.closest(
        "a, button, input, select, [role='button'], [role='menuitem']"
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div
      ref={editorShellRef}
      data-editor-document-key={
        documentReadiness?.documentKey ?? editorDocumentKey ?? undefined
      }
      data-editor-request-generation={
        documentReadiness?.requestGeneration ?? undefined
      }
      className={[
        selectionOnly ? "visual-editor-selection-only" : "",
        showToolbar ? "" : "visual-editor-toolbar-hidden"
      ]
        .filter(Boolean)
        .join(" ") || undefined}
      onBeforeInputCapture={preventSelectionOnlyMutation}
      onClickCapture={handleSelectionOnlyClick}
      onCutCapture={preventSelectionOnlyMutation}
      onDropCapture={preventSelectionOnlyMutation}
      onKeyDownCapture={handleSelectionOnlyKeyDown}
      onPasteCapture={preventSelectionOnlyMutation}
    >
      {renderError && markdown.trim().length > 0 ? (
        <div className="visual-editor-error" role="alert">
          <strong>Visual Mode could not render this Markdown.</strong>
          <span>{renderError}</span>
        </div>
      ) : null}

      {renderError ? (
        <div className="visual-editor-fallback">
          <div className="visual-editor-fallback-toolbar">
            <span>Editing remains Markdown-safe.</span>
            <button type="button" onClick={handleRetryVisualMode}>
              Retry Visual Mode
            </button>
          </div>
          <textarea
            aria-label={`${ariaLabel} fallback Markdown editor`}
            readOnly={readOnly}
            spellCheck={false}
            value={markdown}
            onChange={(event) => handleFallbackMarkdownChange(event.target.value)}
          />
        </div>
      ) : (
        <MdxEditorRenderBoundary
          key={editorInstanceKey}
          onRenderError={stableRenderErrorHandler}
        >
          <DeferredMdxHeavyEditorProvider>
            <StableMdxEditor
              ref={editorRef}
              className="patchmark-mdx-editor"
              contentEditableClassName="patchmark-prose"
              markdown={editorInitialMarkdownRef.current}
              readOnly={readOnly}
              onChange={stableMarkdownChangeHandler}
              onError={stableRenderErrorHandler}
              plugins={editorPlugins}
              translation={editorTranslation}
            />
          </DeferredMdxHeavyEditorProvider>
        </MdxEditorRenderBoundary>
      )}
    </div>
  );
}

function editorDomHasContent(shell: HTMLElement, markdown: string): boolean {
  const fallback = shell.querySelector<HTMLTextAreaElement>(
    ".visual-editor-fallback textarea"
  );
  if (fallback) {
    return fallback.value === markdown;
  }
  const content = shell.querySelector(".patchmark-prose");
  return Boolean(
    content && (markdown.trim().length === 0 || content.childNodes.length > 0)
  );
}

function normalizeVisualModeError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "string"
  ) {
    return error.error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Editing remains available in the fallback editor below.";
}
