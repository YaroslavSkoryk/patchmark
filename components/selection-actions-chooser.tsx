"use client";

import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type RefObject
} from "react";

export type SelectionActionId =
  | "selected_text"
  | "section"
  | "document"
  | "bookmark"
  | "rewrite_selected_text"
  | "rewrite_section";

export type SelectionActionOption = {
  description: string;
  group: "Comment" | "Rewrite" | "Reading";
  id: SelectionActionId;
  label: string;
  unavailableReason?: string;
};

export type SelectionActionsPresentation = "compact" | "chooser";

type SelectionActionsChooserProps = {
  compactButtonRef: RefObject<HTMLButtonElement | null>;
  contextLabel: string | null;
  excerpt: string | null;
  onActivate: (actionId: SelectionActionId) => void;
  onCancel: () => void;
  onOpen: () => void;
  options: SelectionActionOption[];
  presentation: SelectionActionsPresentation;
  sectionLabel: string | null;
  selectionLatencyMs: number | null;
  trigger: "context_menu" | "keyboard" | "selection";
  x: number;
  y: number;
};

export function SelectionActionsChooser({
  compactButtonRef,
  contextLabel,
  excerpt,
  onActivate,
  onCancel,
  onOpen,
  options,
  presentation,
  sectionLabel,
  selectionLatencyMs,
  trigger,
  x,
  y
}: SelectionActionsChooserProps) {
  const chooserRef = useRef<HTMLDivElement>(null);
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  useEffect(() => {
    if (presentation !== "chooser") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      chooserRef.current
        ?.querySelector<HTMLButtonElement>(
          "[data-selection-action-option]"
        )
        ?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [presentation]);

  if (presentation === "compact") {
    return (
      <button
        ref={compactButtonRef}
        type="button"
        aria-keyshortcuts="Alt+Shift+M"
        aria-label="Choose text actions"
        className="comment-selection-action"
        data-testid="comment-selection-action"
        onClick={onOpen}
        onMouseDown={(event) => event.preventDefault()}
        style={{ left: x, top: y }}
        title="Choose comment, rewrite, or bookmark action (Alt+Shift+M)"
      >
        + Comment
      </button>
    );
  }

  function handleChooserKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }

    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const controls = Array.from(
      chooserRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-selection-action-option]"
      ) ?? []
    );

    if (controls.length === 0) {
      return;
    }

    event.preventDefault();
    const currentIndex = controls.indexOf(
      document.activeElement as HTMLButtonElement
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : event.key === "ArrowUp"
            ? currentIndex <= 0
              ? controls.length - 1
              : currentIndex - 1
            : currentIndex >= controls.length - 1
              ? 0
              : currentIndex + 1;
    controls[nextIndex]?.focus({ preventScroll: true });
  }

  return (
    <div
      ref={chooserRef}
      aria-label="Choose text actions"
      aria-modal="false"
      className="selection-actions-chooser"
      data-chooser-trigger={trigger}
      data-render-count={renderCountRef.current}
      data-selection-latency-ms={
        selectionLatencyMs === null
          ? undefined
          : selectionLatencyMs.toFixed(2)
      }
      data-testid="selection-actions-chooser"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleChooserKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      role="dialog"
      style={{ left: x, top: y }}
    >
      <header className="selection-actions-header">
        <span>Selection actions</span>
        <button
          type="button"
          aria-label="Close comment scope chooser"
          className="selection-actions-close"
          onClick={onCancel}
        >
          ×
        </button>
      </header>

      {excerpt || contextLabel || sectionLabel ? (
        <div className="selection-actions-context">
          {excerpt ? (
            <p>
              <span>Selected</span>
              <q>{truncateSelectionExcerpt(excerpt)}</q>
            </p>
          ) : null}
          {contextLabel ? (
            <p>
              <span>Context</span>
              <strong>{contextLabel}</strong>
            </p>
          ) : null}
          {sectionLabel ? (
            <p>
              <span>Containing section</span>
              <strong>{sectionLabel}</strong>
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        aria-label="Comment, rewrite, and bookmark actions"
        className="selection-actions-options"
        role="group"
      >
        {options.map((option, index) => (
          <div className="selection-action-group-item" key={option.id}>
            {options[index - 1]?.group !== option.group ? (
              <span className="selection-action-group-label">{option.group}</span>
            ) : null}
            {option.unavailableReason ? (
            <div
              className="selection-action-unavailable"
              data-selection-action-unavailable={option.id}
              role="status"
            >
              <strong>{option.label} unavailable</strong>
              <span>{option.unavailableReason}</span>
            </div>
            ) : (
            <button
              type="button"
              data-selection-action-option={option.id}
              onClick={() => onActivate(option.id)}
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function createSelectionActionOptions({
  bookmarkUnavailableReason,
  commentsUnavailableReason,
  rewriteUnavailableReason,
  sectionLabel,
  selectedTextAvailable,
  selectionUnavailableReason
}: {
  bookmarkUnavailableReason: string | null;
  commentsUnavailableReason: string | null;
  rewriteUnavailableReason: string | null;
  sectionLabel: string | null;
  selectedTextAvailable: boolean;
  selectionUnavailableReason: string | null;
}): SelectionActionOption[] {
  return [
    {
      description: "Anchor the comment to the captured range.",
      group: "Comment",
      id: "selected_text",
      label: "Selected text",
      unavailableReason:
        commentsUnavailableReason ??
        (!selectedTextAvailable
          ? selectionUnavailableReason ?? "Select document text first."
          : undefined)
    },
    {
      description: sectionLabel
        ? `Comment on ${sectionLabel}.`
        : "Comment on the containing section.",
      id: "section",
      group: "Comment",
      label: "Current section",
      unavailableReason:
        commentsUnavailableReason ??
        (!sectionLabel
          ? "No containing section could be identified."
          : undefined)
    },
    {
      description: "Create a comment anchored to this document.",
      group: "Comment",
      id: "document",
      label: "Whole document",
      unavailableReason: commentsUnavailableReason ?? undefined
    },
    {
      description: "Open a frozen reference beside your editable human draft.",
      group: "Rewrite",
      id: "rewrite_selected_text",
      label: "Rewrite selected text",
      unavailableReason:
        rewriteUnavailableReason ??
        (!selectedTextAvailable
          ? selectionUnavailableReason ?? "Select document text first."
          : undefined)
    },
    {
      description: sectionLabel
        ? `Rewrite the complete ${sectionLabel} section.`
        : "Rewrite the complete containing section.",
      group: "Rewrite",
      id: "rewrite_section",
      label: "Rewrite current section",
      unavailableReason:
        rewriteUnavailableReason ??
        (!sectionLabel
          ? "No containing section could be identified."
          : undefined)
    },
    {
      description: "Continue reading from this captured location.",
      group: "Reading",
      id: "bookmark",
      label: "Set reading bookmark",
      unavailableReason: bookmarkUnavailableReason ?? undefined
    }
  ];
}

function truncateSelectionExcerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180
    ? `${normalized.slice(0, 177).trimEnd()}…`
    : normalized;
}
