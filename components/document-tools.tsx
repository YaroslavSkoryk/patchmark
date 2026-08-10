"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { DocumentOutline } from "@/components/document-outline";
import { VersionHistoryPanel } from "@/components/version-history-panel";
import type { MarkdownHeading } from "@/lib/markdown/parse-headings";
import type {
  PatchmarkComment,
  PatchmarkPatch,
  PatchmarkVersionEntry
} from "@/lib/project/project-types";

type DocumentTool = "outline" | "history";

type DocumentToolsProps = {
  comments: PatchmarkComment[];
  headings: MarkdownHeading[];
  isProjectMode: boolean;
  patches: PatchmarkPatch[];
  versions: PatchmarkVersionEntry[];
  onCompareVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
  onViewVersion: (version: PatchmarkVersionEntry, displayTitle?: string) => void;
};

export function DocumentTools({
  comments,
  headings,
  isProjectMode,
  patches,
  versions,
  onCompareVersion,
  onViewVersion
}: DocumentToolsProps) {
  const outlineTabId = useId();
  const outlinePanelId = useId();
  const historyTabId = useId();
  const historyPanelId = useId();
  const outlineTabRef = useRef<HTMLButtonElement>(null);
  const historyTabRef = useRef<HTMLButtonElement>(null);
  const [activeTool, setActiveTool] = useState<DocumentTool>("outline");

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const nextTool =
      event.key === "Home"
        ? "outline"
        : event.key === "End"
          ? "history"
          : activeTool === "outline"
            ? "history"
            : "outline";
    setActiveTool(nextTool);
    window.requestAnimationFrame(() => {
      (nextTool === "outline" ? outlineTabRef : historyTabRef).current?.focus();
    });
  }

  return (
    <details className="document-tools">
      <summary>
        <span>Document tools</span>
        <small>
          {headings.length} heading{headings.length === 1 ? "" : "s"} ·{" "}
          {versions.length} version{versions.length === 1 ? "" : "s"}
        </small>
      </summary>
      <div className="document-tools-content">
        <div className="document-tools-switcher" role="tablist" aria-label="Document tools">
          <button
            ref={outlineTabRef}
            id={outlineTabId}
            type="button"
            role="tab"
            aria-controls={outlinePanelId}
            aria-selected={activeTool === "outline"}
            tabIndex={activeTool === "outline" ? 0 : -1}
            onClick={() => setActiveTool("outline")}
            onKeyDown={handleTabKeyDown}
          >
            Outline
          </button>
          <button
            ref={historyTabRef}
            id={historyTabId}
            type="button"
            role="tab"
            aria-controls={historyPanelId}
            aria-selected={activeTool === "history"}
            tabIndex={activeTool === "history" ? 0 : -1}
            onClick={() => setActiveTool("history")}
            onKeyDown={handleTabKeyDown}
          >
            History
          </button>
        </div>
        <div
          id={outlinePanelId}
          role="tabpanel"
          aria-labelledby={outlineTabId}
          hidden={activeTool !== "outline"}
        >
          <DocumentOutline headings={headings} />
        </div>
        <div
          id={historyPanelId}
          role="tabpanel"
          aria-labelledby={historyTabId}
          hidden={activeTool !== "history"}
        >
          <VersionHistoryPanel
            comments={comments}
            isProjectMode={isProjectMode}
            patches={patches}
            versions={versions}
            onCompareVersion={onCompareVersion}
            onViewVersion={onViewVersion}
          />
        </div>
      </div>
    </details>
  );
}
