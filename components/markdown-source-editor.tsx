"use client";

import { useEffect, useRef } from "react";

export type MarkdownSelection = {
  end: number;
  start: number;
};

type MarkdownSourceEditorProps = {
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  onSelectionChange?: (selection: MarkdownSelection) => void;
  selectionRequest?: (MarkdownSelection & { nonce: number }) | null;
};

export function MarkdownSourceEditor({
  markdown,
  onMarkdownChange,
  onSelectionChange,
  selectionRequest
}: MarkdownSourceEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!selectionRequest || !textareaRef.current) {
      return;
    }

    const textarea = textareaRef.current;
    const start = clampOffset(selectionRequest.start, markdown.length);
    const end = clampOffset(selectionRequest.end, markdown.length);
    textarea.focus();
    textarea.setSelectionRange(start, end);
    textarea.scrollTop = getApproximateScrollTop(markdown, start);
    onSelectionChange?.({ start, end });
  }, [markdown, onSelectionChange, selectionRequest]);

  function emitSelection(selectionTarget: HTMLTextAreaElement) {
    onSelectionChange?.({
      start: selectionTarget.selectionStart,
      end: selectionTarget.selectionEnd
    });
  }

  return (
    <textarea
      ref={textareaRef}
      className="markdown-source-editor"
      aria-label="Markdown Mode"
      spellCheck={false}
      value={markdown}
      onChange={(event) => {
        onMarkdownChange(event.target.value);
        emitSelection(event.target);
      }}
      onKeyUp={(event) => emitSelection(event.currentTarget)}
      onMouseUp={(event) => emitSelection(event.currentTarget)}
      onSelect={(event) => emitSelection(event.currentTarget)}
    />
  );
}

function clampOffset(offset: number, markdownLength: number): number {
  return Math.max(0, Math.min(offset, markdownLength));
}

function getApproximateScrollTop(markdown: string, offset: number): number {
  const lineIndex = markdown.slice(0, offset).split(/\r?\n/).length - 1;
  return Math.max(0, lineIndex * 24 - 96);
}
