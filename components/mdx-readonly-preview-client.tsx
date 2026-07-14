"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  GenericJsxEditor,
  MDXEditor,
  type MDXEditorMethods,
  codeBlockPlugin,
  codeMirrorPlugin,
  frontmatterPlugin,
  headingsPlugin,
  imagePlugin,
  jsxPlugin,
  linkPlugin,
  listsPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin
} from "@mdxeditor/editor";
import { normalizeMarkdownForVisualEditor } from "@/lib/markdown/normalize-for-visual-editor";

type MdxReadonlyPreviewClientProps = {
  markdown: string;
  onRenderError: (error: string | null) => void;
};

export function MdxReadonlyPreviewClient({
  markdown,
  onRenderError
}: MdxReadonlyPreviewClientProps) {
  const visualMarkdown = useMemo(
    () => normalizeMarkdownForVisualEditor(markdown),
    [markdown]
  );
  const editorRef = useRef<MDXEditorMethods>(null);
  const lastSyncedMarkdownRef = useRef(visualMarkdown);
  const renderErrorTimerRef = useRef<number | null>(null);
  const queuedRenderErrorRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
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
      onRenderError(null);
    } catch (error) {
      onRenderError(normalizeReadonlyPreviewError(error));
    }
  }, [onRenderError, visualMarkdown]);

  function queueRenderError(error: unknown) {
    queuedRenderErrorRef.current = normalizeReadonlyPreviewError(error);

    if (renderErrorTimerRef.current !== null) {
      window.clearTimeout(renderErrorTimerRef.current);
    }

    renderErrorTimerRef.current = window.setTimeout(() => {
      renderErrorTimerRef.current = null;

      if (queuedRenderErrorRef.current === null) {
        return;
      }

      const nextRenderError = queuedRenderErrorRef.current;
      queuedRenderErrorRef.current = null;
      onRenderError(nextRenderError);
    }, 0);
  }

  return (
    <MDXEditor
      ref={editorRef}
      className="patchmark-pdf-mdx-editor"
      contentEditableClassName="patchmark-pdf-prose patchmark-prose"
      markdown={visualMarkdown}
      readOnly
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
        linkPlugin()
      ]}
    />
  );
}

function normalizeReadonlyPreviewError(error: unknown): string {
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

  return "PDF preview could not render this Markdown.";
}
