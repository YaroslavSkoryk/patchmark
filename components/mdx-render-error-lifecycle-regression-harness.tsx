"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { VisualMarkdownEditor } from "@/components/visual-markdown-editor";

const supportedMarkdown =
  "# Lifecycle fixture\n\nSupported Markdown remains editable in Visual Mode.";
const unsupportedMarkdown = `${supportedMarkdown}\n\n<UnsupportedLifecycleWidget />`;

export function MdxRenderErrorLifecycleRegressionHarness() {
  const [editorInstance, setEditorInstance] = useState(0);
  const [isMounted, setIsMounted] = useState(true);
  const [markdown, setMarkdown] = useState(supportedMarkdown);
  const [resetKey, setResetKey] = useState(0);

  function mountEditor(nextMarkdown: string) {
    setMarkdown(nextMarkdown);
    setResetKey((currentKey) => currentKey + 1);
    setEditorInstance((currentInstance) => currentInstance + 1);
    setIsMounted(true);
  }

  function loadUnsupportedAfterMount() {
    setMarkdown(unsupportedMarkdown);
    setResetKey((currentKey) => currentKey + 1);
  }

  function loadUnsupportedAndUnmount() {
    flushSync(() => {
      setMarkdown(unsupportedMarkdown);
      setResetKey((currentKey) => currentKey + 1);
    });
    flushSync(() => setIsMounted(false));
  }

  return (
    <section
      aria-label="MDX render-error lifecycle fixture"
      className="editor-panel"
      data-lifecycle-fixture-ready="true"
      style={{ margin: "0 auto 20px", maxWidth: 960, padding: 18 }}
    >
      <h2 style={{ marginTop: 0 }}>Render-error lifecycle fixture</h2>
      <div className="document-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" onClick={() => setIsMounted(false)}>
          Unmount editor
        </button>
        <button type="button" onClick={() => mountEditor(supportedMarkdown)}>
          Mount supported editor
        </button>
        <button type="button" onClick={() => mountEditor(unsupportedMarkdown)}>
          Mount unsupported editor
        </button>
        <button type="button" onClick={loadUnsupportedAfterMount}>
          Load unsupported after mount
        </button>
        <button type="button" onClick={loadUnsupportedAndUnmount}>
          Load unsupported and unmount
        </button>
      </div>
      <output aria-live="polite" data-testid="lifecycle-mount-state">
        {isMounted ? "Editor mounted" : "Editor unmounted"}
      </output>
      <div data-testid="lifecycle-editor-host">
        {isMounted ? (
          <VisualMarkdownEditor
            ariaLabel="Lifecycle Visual editor"
            key={editorInstance}
            markdown={markdown}
            onMarkdownChange={setMarkdown}
            resetKey={resetKey}
          />
        ) : null}
      </div>
    </section>
  );
}
