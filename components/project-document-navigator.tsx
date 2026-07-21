"use client";

import { useEffect, useMemo, useState } from "react";
import {
  compareDocumentGroups,
  type PatchmarkDocumentGroup,
  type PatchmarkDocumentRole
} from "@/lib/project/multi-document-project";
import {
  createProjectDocumentIdentity,
  createProjectDocumentKey
} from "@/lib/project/document-scoped-identity";
import { type PatchmarkProjectDocumentListItem } from "@/lib/project/patchmark-project";

type CreateDocumentRequest = {
  displayTitle: string;
  groupId?: string | null;
  path: string;
  role: PatchmarkDocumentRole;
};

type ProjectDocumentNavigatorProps = {
  activeDocumentId: string | null;
  busy: boolean;
  documents: PatchmarkProjectDocumentListItem[];
  groups: PatchmarkDocumentGroup[];
  legacy: boolean;
  projectId: string;
  projectTitle: string;
  onAddExisting: (groupId?: string | null) => void;
  onArchive: (documentId: string) => void;
  onCreate: (request: CreateDocumentRequest) => void;
  onCreateGroup: (title: string) => void;
  onContinueReading: (documentId: string) => void;
  onLocate: (documentId: string) => void;
  onMove: (documentId: string, direction: "up" | "down") => void;
  onMoveGroup: (groupId: string, direction: "up" | "down") => void;
  onMoveToGroup: (documentId: string, groupId: string | null) => void;
  onRemoveGroup: (groupId: string) => void;
  onRename: (documentId: string, displayTitle: string) => void;
  onRenameGroup: (groupId: string, title: string) => void;
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
  groups,
  legacy,
  onAddExisting,
  onArchive,
  onCreate,
  onCreateGroup,
  onContinueReading,
  onLocate,
  onMove,
  onMoveGroup,
  onMoveToGroup,
  onRemoveGroup,
  onRename,
  onRenameGroup,
  onRestore,
  onRoleChange,
  onSelect,
  projectId,
  projectTitle
}: ProjectDocumentNavigatorProps) {
  const [displayTitle, setDisplayTitle] = useState("");
  const [path, setPath] = useState("");
  const [role, setRole] = useState<PatchmarkDocumentRole>(null);
  const [createGroupId, setCreateGroupId] = useState<string | null>(null);
  const [existingGroupId, setExistingGroupId] = useState<string | null>(null);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set()
  );
  const orderedGroups = useMemo(
    () => [...groups].sort(compareDocumentGroups),
    [groups]
  );
  const activeDocuments = documents.filter(
    (document) => document.status === "active"
  );
  const archivedDocuments = documents.filter(
    (document) => document.status === "archived"
  );
  const activeDocument = documents.find(
    (document) => document.document_id === activeDocumentId
  );
  const activeGroupId = activeDocument?.group_id ?? null;
  const hasGroups = orderedGroups.length > 0;

  useEffect(() => {
    setCollapsedGroupIds(
      new Set(
        orderedGroups
          .filter((group) => readGroupCollapseState(projectId, group.group_id))
          .map((group) => group.group_id)
      )
    );
  }, [orderedGroups, projectId]);

  useEffect(() => {
    if (!activeGroupId) {
      return;
    }
    setCollapsedGroupIds((current) => {
      if (!current.has(activeGroupId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(activeGroupId);
      writeGroupCollapseState(projectId, activeGroupId, false);
      return next;
    });
  }, [activeDocumentId, activeGroupId, projectId]);

  useEffect(() => {
    const groupIds = new Set(orderedGroups.map((group) => group.group_id));
    const fallback = activeGroupId && groupIds.has(activeGroupId)
      ? activeGroupId
      : null;
    setCreateGroupId((current) =>
      current === null || groupIds.has(current) ? current : fallback
    );
    setExistingGroupId((current) =>
      current === null || groupIds.has(current) ? current : fallback
    );
  }, [activeGroupId, orderedGroups]);

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onCreate({
      displayTitle: displayTitle.trim(),
      ...(hasGroups ? { groupId: createGroupId } : {}),
      path: path.trim(),
      role
    });
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      writeGroupCollapseState(projectId, groupId, next.has(groupId));
      return next;
    });
  }

  function renderDocument(
    document: PatchmarkProjectDocumentListItem,
    scopedDocuments: PatchmarkProjectDocumentListItem[],
    index: number
  ) {
    return (
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
          {document.hasReadingBookmark ? (
            <button
              key={`bookmark:${createProjectDocumentKey(
                createProjectDocumentIdentity(projectId, document.document_id)
              )}`}
              className="project-document-bookmark"
              type="button"
              disabled={busy}
              aria-label={`Continue reading in ${document.display_title}`}
              onClick={() => onContinueReading(document.document_id)}
              title={`Continue reading in ${document.display_title}`}
            >
              <span aria-hidden="true">🔖</span> Bookmark
            </button>
          ) : null}
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
              disabled={busy || index === scopedDocuments.length - 1}
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
            {hasGroups ? (
              <select
                aria-label={`Group for ${document.display_title}`}
                disabled={busy}
                value={document.group_id ?? ""}
                onChange={(event) =>
                  onMoveToGroup(document.document_id, event.target.value || null)
                }
              >
                <option value="">Ungrouped</option>
                {orderedGroups.map((group) => (
                  <option key={group.group_id} value={group.group_id}>
                    {group.title}
                  </option>
                ))}
              </select>
            ) : null}
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
    );
  }

  return (
    <section className="project-document-navigator" aria-label="Project documents">
      <header>
        <span>Project</span>
        <strong>{projectTitle}</strong>
        {legacy ? <small>Legacy single-document format</small> : null}
      </header>

      {!legacy ? (
        <button
          className="project-create-group"
          type="button"
          disabled={busy}
          onClick={() => {
            const title = window.prompt("New document group title");
            if (title?.trim()) {
              onCreateGroup(title.trim());
            }
          }}
        >
          + New group
        </button>
      ) : null}

      <div className="project-document-list">
        {hasGroups ? (
          <>
            {orderedGroups.map((group, groupIndex) => {
              const groupDocuments = activeDocuments.filter(
                (document) => document.group_id === group.group_id
              );
              const collapsed = collapsedGroupIds.has(group.group_id);
              return (
                <section
                  className="project-document-group"
                  data-group-id={group.group_id}
                  key={group.group_id}
                >
                  <div className="project-document-group-header">
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.title}`}
                      onClick={() => toggleGroup(group.group_id)}
                    >
                      <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                      <strong title={group.title}>{group.title}</strong>
                      <small>{groupDocuments.length}</small>
                    </button>
                    <div>
                      <button
                        type="button"
                        disabled={busy || groupIndex === 0}
                        aria-label={`Move ${group.title} group up`}
                        onClick={() => onMoveGroup(group.group_id, "up")}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={busy || groupIndex === orderedGroups.length - 1}
                        aria-label={`Move ${group.title} group down`}
                        onClick={() => onMoveGroup(group.group_id, "down")}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const title = window.prompt("Document group title", group.title);
                          if (title?.trim()) {
                            onRenameGroup(group.group_id, title.trim());
                          }
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const members = documents.filter(
                            (document) => document.group_id === group.group_id
                          );
                          const activeCount = members.filter(
                            (document) => document.status === "active"
                          ).length;
                          const archivedCount = members.length - activeCount;
                          const message = members.length === 0
                            ? `Remove “${group.title}” group?`
                            : `Remove “${group.title}” group?\n\n${activeCount} active documents and ${archivedCount} archived documents will become ungrouped.\nNo Markdown files, comments, patches, bookmarks, or history will be deleted.`;
                          if (window.confirm(message)) {
                            writeGroupCollapseState(projectId, group.group_id, false);
                            onRemoveGroup(group.group_id);
                          }
                        }}
                      >
                        Remove
                      </button>
                    </div>
                    {collapsed &&
                    groupDocuments.some((document) => document.hasReadingBookmark) ? (
                      <div className="project-document-group-bookmarks">
                        {groupDocuments
                          .filter((document) => document.hasReadingBookmark)
                          .map((document) => (
                            <button
                              key={`collapsed-bookmark:${createProjectDocumentKey(
                                createProjectDocumentIdentity(
                                  projectId,
                                  document.document_id
                                )
                              )}`}
                              className="project-document-bookmark"
                              type="button"
                              disabled={busy}
                              aria-label={`Continue reading in ${document.display_title}`}
                              onClick={() => onContinueReading(document.document_id)}
                              title={`Continue reading in ${document.display_title}`}
                            >
                              <span aria-hidden="true">🔖</span> {document.display_title}
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </div>
                  {!collapsed ? (
                    <div className="project-document-group-list">
                      {groupDocuments.map((document, index) =>
                        renderDocument(document, groupDocuments, index)
                      )}
                      {groupDocuments.length === 0 ? (
                        <p className="project-document-group-empty">No active documents</p>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {activeDocuments.some((document) => !document.group_id) ? (
              <section className="project-document-group project-document-ungrouped">
                <div className="project-document-group-label">Ungrouped</div>
                <div className="project-document-group-list">
                  {activeDocuments
                    .filter((document) => !document.group_id)
                    .map((document, index, ungrouped) =>
                      renderDocument(document, ungrouped, index)
                    )}
                </div>
              </section>
            ) : null}
          </>
        ) : (
          activeDocuments.map((document, index) =>
            renderDocument(document, activeDocuments, index)
          )
        )}
      </div>

      {archivedDocuments.length > 0 ? (
        <details className="project-archived-documents">
          <summary>Archived ({archivedDocuments.length})</summary>
          {archivedDocuments.map((document) => {
            const group = orderedGroups.find(
              (candidate) => candidate.group_id === document.group_id
            );
            return (
              <div key={document.document_id}>
                <span>
                  {document.display_title}
                  {group ? <small>{group.title}</small> : null}
                </span>
                {document.hasReadingBookmark ? (
                  <span aria-label={`${document.display_title} has a reading bookmark`}>
                    🔖 Bookmark
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRestore(document.document_id)}
                >
                  Restore
                </button>
              </div>
            );
          })}
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
          {hasGroups ? (
            <GroupSelector
              groups={orderedGroups}
              label="Group"
              value={createGroupId}
              onChange={setCreateGroupId}
            />
          ) : null}
          <button type="submit" disabled={busy}>
            Create document
          </button>
        </form>
      </details>
      {hasGroups ? (
        <GroupSelector
          groups={orderedGroups}
          label="Group for existing document"
          value={existingGroupId}
          onChange={setExistingGroupId}
        />
      ) : null}
      <button
        className="project-add-existing"
        type="button"
        disabled={busy}
        onClick={() => onAddExisting(hasGroups ? existingGroupId : undefined)}
      >
        Add existing document
      </button>
    </section>
  );
}

function GroupSelector({
  groups,
  label,
  onChange,
  value
}: {
  groups: PatchmarkDocumentGroup[];
  label: string;
  onChange: (value: string | null) => void;
  value: string | null;
}) {
  return (
    <label className="project-group-selector">
      {label}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Ungrouped</option>
        {groups.map((group) => (
          <option key={group.group_id} value={group.group_id}>
            {group.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function getGroupCollapseStateKey(projectId: string, groupId: string): string {
  return `patchmark:document-group-collapsed:${projectId}:${groupId}`;
}

function readGroupCollapseState(projectId: string, groupId: string): boolean {
  try {
    return window.localStorage.getItem(getGroupCollapseStateKey(projectId, groupId)) === "true";
  } catch {
    return false;
  }
}

function writeGroupCollapseState(
  projectId: string,
  groupId: string,
  collapsed: boolean
): void {
  try {
    const key = getGroupCollapseStateKey(projectId, groupId);
    if (collapsed) {
      window.localStorage.setItem(key, "true");
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    return;
  }
}

function formatRole(role: Exclude<PatchmarkDocumentRole, null>): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
