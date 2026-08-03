"use client";

import type { RewriteEditorMode } from "@/components/rewrite-workspace/rewrite-comparison-editor";

export function RewriteModeControl({
  mode,
  onChange
}: {
  mode: RewriteEditorMode;
  onChange: (mode: RewriteEditorMode) => void;
}) {
  return (
    <div className="rewrite-mode-control-row">
      <span>View both as</span>
      <div
        aria-label="Rewrite comparison mode"
        className="rewrite-mode-control"
        role="group"
      >
        <button
          aria-pressed={mode === "visual"}
          type="button"
          onClick={() => onChange("visual")}
        >
          Visual
        </button>
        <button
          aria-pressed={mode === "markdown"}
          type="button"
          onClick={() => onChange("markdown")}
        >
          Markdown
        </button>
      </div>
      <span aria-live="polite" className="sr-only">
        Both comparison panes are in {mode === "visual" ? "Visual" : "Markdown"} mode.
      </span>
    </div>
  );
}
