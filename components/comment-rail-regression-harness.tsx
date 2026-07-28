"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type ActiveCommentState,
  CommentsPanel,
  type CommentAnchorSummary,
  type CommentFormValues
} from "@/components/comments-panel";
import { type PatchmarkComment } from "@/lib/project/project-types";

const regressionAnchors = [
  {
    id: "PM-COMMENT-A",
    label: "Alpha onboarding claim",
    offset: 100,
    text: "Alpha teams need the onboarding claim clarified."
  },
  {
    id: "PM-COMMENT-B",
    label: "Beta pricing caveat",
    offset: 350,
    text: "Beta pricing needs a sharper caveat."
  },
  {
    id: "PM-COMMENT-C",
    label: "Core market-view signal",
    offset: 700,
    text: "Core market-view signal should stay visually anchored."
  },
  {
    id: "PM-COMMENT-D",
    label: "Delta risk note",
    offset: 760,
    text: "Delta risk language should move only when displaced."
  },
  {
    id: "PM-COMMENT-E",
    label: "Expansion proof point",
    offset: 1200,
    text: "Expansion proof point anchors the lower rail."
  }
] as const;

export function CommentRailRegressionHarness() {
  const [isHydrated, setIsHydrated] = useState(false);
  const [activeCommentState, setActiveCommentState] =
    useState<ActiveCommentState>({ kind: "none" });
  const comments = useMemo(
    () =>
      regressionAnchors.map((anchor, index) =>
        makeRegressionComment({
          createdAt: `2026-07-12T00:0${index}:00.000Z`,
          id: anchor.id,
          offset: anchor.offset,
          selectedText: anchor.text,
          title: anchor.label
        })
      ),
    []
  );
  const commentPositions = useMemo(
    () =>
      Object.fromEntries(
        regressionAnchors.map((anchor) => [anchor.id, anchor.offset])
      ),
    []
  );
  const anchorSummaries = useMemo<Record<string, CommentAnchorSummary>>(
    () =>
      Object.fromEntries(
        regressionAnchors.map((anchor) => [
          anchor.id,
          {
            label: anchor.label,
            locationLabel: "Rail regression fixture",
            status: "active" as const
          }
        ])
      ),
    []
  );

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  return (
    <section
      aria-label="Comment rail regression fixture"
      className="comment-rail-regression"
      data-regression-active-id={
        activeCommentState.kind === "comment"
          ? activeCommentState.commentId
          : activeCommentState.kind
      }
      data-regression-ready={isHydrated ? "true" : "false"}
    >
      <div>
        <h2>Comment Rail Regression Fixture</h2>
        <p>
          This route renders five real comment cards through{" "}
          <code>CommentsPanel</code> so browser checks can verify rail movement
          without opening a user project.
        </p>
      </div>

      <div className="document-workspace comment-rail-regression-workspace">
        <aside className="document-sidebar" aria-label="Fixture outline">
          <div className="sidebar-card">
            <h3>Fixture Anchors</h3>
            <p>Five comments A–E with stable workspace-relative targets.</p>
          </div>
        </aside>

        <div className="editor-panel" data-regression-editor>
          <div
            className="comment-rail-regression-document"
            data-regression-document
          >
            {regressionAnchors.map((anchor) => (
              <div
                className="comment-rail-regression-anchor"
                data-anchor-end={anchor.offset + anchor.text.length}
                data-anchor-start={anchor.offset}
                data-comment-anchor={anchor.id}
                key={anchor.id}
                style={{ top: `${anchor.offset}px` }}
              >
                <strong>{anchor.id.replace("PM-COMMENT-", "")}</strong>
                <span>{anchor.text}</span>
              </div>
            ))}
          </div>
        </div>

        <aside className="comments-rail" aria-label="Document comments">
          <CommentsPanel
            addRequest={null}
            activeCommentState={activeCommentState}
            anchorSummaries={anchorSummaries}
            commentPositions={commentPositions}
            comments={comments}
            defaultSectionLine={null}
            error={null}
            headings={[]}
            isBusy={false}
            isProjectMode
            onAddComment={noopAsyncCommentForm}
            onCloseAddComment={noopVoid}
            onDeleteComment={noopAsyncId}
            onEditComment={noopAsyncEditComment}
            onEditReply={noopAsyncEditReply}
            onFindComment={noopAsyncComment}
            onMarkCommentForExport={noopAsyncId}
            onReopenComment={noopAsyncId}
            onReplyComment={noopAsyncReply}
            onReviewCommentPatches={noopVoidId}
            onStartReanchor={noopVoidId}
            onReviewFirstPendingPatch={noopVoid}
            onResolveComment={noopAsyncId}
            onSetActiveCommentState={setActiveCommentState}
            onUnmarkCommentForExport={noopAsyncId}
            patchGroupSummariesByCommentId={{}}
            pendingPatchCountsByCommentId={{}}
            pendingPatchGroupTotal={0}
            pendingPatchTotal={0}
            replyRequest={null}
            selectedAnchorContextKind={null}
            selectedTextPreview={null}
          />
        </aside>
      </div>
    </section>
  );
}

function makeRegressionComment({
  createdAt,
  id,
  offset,
  selectedText,
  title
}: {
  createdAt: string;
  id: string;
  offset: number;
  selectedText: string;
  title: string;
}): PatchmarkComment {
  return {
    id,
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: offset,
      markdown_end_offset: offset + selectedText.length,
      anchor_context: {
        kind: "paragraph",
        plain_text: selectedText,
        markdown_text: selectedText,
        selected_start_in_context: 0,
        selected_end_in_context: selectedText.length,
        markdown_start_offset: offset,
        markdown_end_offset: offset + selectedText.length
      },
      containing_heading: "Comment Rail Regression Fixture",
      containing_heading_level: 2
    },
    comment: `${title} must remain stable when another comment is activated.`,
    thread: [
      {
        id: `${id}-THREAD-USER`,
        role: "user",
        content:
          "The compact card should keep its measured rail position unless an earlier card physically displaces it.",
        created_at: createdAt
      },
      {
        id: `${id}-THREAD-CHATGPT`,
        role: "chatgpt",
        content:
          "Expanded details intentionally make this card taller so movement caused by activation is visible in browser measurements.",
        created_at: createdAt
      }
    ],
    export_state: { focus_state: "idle" },
    created_at: createdAt,
    updated_at: createdAt
  };
}

async function noopAsyncCommentForm(values: CommentFormValues): Promise<void> {
  void values;
}

async function noopAsyncId(id: string): Promise<void> {
  void id;
}

async function noopAsyncEditComment(
  commentId: string,
  values: Pick<CommentFormValues, "comment" | "type">
): Promise<void> {
  void commentId;
  void values;
}

async function noopAsyncEditReply(
  commentId: string,
  entryId: string,
  content: string
): Promise<void> {
  void commentId;
  void entryId;
  void content;
}

async function noopAsyncComment(comment: PatchmarkComment): Promise<void> {
  void comment;
}

async function noopAsyncReply(
  commentId: string,
  content: string
): Promise<void> {
  void commentId;
  void content;
}

function noopVoidId(id: string): void {
  void id;
}

function noopVoid(): void {}
