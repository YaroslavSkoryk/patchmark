"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
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
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  resetKey: number;
  selectionOnly?: boolean;
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

export function MdxEditorClient({
  markdown,
  onMarkdownChange,
  readOnly = false,
  resetKey,
  selectionOnly = false
}: MdxEditorClientProps) {
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
  const editorRef = useRef<MDXEditorMethods>(null);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const lastSyncedMarkdownRef = useRef(visualMarkdown);
  const lastResetKeyRef = useRef(resetKey);
  const renderErrorTimerRef = useRef<number | null>(null);
  const renderVerificationTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(false);
  const queuedRenderErrorRef = useRef<string | null>(null);
  const lastAutoRetryMarkdownRef = useRef<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [editorInstanceKey, setEditorInstanceKey] = useState(0);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;

      if (renderErrorTimerRef.current !== null) {
        window.clearTimeout(renderErrorTimerRef.current);
      }

      if (renderVerificationTimerRef.current !== null) {
        window.clearTimeout(renderVerificationTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (
      !editorRef.current ||
      (visualMarkdown === lastSyncedMarkdownRef.current &&
        resetKey === lastResetKeyRef.current)
    ) {
      return;
    }

    try {
      editorRef.current.setMarkdown(visualMarkdown);
      lastSyncedMarkdownRef.current = visualMarkdown;
      lastResetKeyRef.current = resetKey;
      setRenderError(null);
    } catch (error) {
      setRenderError(normalizeVisualModeError(error));
    }
  }, [resetKey, visualMarkdown]);

  useEffect(() => {
    const operationId = getLatestEditPerformanceOperationId();
    incrementEditPerformanceCounter(operationId, "mdx_editor_effect_count");
    markEditPerformanceOperation(operationId, "mdx_editor_settled");
    const switchOperationId =
      getLatestDocumentSwitchPerformanceOperationId();
    incrementDocumentSwitchPerformanceCounter(
      switchOperationId,
      "mdx_editor_effect_count"
    );
    markDocumentSwitchPerformance(switchOperationId, "editor_initialized");
  }, [visualMarkdown]);

  useEffect(() => {
    const content = editorShellRef.current?.querySelector(".patchmark-prose");

    if (!content || !selectionOnly) {
      return;
    }

    content.setAttribute("aria-readonly", "true");
    return () => content.removeAttribute("aria-readonly");
  }, [editorInstanceKey, selectionOnly, visualMarkdown]);

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

      const content = editorShellRef.current?.querySelector(".patchmark-prose");

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
    setEditorInstanceKey((currentKey) => currentKey + 1);
    setRenderError(null);
  }, [markdown, renderError, visualMarkdown]);

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
      lastSyncedMarkdownRef.current = visualMarkdown;
      return;
    }

    lastSyncedMarkdownRef.current = nextMarkdown;
    queuedRenderErrorRef.current = null;
    setRenderError(null);
    onMarkdownChange(nextMarkdown);
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
      className={selectionOnly ? "visual-editor-selection-only" : undefined}
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
            aria-label="Visual Mode fallback Markdown editor"
            readOnly={readOnly}
            spellCheck={false}
            value={markdown}
            onChange={(event) => handleFallbackMarkdownChange(event.target.value)}
          />
        </div>
      ) : (
        <MDXEditor
          key={editorInstanceKey}
          ref={editorRef}
          className="patchmark-mdx-editor"
          contentEditableClassName="patchmark-prose"
          markdown={visualMarkdown}
          readOnly={readOnly}
          onChange={handleMarkdownChange}
          onError={queueRenderError}
          plugins={[
            headingsPlugin(),
            listsPlugin(),
            quotePlugin(),
            clearHistoryAfterDocumentResetPlugin(),
            thematicBreakPlugin(),
            frontmatterPlugin(),
            tablePlugin(),
            codeBlockPlugin({ defaultCodeBlockLanguage: "markdown" }),
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
            }),
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
          ]}
        />
      )}
    </div>
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
