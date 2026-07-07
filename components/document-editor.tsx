"use client";

import { useMemo, useState } from "react";
import { MarkdownFileLoader } from "@/components/markdown-file-loader";
import { MarkdownSourceEditor } from "@/components/markdown-source-editor";
import { DocumentOutline } from "@/components/document-outline";
import { VisualMarkdownEditor } from "@/components/visual-markdown-editor";
import { parseMarkdownHeadings } from "@/lib/markdown/parse-headings";

type EditorMode = "visual" | "markdown";

export function DocumentEditor() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [mode, setMode] = useState<EditorMode>("visual");
  const [documentVersion, setDocumentVersion] = useState(0);

  const headings = useMemo(() => parseMarkdownHeadings(markdown), [markdown]);

  function handleFileLoaded(nextFileName: string, nextMarkdown: string) {
    setFileName(nextFileName);
    setMarkdown(nextMarkdown);
    setMode("visual");
    setDocumentVersion((currentVersion) => currentVersion + 1);
  }

  return (
    <section className="document-workspace" aria-label="Patchmark editor">
      <div className="editor-panel">
        <div className="document-toolbar">
          <div className="loader-row">
            <MarkdownFileLoader onFileLoaded={handleFileLoaded} />
            <span className="file-loader-help">Accepts .md and .markdown</span>
          </div>

          {fileName ? (
            <>
              <div className="document-meta">
                <span>Loaded file</span>
                <strong title={fileName}>{fileName}</strong>
              </div>

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
            </>
          ) : null}
        </div>

        <div className="editor-body">
          {fileName ? (
            mode === "visual" ? (
              <VisualMarkdownEditor
                key={documentVersion}
                markdown={markdown}
                onMarkdownChange={setMarkdown}
              />
            ) : (
              <MarkdownSourceEditor
                markdown={markdown}
                onMarkdownChange={setMarkdown}
              />
            )
          ) : (
            <div className="empty-state">
              <div>
                <h2>Load a Markdown file to begin.</h2>
                <p>
                  Markdown is the source of truth. DOCX/PDF import will come
                  later.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <DocumentOutline headings={headings} />
    </section>
  );
}
