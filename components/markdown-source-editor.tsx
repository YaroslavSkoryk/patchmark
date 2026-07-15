"use client";

import { useEffect, useRef } from "react";

export type MarkdownSelection = {
  end: number;
  start: number;
};

export type MarkdownMutationHint = {
  data?: string | null;
  event:
    | "beforeinput"
    | "change"
    | "compositionend"
    | "compositionstart"
    | "cut"
    | "paste";
  inputType?: string;
  isComposing?: boolean;
  selectionEnd: number;
  selectionStart: number;
};

type MarkdownSourceEditorProps = {
  markdown: string;
  onMarkdownChange: (markdown: string, hint?: MarkdownMutationHint) => void;
  onSelectionChange?: (selection: MarkdownSelection) => void;
  readOnly?: boolean;
  selectionRequest?: (MarkdownSelection & { nonce: number }) | null;
};

export function MarkdownSourceEditor({
  markdown,
  onMarkdownChange,
  onSelectionChange,
  readOnly = false,
  selectionRequest
}: MarkdownSourceEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const pendingMutationHintRef = useRef<MarkdownMutationHint | null>(null);

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

  function createMutationHint(
    selectionTarget: HTMLTextAreaElement,
    event: MarkdownMutationHint["event"],
    options: Partial<MarkdownMutationHint> = {}
  ): MarkdownMutationHint {
    return {
      event,
      isComposing: isComposingRef.current,
      selectionEnd: selectionTarget.selectionEnd,
      selectionStart: selectionTarget.selectionStart,
      ...options
    };
  }

  return (
    <textarea
      ref={textareaRef}
      className="markdown-source-editor"
      aria-label="Markdown Mode"
      spellCheck={false}
      readOnly={readOnly}
      value={markdown}
      onBeforeInput={(event) => {
        const nativeEvent = event.nativeEvent as InputEvent;
        pendingMutationHintRef.current = createMutationHint(
          event.currentTarget,
          "beforeinput",
          {
            data: nativeEvent.data,
            inputType: nativeEvent.inputType
          }
        );
      }}
      onChange={(event) => {
        const hint =
          pendingMutationHintRef.current ??
          createMutationHint(event.currentTarget, "change");
        pendingMutationHintRef.current = null;
        onMarkdownChange(event.target.value, hint);
        emitSelection(event.target);
      }}
      onCompositionStart={(event) => {
        isComposingRef.current = true;
        pendingMutationHintRef.current = createMutationHint(
          event.currentTarget,
          "compositionstart",
          {
            data: event.data,
            isComposing: true
          }
        );
      }}
      onCompositionEnd={(event) => {
        isComposingRef.current = false;
        pendingMutationHintRef.current = createMutationHint(
          event.currentTarget,
          "compositionend",
          {
            data: event.data,
            inputType: "insertCompositionText",
            isComposing: false
          }
        );
      }}
      onCut={(event) => {
        pendingMutationHintRef.current = createMutationHint(
          event.currentTarget,
          "cut",
          {
            data: event.clipboardData.getData("text/plain"),
            inputType: "deleteByCut"
          }
        );
      }}
      onKeyUp={(event) => emitSelection(event.currentTarget)}
      onMouseUp={(event) => emitSelection(event.currentTarget)}
      onPaste={(event) => {
        pendingMutationHintRef.current = createMutationHint(
          event.currentTarget,
          "paste",
          {
            data: event.clipboardData.getData("text/plain"),
            inputType: "insertFromPaste"
          }
        );
      }}
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
