"use client";

import { useRef, useState } from "react";
import {
  canOpenMarkdownFilePicker,
  isMarkdownFile,
  openMarkdownFileWithPicker,
  type LoadedMarkdownFile
} from "@/lib/files/file-system-access";

type MarkdownFileLoaderProps = {
  menuItem?: boolean;
  onFileLoaded: (loadedFile: LoadedMarkdownFile) => void;
};

export function MarkdownFileLoader({
  menuItem = false,
  onFileLoaded
}: MarkdownFileLoaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loadError, setLoadError] = useState("");

  async function handleLoadMarkdown() {
    setLoadError("");

    if (!canOpenMarkdownFilePicker()) {
      inputRef.current?.click();
      return;
    }

    try {
      const loadedFile = await openMarkdownFileWithPicker();

      if (loadedFile) {
        onFileLoaded(loadedFile);
      }
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not load Markdown file."
      );
    }
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!isMarkdownFile(file)) {
      setLoadError("Choose a .md or .markdown file.");
      event.target.value = "";
      return;
    }

    const markdown = await file.text();
    onFileLoaded({
      fileName: file.name,
      markdown,
      fileHandle: null
    });
    event.target.value = "";
  }

  return (
    <div className="file-loader-control">
      <button
        className={menuItem ? "application-menu-item" : "file-loader-label"}
        type="button"
        role={menuItem ? "menuitem" : undefined}
        tabIndex={menuItem ? -1 : undefined}
        onClick={handleLoadMarkdown}
      >
        Load Markdown
      </button>
      <input
        ref={inputRef}
        className="file-loader-input"
        type="file"
        accept=".md,.markdown,text/markdown,text/x-markdown,text/plain"
        onChange={handleFileChange}
      />
      <span className="file-loader-error" role="alert">
        {loadError}
      </span>
    </div>
  );
}
