import { createMarkdownDownloadName } from "./download-markdown.ts";

type FilePickerAcceptType = {
  description?: string;
  accept: Record<string, string[]>;
};

type FilePickerOptions = {
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  suggestedName?: string;
  types?: FilePickerAcceptType[];
};

type MarkdownWritableFileStream = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

export type MarkdownFileHandle = {
  name: string;
  kind?: "file";
  getFile: () => Promise<Pick<File, "name" | "size" | "type" | "text">>;
  createWritable: () => Promise<MarkdownWritableFileStream>;
  isSameEntry?: (other: MarkdownFileHandle) => Promise<boolean>;
  isSymbolicLink?: () => Promise<boolean>;
};

export type LoadedMarkdownFile = {
  fileName: string;
  markdown: string;
  fileHandle: MarkdownFileHandle | null;
};

type FileSystemAccessWindow = Window & {
  showOpenFilePicker?: (
    options?: FilePickerOptions
  ) => Promise<MarkdownFileHandle[]>;
  showSaveFilePicker?: (
    options?: FilePickerOptions
  ) => Promise<MarkdownFileHandle>;
};

const markdownPickerTypes: FilePickerAcceptType[] = [
  {
    description: "Markdown files",
    accept: {
      "text/markdown": [".md", ".markdown"],
      "text/plain": [".md", ".markdown"]
    }
  }
];

export function canOpenMarkdownFilePicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof getFileSystemAccessWindow().showOpenFilePicker === "function"
  );
}

export function canSaveMarkdownFilePicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof getFileSystemAccessWindow().showSaveFilePicker === "function"
  );
}

export async function openMarkdownFileWithPicker(): Promise<LoadedMarkdownFile | null> {
  const filePicker = getFileSystemAccessWindow().showOpenFilePicker;

  if (!filePicker) {
    return null;
  }

  try {
    const [fileHandle] = await filePicker({
      excludeAcceptAllOption: false,
      multiple: false,
      types: markdownPickerTypes
    });

    if (!fileHandle) {
      return null;
    }

    const file = await fileHandle.getFile();

    if (!isMarkdownFile(file)) {
      throw new Error("Choose a .md or .markdown file.");
    }

    return {
      fileName: file.name,
      markdown: await file.text(),
      fileHandle
    };
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }

    throw error;
  }
}

export async function saveMarkdownToFileHandle(
  fileHandle: MarkdownFileHandle,
  markdown: string
): Promise<void> {
  if (typeof markdown !== "string") {
    throw new Error("Markdown content must be a string.");
  }

  const writable = await fileHandle.createWritable();
  await writable.write(markdown);
  await writable.close();
}

export async function saveMarkdownAsFile(
  fileName: string | null,
  markdown: string
): Promise<MarkdownFileHandle | null> {
  const saveFilePicker = getFileSystemAccessWindow().showSaveFilePicker;

  if (!saveFilePicker) {
    return null;
  }

  try {
    const fileHandle = await saveFilePicker({
      suggestedName: createMarkdownDownloadName(fileName),
      types: markdownPickerTypes
    });

    await saveMarkdownToFileHandle(fileHandle, markdown);
    return fileHandle;
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }

    throw error;
  }
}

export function isMarkdownFile(
  file: Pick<File, "name" | "type">
): boolean {
  return (
    /\.(md|markdown)$/i.test(file.name) ||
    file.type === "text/markdown" ||
    file.type === "text/plain"
  );
}

function getFileSystemAccessWindow(): FileSystemAccessWindow {
  return window as FileSystemAccessWindow;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
