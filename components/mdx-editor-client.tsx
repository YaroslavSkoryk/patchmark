"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
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
  const queuedRenderErrorRef = useRef<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!queuedRenderErrorRef.current) {
      return;
    }

    const nextRenderError = queuedRenderErrorRef.current;
    queuedRenderErrorRef.current = null;
    setRenderError(nextRenderError);
  }, [markdown, renderError]);

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

  function queueRenderError(error: unknown) {
    queuedRenderErrorRef.current = normalizeVisualModeError(error);
  }

  function handleFallbackMarkdownChange(nextMarkdown: string) {
    lastSyncedMarkdownRef.current = nextMarkdown;
    onMarkdownChange(nextMarkdown);
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
            <button type="button" onClick={() => setRenderError(null)}>
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
