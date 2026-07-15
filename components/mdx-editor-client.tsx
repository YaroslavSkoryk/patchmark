"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin
} from "@mdxeditor/editor";
import { normalizeMarkdownForVisualEditor } from "@/lib/markdown/normalize-for-visual-editor";
import {
  getLatestEditPerformanceOperationId,
  incrementEditPerformanceCounter,
  markEditPerformanceOperation
} from "@/lib/performance/edit-performance";

type MdxEditorClientProps = {
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
};

export function MdxEditorClient({
  markdown,
  onMarkdownChange
}: MdxEditorClientProps) {
  const visualMarkdown = useMemo(
    () => normalizeMarkdownForVisualEditor(markdown),
    [markdown]
  );
  const editorRef = useRef<MDXEditorMethods>(null);
  const lastSyncedMarkdownRef = useRef(visualMarkdown);
  const renderErrorTimerRef = useRef<number | null>(null);
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
    };
  }, []);

  useEffect(() => {
    if (
      !editorRef.current ||
      visualMarkdown === lastSyncedMarkdownRef.current
    ) {
      return;
    }

    try {
      editorRef.current.setMarkdown(visualMarkdown);
      lastSyncedMarkdownRef.current = visualMarkdown;
      setRenderError(null);
    } catch (error) {
      setRenderError(normalizeVisualModeError(error));
    }
  }, [visualMarkdown]);

  useEffect(() => {
    const operationId = getLatestEditPerformanceOperationId();
    incrementEditPerformanceCounter(operationId, "mdx_editor_effect_count");
    markEditPerformanceOperation(operationId, "mdx_editor_settled");
  }, [visualMarkdown]);

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

    lastSyncedMarkdownRef.current = nextMarkdown;
    queuedRenderErrorRef.current = null;
    setRenderError(null);
    onMarkdownChange(nextMarkdown);
  }

  return (
    <>
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
          onChange={handleMarkdownChange}
          onError={queueRenderError}
          plugins={[
            headingsPlugin(),
            listsPlugin(),
            quotePlugin(),
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
    </>
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
