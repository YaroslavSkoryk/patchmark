"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { VisualMarkdownEditor } from "@/components/visual-markdown-editor";

const supportedMarkdown =
  "# Lifecycle fixture\n\nSupported Markdown remains editable in Visual Mode.";
const unsupportedMarkdown = `${supportedMarkdown}\n\n<UnsupportedLifecycleWidget />`;

export function MdxRenderErrorLifecycleRegressionHarness() {
  const [changeCount, setChangeCount] = useState(0);
  const [corpusCaseId, setCorpusCaseId] = useState("lifecycle-default");
  const [corpusReceiverReady, setCorpusReceiverReady] = useState(false);
  const [editorInstance, setEditorInstance] = useState(0);
  const [isMounted, setIsMounted] = useState(true);
  const [markdown, setMarkdown] = useState(supportedMarkdown);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    function loadCorpusCase(event: Event) {
      const detail = (event as CustomEvent<{
        id?: unknown;
        markdown?: unknown;
      }>).detail;
      if (
        !detail ||
        typeof detail.id !== "string" ||
        typeof detail.markdown !== "string"
      ) {
        return;
      }
      const corpusId = detail.id;
      const corpusMarkdown = detail.markdown;

      flushSync(() => {
        setChangeCount(0);
        setCorpusCaseId(corpusId);
        setMarkdown(corpusMarkdown);
        setResetKey((currentKey) => currentKey + 1);
        setEditorInstance((currentInstance) => currentInstance + 1);
        setIsMounted(true);
      });
    }

    window.addEventListener("patchmark:load-mdx-corpus-case", loadCorpusCase);
    setCorpusReceiverReady(true);
    return () => {
      window.removeEventListener(
        "patchmark:load-mdx-corpus-case",
        loadCorpusCase
      );
    };
  }, []);

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
      <output
        data-change-count={changeCount}
        data-corpus-case-id={corpusCaseId}
        data-corpus-receiver-ready={corpusReceiverReady}
        data-testid="lifecycle-source-authority"
      >
        <textarea
          aria-label="Lifecycle source authority"
          readOnly
          value={markdown}
        />
      </output>
      <div data-testid="lifecycle-editor-host">
        {isMounted ? (
          <VisualMarkdownEditor
            ariaLabel="Lifecycle Visual editor"
            key={editorInstance}
            markdown={markdown}
            onMarkdownChange={(nextMarkdown) => {
              setChangeCount((currentCount) => currentCount + 1);
              setMarkdown(nextMarkdown);
            }}
            resetKey={resetKey}
          />
        ) : null}
      </div>
    </section>
  );
}
