"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";

const MdxReadonlyPreviewClient = dynamic(
  () =>
    import("@/components/mdx-readonly-preview-client").then(
      (module) => module.MdxReadonlyPreviewClient
    ),
  {
    ssr: false,
    loading: () => (
      <div className="pdf-export-render-loading">Loading PDF preview...</div>
    )
  }
);

type PdfExportPreviewProps = {
  fileName: string;
  markdown: string;
  onClose: () => void;
};

type PrintState = "idle" | "preparing" | "failed";

export function PdfExportPreview({
  fileName,
  markdown,
  onClose
}: PdfExportPreviewProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const printButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [printState, setPrintState] = useState<PrintState>("idle");
  const [renderError, setRenderError] = useState<string | null>(null);
  const documentTitle = useMemo(
    () => getPdfDocumentTitle(markdown, fileName),
    [fileName, markdown]
  );
  const suggestedName = useMemo(
    () => createPdfSuggestedName(fileName),
    [fileName]
  );
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isMounted) {
      return;
    }

    const body = document.body;
    const previousOverflow = body.style.overflow;

    previouslyFocusedElementRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    body.classList.add("patchmark-pdf-preview-open");
    body.style.overflow = "hidden";
    window.setTimeout(() => printButtonRef.current?.focus(), 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getFocusableElements(dialogRef.current);

      if (focusableElements.length === 0) {
        return;
      }

      const firstFocusableElement = focusableElements[0];
      const lastFocusableElement =
        focusableElements[focusableElements.length - 1];

      if (
        event.shiftKey &&
        document.activeElement === firstFocusableElement
      ) {
        event.preventDefault();
        lastFocusableElement.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === lastFocusableElement
      ) {
        event.preventDefault();
        firstFocusableElement.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      body.classList.remove("patchmark-pdf-preview-open");
      body.style.overflow = previousOverflow;
      previouslyFocusedElementRef.current?.focus();
    };
  }, [handleClose, isMounted]);

  async function handlePrintPdf() {
    if (renderError) {
      setPrintState("failed");
      return;
    }

    setPrintState("preparing");

    try {
      await waitForPreviewAssets(dialogRef.current);
      const previousTitle = document.title;
      document.title = suggestedName.replace(/\.pdf$/i, "");
      await waitForAnimationFrame();
      window.print();
      window.setTimeout(() => {
        document.title = previousTitle;
        setPrintState("idle");
      }, 800);
    } catch {
      setPrintState("failed");
    }
  }

  if (!isMounted) {
    return null;
  }

  return createPortal(
    <div className="pdf-export-portal-root snapshot-dialog-backdrop workspace-dialog-backdrop">
      <section
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="pdf-export-dialog workspace-dialog-surface"
        role="dialog"
        tabIndex={-1}
      >
        <header className="snapshot-dialog-header pdf-export-header">
          <div>
            <span>PDF export</span>
            <h2 id={titleId}>Clean Shareholder PDF Preview</h2>
            <p>
              Preview uses the current in-memory Markdown. Printing does not
              save, snapshot, or mutate the project.
            </p>
          </div>
          <button className="pdf-export-close" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="pdf-export-controls" aria-label="PDF export controls">
          <div>
            <strong>{documentTitle}</strong>
            <span>Suggested file name: {suggestedName}</span>
          </div>
          <button
            ref={printButtonRef}
            type="button"
            aria-busy={printState === "preparing"}
            disabled={printState === "preparing" || Boolean(renderError)}
            onClick={() => {
              void handlePrintPdf();
            }}
          >
            {printState === "preparing" ? "Preparing..." : "Print / Save PDF"}
          </button>
          <span aria-live="polite">
            {renderError
              ? "Preview render failed"
              : printState === "failed"
                ? "Could not open print dialog"
                : ""}
          </span>
        </div>

        {renderError ? (
          <div className="pdf-export-render-error" role="alert">
            <strong>PDF preview could not render this Markdown.</strong>
            <span>{renderError}</span>
          </div>
        ) : null}

        <div className="pdf-export-dialog-body">
          <article
            className="pdf-export-document"
            aria-label="Clean shareholder PDF document preview"
          >
            <MdxReadonlyPreviewClient
              markdown={markdown}
              onRenderError={setRenderError}
            />
          </article>
        </div>
      </section>
    </div>,
    document.body
  );
}

function getPdfDocumentTitle(markdown: string, fileName: string): string {
  const headingMatch = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);

  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  return fileName.replace(/\.(md|markdown)$/i, "");
}

function createPdfSuggestedName(fileName: string): string {
  const baseName = fileName.replace(/\.(md|markdown)$/i, "");
  return `${baseName || "document"}.shareholder-clean.pdf`;
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }

  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "[tabindex]:not([tabindex='-1'])"
      ].join(",")
    )
  ).filter((element) => !element.hasAttribute("disabled"));
}

async function waitForPreviewAssets(root: HTMLElement | null) {
  if (!root) {
    return;
  }

  const images = Array.from(root.querySelectorAll("img"));

  if (images.length === 0) {
    return;
  }

  await Promise.race([
    Promise.all(
      images.map((image) => {
        if (image.complete) {
          return Promise.resolve();
        }

        return image.decode().catch(() => undefined);
      })
    ),
    new Promise((resolve) => window.setTimeout(resolve, 1500))
  ]);
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
