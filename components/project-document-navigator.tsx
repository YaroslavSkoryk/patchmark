"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ActionMenu,
  ActionMenuGroup,
  ActionMenuItem
} from "@/components/action-menu";
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
  recoveryDocumentIds: string[];
  requestedDocumentId: string | null;
  selectionBusy: boolean;
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

type NavigatorEditState =
  | { documentId: string; type: "document-group"; value: string | null }
  | { documentId: string; type: "document-role"; value: PatchmarkDocumentRole }
  | { documentId: string; type: "document-title"; value: string }
  | { groupId: string; type: "group-title"; value: string };

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
  projectTitle,
  recoveryDocumentIds,
  requestedDocumentId,
  selectionBusy
}: ProjectDocumentNavigatorProps) {
  const [displayTitle, setDisplayTitle] = useState("");
  const [path, setPath] = useState("");
  const [role, setRole] = useState<PatchmarkDocumentRole>(null);
  const [createGroupId, setCreateGroupId] = useState<string | null>(null);
  const [existingGroupId, setExistingGroupId] = useState<string | null>(null);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [editState, setEditState] = useState<NavigatorEditState | null>(null);
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
  const requestedGroupId = documents.find(
    (document) => document.document_id === requestedDocumentId
  )?.group_id ?? null;
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
    if (!requestedGroupId) {
      return;
    }
    setCollapsedGroupIds((current) => {
      if (!current.has(requestedGroupId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(requestedGroupId);
      writeGroupCollapseState(projectId, requestedGroupId, false);
      return next;
    });
  }, [projectId, requestedDocumentId, requestedGroupId]);

  useEffect(() => {
    const groupIds = new Set(orderedGroups.map((group) => group.group_id));
    const fallback =
      activeGroupId && groupIds.has(activeGroupId) ? activeGroupId : null;
    setCreateGroupId((current) =>
      current === null || groupIds.has(current) ? current : fallback
    );
    setExistingGroupId((current) =>
      current === null || groupIds.has(current) ? current : fallback
    );
  }, [activeGroupId, orderedGroups]);

  function handleCreate(event: FormEvent<HTMLFormElement>) {
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

  function startNewGroup() {
    const title = window.prompt("New document group title");
    if (title?.trim()) {
      onCreateGroup(title.trim());
    }
  }

  function removeGroup(group: PatchmarkDocumentGroup) {
    const members = documents.filter(
      (document) => document.group_id === group.group_id
    );
    const activeCount = members.filter(
      (document) => document.status === "active"
    ).length;
    const archivedCount = members.length - activeCount;
    const message =
      members.length === 0
        ? `Remove “${group.title}” group?`
        : `Remove “${group.title}” group?\n\n${activeCount} active documents and ${archivedCount} archived documents will become ungrouped.\nNo Markdown files, comments, patches, bookmarks, or history will be deleted.`;
    if (window.confirm(message)) {
      writeGroupCollapseState(projectId, group.group_id, false);
      onRemoveGroup(group.group_id);
    }
  }

  function finishInlineEdit(triggerLabel: string) {
    setEditState(null);
    window.requestAnimationFrame(() => {
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".project-navigation-menu-trigger"
        )
      )
        .find((button) => button.getAttribute("aria-label") === triggerLabel)
        ?.focus();
    });
  }

  function renderDocument(
    document: PatchmarkProjectDocumentListItem,
    scopedDocuments: PatchmarkProjectDocumentListItem[],
    index: number
  ) {
    const isActive = document.document_id === activeDocumentId;
    const documentEdit =
      editState &&
      "documentId" in editState &&
      editState.documentId === document.document_id
        ? editState
        : null;

    return (
      <article
        className="project-document-item"
        data-active={isActive ? "true" : undefined}
        data-requested={
          document.document_id === requestedDocumentId ? "true" : undefined
        }
        data-missing={document.availability === "missing" ? "true" : undefined}
        key={document.document_id}
      >
        <div className="project-document-row-main">
          <button
            className="project-document-select"
            type="button"
            aria-current={isActive ? "page" : undefined}
            disabled={
              selectionBusy ||
              isActive ||
              document.document_id === requestedDocumentId
            }
            onClick={() => onSelect(document.document_id)}
          >
            <span>{document.display_title}</span>
            <small>{document.path}</small>
          </button>
          {!legacy ? (
            <ActionMenu
              label={`Actions for ${document.display_title}`}
              rootClassName="project-navigation-menu"
              triggerClassName="project-navigation-menu-trigger"
              triggerChildren={<span aria-hidden="true">•••</span>}
              panelClassName="project-navigation-menu-panel"
            >
              {(closeMenu) => (
                <ActionMenuGroup
                  className="project-navigation-menu-group"
                  label="Document actions"
                  labelClassName="project-navigation-menu-label"
                >
                  <ActionMenuItem
                    className="project-navigation-menu-item"
                    closeMenu={closeMenu}
                    disabled={busy || index === 0}
                    onSelect={() => onMove(document.document_id, "up")}
                  >
                    Move up
                  </ActionMenuItem>
                  <ActionMenuItem
                    className="project-navigation-menu-item"
                    closeMenu={closeMenu}
                    disabled={busy || index === scopedDocuments.length - 1}
                    onSelect={() => onMove(document.document_id, "down")}
                  >
                    Move down
                  </ActionMenuItem>
                  <ActionMenuItem
                    className="project-navigation-menu-item"
                    closeMenu={closeMenu}
                    disabled={busy}
                    onSelect={() =>
                      setEditState({
                        documentId: document.document_id,
                        type: "document-title",
                        value: document.display_title
                      })
                    }
                  >
                    Rename
                  </ActionMenuItem>
                  <ActionMenuItem
                    className="project-navigation-menu-item"
                    closeMenu={closeMenu}
                    disabled={busy}
                    onSelect={() =>
                      setEditState({
                        documentId: document.document_id,
                        type: "document-role",
                        value: document.role
                      })
                    }
                  >
                    Change role
                  </ActionMenuItem>
                  {hasGroups ? (
                    <ActionMenuItem
                      className="project-navigation-menu-item"
                      closeMenu={closeMenu}
                      disabled={busy}
                      onSelect={() =>
                        setEditState({
                          documentId: document.document_id,
                          type: "document-group",
                          value: document.group_id ?? null
                        })
                      }
                    >
                      Move to group
                    </ActionMenuItem>
                  ) : null}
                  {document.availability === "missing" ? (
                    <ActionMenuItem
                      className="project-navigation-menu-item"
                      closeMenu={closeMenu}
                      disabled={busy}
                      onSelect={() => onLocate(document.document_id)}
                    >
                      Locate file
                    </ActionMenuItem>
                  ) : null}
                  <ActionMenuItem
                    className="project-navigation-menu-item project-navigation-menu-item-destructive"
                    closeMenu={closeMenu}
                    disabled={busy || activeDocuments.length === 1}
                    onSelect={() => onArchive(document.document_id)}
                  >
                    Archive
                  </ActionMenuItem>
                </ActionMenuGroup>
              )}
            </ActionMenu>
          ) : null}
        </div>
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
          {recoveryDocumentIds.includes(document.document_id) ? (
            <span className="project-document-recovery">Unsaved recovery</span>
          ) : null}
          {document.document_id === requestedDocumentId ? (
            <span className="project-document-opening">Opening…</span>
          ) : null}
        </div>
        {documentEdit ? (
          <DocumentEditForm
            busy={busy}
            editState={documentEdit}
            groups={orderedGroups}
            title={document.display_title}
            onCancel={() =>
              finishInlineEdit(`Actions for ${document.display_title}`)
            }
            onChange={setEditState}
            onSave={() => {
              if (documentEdit.type === "document-title") {
                const title = documentEdit.value.trim();
                if (!title) {
                  return;
                }
                onRename(document.document_id, title);
              } else if (documentEdit.type === "document-role") {
                onRoleChange(document.document_id, documentEdit.value);
              } else {
                onMoveToGroup(document.document_id, documentEdit.value);
              }
              finishInlineEdit(`Actions for ${document.display_title}`);
            }}
          />
        ) : null}
      </article>
    );
  }

  return (
    <section className="project-document-navigator" aria-label="Project documents">
      <div className="project-navigation-header">
        <button
          className="project-navigation-project-toggle"
          type="button"
          aria-expanded={projectExpanded}
          onClick={() => setProjectExpanded((current) => !current)}
        >
          <span aria-hidden="true">{projectExpanded ? "▾" : "▸"}</span>
          <span>
            <small>Project</small>
            <strong title={projectTitle}>{projectTitle}</strong>
          </span>
        </button>
        {!legacy ? (
          <ActionMenu
            label={`Actions for ${projectTitle}`}
            rootClassName="project-navigation-menu"
            triggerClassName="project-navigation-menu-trigger"
            triggerChildren={<span aria-hidden="true">•••</span>}
            panelClassName="project-navigation-menu-panel"
          >
            {(closeMenu) => (
              <ActionMenuGroup
                className="project-navigation-menu-group"
                label="Project actions"
                labelClassName="project-navigation-menu-label"
              >
                <ActionMenuItem
                  className="project-navigation-menu-item"
                  closeMenu={closeMenu}
                  disabled={busy}
                  onSelect={startNewGroup}
                >
                  New group
                </ActionMenuItem>
              </ActionMenuGroup>
            )}
          </ActionMenu>
        ) : null}
      </div>
      {legacy ? (
        <small className="project-navigation-legacy">
          Legacy single-document format
        </small>
      ) : null}

      {projectExpanded ? (
        <>
          <div className="project-document-list">
            {hasGroups ? (
              <>
                {orderedGroups.map((group, groupIndex) => {
                  const groupDocuments = activeDocuments.filter(
                    (document) => document.group_id === group.group_id
                  );
                  const collapsed = collapsedGroupIds.has(group.group_id);
                  const groupEdit =
                    editState?.type === "group-title" &&
                    editState.groupId === group.group_id
                      ? editState
                      : null;
                  return (
                    <section
                      className="project-document-group"
                      data-group-id={group.group_id}
                      key={group.group_id}
                    >
                      <div className="project-document-group-header">
                        <button
                          className="project-document-group-toggle"
                          type="button"
                          aria-expanded={!collapsed}
                          aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.title}`}
                          onClick={() => toggleGroup(group.group_id)}
                        >
                          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                          <strong title={group.title}>{group.title}</strong>
                          <small>{groupDocuments.length}</small>
                        </button>
                        <ActionMenu
                          label={`Actions for ${group.title} group`}
                          rootClassName="project-navigation-menu"
                          triggerClassName="project-navigation-menu-trigger"
                          triggerChildren={<span aria-hidden="true">•••</span>}
                          panelClassName="project-navigation-menu-panel"
                        >
                          {(closeMenu) => (
                            <ActionMenuGroup
                              className="project-navigation-menu-group"
                              label="Group actions"
                              labelClassName="project-navigation-menu-label"
                            >
                              <ActionMenuItem
                                className="project-navigation-menu-item"
                                closeMenu={closeMenu}
                                disabled={busy || groupIndex === 0}
                                onSelect={() => onMoveGroup(group.group_id, "up")}
                              >
                                Move up
                              </ActionMenuItem>
                              <ActionMenuItem
                                className="project-navigation-menu-item"
                                closeMenu={closeMenu}
                                disabled={
                                  busy || groupIndex === orderedGroups.length - 1
                                }
                                onSelect={() =>
                                  onMoveGroup(group.group_id, "down")
                                }
                              >
                                Move down
                              </ActionMenuItem>
                              <ActionMenuItem
                                className="project-navigation-menu-item"
                                closeMenu={closeMenu}
                                disabled={busy}
                                onSelect={() =>
                                  setEditState({
                                    groupId: group.group_id,
                                    type: "group-title",
                                    value: group.title
                                  })
                                }
                              >
                                Rename
                              </ActionMenuItem>
                              <ActionMenuItem
                                className="project-navigation-menu-item project-navigation-menu-item-destructive"
                                closeMenu={closeMenu}
                                disabled={busy}
                                onSelect={() => removeGroup(group)}
                              >
                                Remove
                              </ActionMenuItem>
                            </ActionMenuGroup>
                          )}
                        </ActionMenu>
                        {groupEdit ? (
                          <form
                            className="project-navigation-inline-edit project-navigation-group-edit"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const title = groupEdit.value.trim();
                              if (!title) {
                                return;
                              }
                              onRenameGroup(group.group_id, title);
                              finishInlineEdit(
                                `Actions for ${group.title} group`
                              );
                            }}
                          >
                            <label>
                              Group name
                              <input
                                autoFocus
                                required
                                disabled={busy}
                                maxLength={240}
                                value={groupEdit.value}
                                onChange={(event) =>
                                  setEditState({
                                    ...groupEdit,
                                    value: event.target.value
                                  })
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    finishInlineEdit(
                                      `Actions for ${group.title} group`
                                    );
                                  }
                                }}
                              />
                            </label>
                            <InlineEditActions
                              busy={busy}
                              onCancel={() =>
                                finishInlineEdit(
                                  `Actions for ${group.title} group`
                                )
                              }
                            />
                          </form>
                        ) : null}
                        {collapsed &&
                        groupDocuments.some(
                          (document) => document.hasReadingBookmark
                        ) ? (
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
                                  onClick={() =>
                                    onContinueReading(document.document_id)
                                  }
                                  title={`Continue reading in ${document.display_title}`}
                                >
                                  <span aria-hidden="true">🔖</span>{" "}
                                  {document.display_title}
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
                            <p className="project-document-group-empty">
                              No active documents
                            </p>
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
                      <span
                        aria-label={`${document.display_title} has a reading bookmark`}
                      >
                        🔖 Bookmark
                      </span>
                    ) : null}
                    {recoveryDocumentIds.includes(document.document_id) ? (
                      <span
                        aria-label={`${document.display_title} has unsaved recovery`}
                      >
                        Unsaved recovery
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

          <details className="project-add-document">
            <summary>Add document</summary>
            <div className="project-add-document-options">
              <details className="project-create-document">
                <summary>Create new document</summary>
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
                        setRole(
                          (event.target.value || null) as PatchmarkDocumentRole
                        )
                      }
                    >
                      {roleOptions.map((option) => (
                        <option
                          key={option.value ?? "none"}
                          value={option.value ?? ""}
                        >
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
              <div className="project-add-existing-option">
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
                  onClick={() =>
                    onAddExisting(hasGroups ? existingGroupId : undefined)
                  }
                >
                  Add existing document
                </button>
              </div>
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}

function DocumentEditForm({
  busy,
  editState,
  groups,
  onCancel,
  onChange,
  onSave,
  title
}: {
  busy: boolean;
  editState: Exclude<NavigatorEditState, { type: "group-title" }>;
  groups: PatchmarkDocumentGroup[];
  onCancel: () => void;
  onChange: (state: NavigatorEditState) => void;
  onSave: () => void;
  title: string;
}) {
  return (
    <form
      className="project-document-controls project-navigation-inline-edit"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      {editState.type === "document-title" ? (
        <label>
          Document name
          <input
            autoFocus
            required
            disabled={busy}
            maxLength={240}
            value={editState.value}
            onChange={(event) =>
              onChange({ ...editState, value: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }
            }}
          />
        </label>
      ) : editState.type === "document-role" ? (
        <label>
          Role for {title}
          <select
            autoFocus
            aria-label={`Role for ${title}`}
            disabled={busy}
            value={editState.value ?? ""}
            onChange={(event) =>
              onChange({
                ...editState,
                value: (event.target.value || null) as PatchmarkDocumentRole
              })
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }
            }}
          >
            {roleOptions.map((option) => (
              <option key={option.value ?? "none"} value={option.value ?? ""}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <GroupSelector
          autoFocus
          disabled={busy}
          groups={groups}
          label={`Group for ${title}`}
          value={editState.value}
          onChange={(value) => onChange({ ...editState, value })}
          onEscape={onCancel}
        />
      )}
      <InlineEditActions busy={busy} onCancel={onCancel} />
    </form>
  );
}

function InlineEditActions({
  busy,
  onCancel
}: {
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="project-navigation-inline-edit-actions">
      <button type="submit" disabled={busy}>
        Save
      </button>
      <button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function GroupSelector({
  autoFocus = false,
  disabled = false,
  groups,
  label,
  onChange,
  onEscape,
  value
}: {
  autoFocus?: boolean;
  disabled?: boolean;
  groups: PatchmarkDocumentGroup[];
  label: string;
  onChange: (value: string | null) => void;
  onEscape?: () => void;
  value: string | null;
}) {
  return (
    <label className="project-group-selector">
      {label}
      <select
        autoFocus={autoFocus}
        aria-label={label}
        disabled={disabled}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && onEscape) {
            event.preventDefault();
            event.stopPropagation();
            onEscape();
          }
        }}
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
    return (
      window.localStorage.getItem(getGroupCollapseStateKey(projectId, groupId)) ===
      "true"
    );
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
