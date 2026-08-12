import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editor = readFileSync(
  new URL("../components/document-editor.tsx", import.meta.url),
  "utf8"
);
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const reanchor = readFileSync(
  new URL("../lib/comments/comment-reanchor.ts", import.meta.url),
  "utf8"
);
const projectTypes = readFileSync(
  new URL("../lib/project/project-types.ts", import.meta.url),
  "utf8"
);

assert.match(
  projectTypes,
  /export type CommentAnchorStatus =\s*\| "active"\s*\| "not_found"\s*\| "ambiguous"\s*\| "document";/,
  "Phase 6 must preserve the persisted comment-anchor states"
);
assert.match(
  projectTypes,
  /export type PatchmarkPatchStatus =\s*\| "pending"\s*\| "accepted"\s*\| "rejected"\s*\| "stale";/,
  "Phase 6 must preserve the persisted patch lifecycle"
);

for (const canonicalBoundary of [
  "resolveCanonicalCommentTarget(comment",
  "createHumanReanchorCandidates({",
  "createHumanReanchorProposal({",
  "applyHumanReanchor({",
  "createDocumentHash(markdown)",
  "saveGeneration: projectHandle.manifest.save_generation ?? 0",
  "reason: `human_reanchor:${comment.id}`"
]) {
  assert.ok(editor.includes(canonicalBoundary), `Missing boundary: ${canonicalBoundary}`);
}

assert.match(
  reanchor,
  /currentProjectId !== proposal\.projectId[\s\S]*?currentDocumentId !== proposal\.documentId[\s\S]*?comment\.id !== proposal\.commentId[\s\S]*?currentDocumentGeneration !== proposal\.documentGeneration[\s\S]*?currentSaveGeneration !== proposal\.saveGeneration/,
  "Human repair must revalidate project, document, comment, and generations"
);
assert.match(
  reanchor,
  /markdown\.slice\(proposal\.range\.start, proposal\.range\.end\) !==\s*proposal\.selectedText/,
  "Human repair must revalidate exact selected text"
);
assert.match(reanchor, /cause: "human_reanchor"/);
assert.match(reanchor, /confidence: "human_confirmed"/);
assert.match(reanchor, /reason: "anchor_reanchored_by_human"/);

assert.match(editor, /<ol>[\s\S]{0,1400}className="reanchor-candidate-option"/);
assert.match(editor, /aria-pressed=\{isPreviewed\}/);
assert.match(editor, /className="reanchor-candidate-preview"/);
assert.match(editor, /<MarkdownSnippetPreview markdown=\{reanchorPreviewCandidate\.selectedText\} \/>/);
assert.match(editor, /Inspect a location; nothing is saved yet\./);
assert.doesNotMatch(editor, /reanchor-candidate-card/);
assert.doesNotMatch(editor, /Accept all candidates|Confirm all candidates|Automatically confirm/i);

assert.match(editor, /manualSelectionOpen: candidates\.length === 0/);
assert.match(editor, /Select text manually/);
assert.match(editor, /Use selection as new anchor/);
assert.match(editor, /mode === "visual" \? "Visual Mode" : "Markdown Mode"/);
assert.match(editor, /getDraftMarkdownRange\(\s*reanchorSession\?\.selectionDraft/);
assert.match(editor, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);

assert.match(editor, /reanchorSession && !reanchorConfirmation/);
assert.match(editor, /!reanchorSession \? \(\s*<CommentsPanel/);
assert.match(editor, /isNarrowNavigation && commentsOpen && !reanchorSession/);
assert.match(editor, /!isNarrowNavigation \|\| !commentsOpen \|\| reanchorSession/);
assert.match(editor, /aria-modal="true"/);
assert.match(editor, /role="dialog"/);
assert.match(editor, /document\.body\.style\.overflow = "hidden"/);
assert.match(editor, /element\.inert = true/);
assert.match(
  editor,
  /trapTabWithin\(\s*event,\s*dialog,[\s\S]*?button:not\(:disabled\)/
);
assert.match(editor, /reanchorConfirmationHeadingRef\.current\?\.focus\(\)/);

assert.match(editor, /This changes only where the comment points/);
assert.match(editor, /linked patches remain unchanged/i);
assert.match(editor, /Repair details and recovery history/);
assert.match(editor, /Recovered automatically/);
assert.match(editor, /Repaired by you/);
assert.match(editor, /The previous anchor remains authoritative/);
assert.match(editor, /This comment is already anchored to that text/);
assert.match(editor, /restoreFocusToCommentCard\(comment\.id\)/);

assert.match(css, /\.reanchor-candidate-list ol\s*\{[\s\S]*?list-style: none/);
assert.match(css, /\.reanchor-candidate-option\[aria-pressed="true"\]/);
assert.match(css, /\.reanchor-candidate-preview\s*\{[\s\S]*?border-top: 1px solid var\(--border\)/);
assert.match(css, /\.reanchor-proposed-content\s*\{[\s\S]*?overflow: auto/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.reanchor-confirmation-body\s*\{\s*grid-template-columns: 1fr/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.reanchor-mode-panel \*/);

console.log("Human re-anchor foundation static tests passed.");
