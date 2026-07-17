"use client";

import { useState } from "react";
import {
  type PatchmarkDocumentRole,
  type PatchmarkProjectDocumentView
} from "@/lib/project/multi-document-project";

type CreateDocumentRequest = {
  displayTitle: string;
  path: string;
  role: PatchmarkDocumentRole;
};

type ProjectDocumentNavigatorProps = {
  activeDocumentId: string | null;
  busy: boolean;
  documents: PatchmarkProjectDocumentView[];
  legacy: boolean;
  projectTitle: string;
  onAddExisting: () => void;
  onArchive: (documentId: string) => void;
  onCreate: (request: CreateDocumentRequest) => void;
  onLocate: (documentId: string) => void;
  onMove: (documentId: string, direction: "up" | "down") => void;
  onRename: (documentId: string, displayTitle: string) => void;
  onRestore: (documentId: string) => void;
  onRoleChange: (documentId: string, role: PatchmarkDocumentRole) => void;
  onSelect: (documentId: string) => void;
};

const roleOptions: Array<{ label: string; value: PatchmarkDocumentRole }> = [
  { label: "No role", value: null },
  { label: "Decision", value: "decision" },
  { label: "Research", value: "research" },
  { label: "Evidence", value: "evidence" },
  { label: "Summary", value: "summary" }
];

export function ProjectDocumentNavigator({
  activeDocumentId,
  busy,
  documents,
  legacy,
  onAddExisting,
  onArchive,
  onCreate,
  onLocate,
  onMove,
  onRename,
  onRestore,
  onRoleChange,
  onSelect,
  projectTitle
}: ProjectDocumentNavigatorProps) {
  const [displayTitle, setDisplayTitle] = useState("");
  const [path, setPath] = useState("");
  const [role, setRole] = useState<PatchmarkDocumentRole>(null);
  const activeDocuments = documents.filter(
    (document) => document.status === "active"
  );
  const archivedDocuments = documents.filter(
    (document) => document.status === "archived"
  );

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onCreate({
      displayTitle: displayTitle.trim(),
      path: path.trim(),
      role
    });
  }

  return (
    <section className="project-document-navigator" aria-label="Project documents">
      <header>
        <span>Project</span>
        <strong>{projectTitle}</strong>
        {legacy ? <small>Legacy single-document format</small> : null}
      </header>

      <div className="project-document-list">
        {activeDocuments.map((document, index) => (
          <article
            className="project-document-item"
            data-active={document.document_id === activeDocumentId ? "true" : undefined}
            data-missing={document.availability === "missing" ? "true" : undefined}
            key={document.document_id}
          >
            <button
              className="project-document-select"
              type="button"
              disabled={busy || document.document_id === activeDocumentId}
              onClick={() => onSelect(document.document_id)}
            >
              <span>{document.display_title}</span>
              <small>{document.path}</small>
            </button>
            <div className="project-document-badges">
              {document.role ? <span>{formatRole(document.role)}</span> : null}
              {document.availability === "missing" ? (
                <span className="project-document-missing">Missing file</span>
              ) : null}
            </div>
            {!legacy ? (
              <div className="project-document-controls">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  aria-label={`Move ${document.display_title} up`}
                  onClick={() => onMove(document.document_id, "up")}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={busy || index === activeDocuments.length - 1}
                  aria-label={`Move ${document.display_title} down`}
                  onClick={() => onMove(document.document_id, "down")}
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const nextTitle = window.prompt(
                      "Patchmark display title",
                      document.display_title
                    );
                    if (nextTitle?.trim()) {
                      onRename(document.document_id, nextTitle.trim());
                    }
                  }}
                >
                  Rename
                </button>
                <select
                  aria-label={`Role for ${document.display_title}`}
                  disabled={busy}
                  value={document.role ?? ""}
                  onChange={(event) =>
                    onRoleChange(
                      document.document_id,
                      (event.target.value || null) as PatchmarkDocumentRole
                    )
                  }
                >
                  {roleOptions.map((option) => (
                    <option key={option.value ?? "none"} value={option.value ?? ""}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {document.availability === "missing" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onLocate(document.document_id)}
                  >
                    Locate file
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy || activeDocuments.length === 1}
                  onClick={() => onArchive(document.document_id)}
                >
                  Archive
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>

      {archivedDocuments.length > 0 ? (
        <details className="project-archived-documents">
          <summary>Archived ({archivedDocuments.length})</summary>
          {archivedDocuments.map((document) => (
            <div key={document.document_id}>
              <span>{document.display_title}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRestore(document.document_id)}
              >
                Restore
              </button>
            </div>
          ))}
        </details>
      ) : null}

      <details className="project-create-document">
        <summary>New document</summary>
        <form onSubmit={handleCreate}>
          <label>
            Display title
            <input
              required
              maxLength={240}
              value={displayTitle}
              onChange={(event) => setDisplayTitle(event.target.value)}
            />
          </label>
          <label>
            Relative Markdown path
            <input
              required
              placeholder="ready-to-eat-investigation.md"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <label>
            Role
            <select
              value={role ?? ""}
              onChange={(event) =>
                setRole((event.target.value || null) as PatchmarkDocumentRole)
              }
            >
              {roleOptions.map((option) => (
                <option key={option.value ?? "none"} value={option.value ?? ""}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy}>
            Create document
          </button>
        </form>
      </details>
      <button
        className="project-add-existing"
        type="button"
        disabled={busy}
        onClick={onAddExisting}
      >
        Add existing document
      </button>
    </section>
  );
}

function formatRole(role: Exclude<PatchmarkDocumentRole, null>): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
