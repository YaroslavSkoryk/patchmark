import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editor = readFileSync(
  new URL("../components/document-editor.tsx", import.meta.url),
  "utf8"
);
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const projectTypes = readFileSync(
  new URL("../lib/project/project-types.ts", import.meta.url),
  "utf8"
);
const patchReviewDialog = editor.slice(
  editor.indexOf("function PatchReviewDialog("),
  editor.indexOf("type PatchVisualPreview")
);
const largeWorkspaceComponents = [
  "../components/snapshot-dialog.tsx",
  "../components/pdf-export-preview.tsx",
  "../components/version-history-panel.tsx",
  "../components/legacy-project-assembly-dialog.tsx",
  "../components/guided-review/guided-review-wizard.tsx",
  "../components/rewrite-workspace/rewrite-workspace.tsx"
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const compactSurfaceComponents = [
  "../components/action-menu.tsx",
  "../components/comments-panel.tsx",
  "../components/selection-actions-chooser.tsx"
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

assert.match(
  projectTypes,
  /export type PatchmarkPatchStatus =\s*\| "pending"\s*\| "accepted"\s*\| "rejected"\s*\| "stale";/,
  "Phase 5 must preserve the actual persisted patch lifecycle"
);
assert.match(editor, /<ApplicationMenu label="Review">/);
assert.match(
  editor,
  /onSelect=\{handleReviewFirstPendingPatch\}[\s\S]{0,120}Review patch proposals/,
  "The existing Review menu must expose patch decisions"
);
assert.match(editor, /function derivePatchReviewQueueBatches/);
assert.match(editor, /reviewBatch\.import_id[\s\S]{0,180}group\.source_import_id/);
assert.match(editor, /function getPreferredPatchReviewSelection/);
assert.match(editor, /<ul>[\s\S]{0,900}aria-current=\{batch\.id === selectedBatchId/);
assert.match(editor, /<ol className="patch-review-patch-list">/);
assert.match(editor, /data-testid="patch-review-workspace"/);
assert.match(
  editor,
  /className="patch-review-workspace workspace-dialog-surface"/
);
assert.match(
  editor,
  /className="snapshot-dialog-backdrop workspace-dialog-backdrop patch-review-backdrop"/
);
assert.equal(
  (editor.match(/onClose=\{handleClosePatchReviewWorkspace\}/g) ?? []).length,
  1,
  "Only the Review workspace should receive the global close callback"
);
assert.doesNotMatch(patchReviewDialog, />\s*Close\s*<\/button>/);
assert.doesNotMatch(patchReviewDialog, /onClose/);
assert.match(editor, /aria-label="Selected patch inspector"/);
assert.match(editor, /patch-review-feedback/);
assert.match(editor, /Inactive rows show identity, status, dependencies, and discussion only/);
assert.doesNotMatch(editor, /function PatchGroupListDialog|function PatchGroupReviewDialog/);

for (const preservedOperation of [
  "handleAcceptPatch(selectedPatch)",
  "handleRejectPatch(selectedPatch)",
  "handleRejectPatchGroup(group)",
  "handleUpdatePatchAnchor(selectedPatch)",
  "handleFindPatchAnchorText(selectedPatch)",
  "handleContinuePatchDiscussion(selectedPatch)"
]) {
  assert.ok(editor.includes(preservedOperation), `Missing preserved callback: ${preservedOperation}`);
}

assert.match(
  editor,
  /getPatchDependencyBlockerMessage\(dependencyStatus\) \?\?[\s\S]{0,120}getPatchAcceptDisabledMessage/,
  "Dependency and target blockers must remain canonical"
);
assert.match(
  editor,
  /const confirmed = window\.confirm\(\s*"Apply this patch to the document\?[\s\S]{0,220}if \(!confirmed\) \{\s*return;/,
  "Application confirmation must remain intact"
);
assert.match(
  editor,
  /markdown\.slice\(originalStart, originalEnd\) !== currentPatch\.original_text/,
  "Application must revalidate the exact target immediately before mutation"
);
assert.match(editor, /createProjectSnapshot\(\{[\s\S]{0,140}allowDuplicate: true/);
assert.match(editor, /reason: `accept_patch:\$\{currentPatch\.id\}`/);
assert.match(
  editor,
  /const confirmed = window\.confirm\(\s*"Reject this patch proposal\?[\s\S]{0,180}if \(!confirmed\) \{\s*return;/,
  "Rejection confirmation must remain intact"
);
assert.doesNotMatch(editor, /Accept all|Apply all|Approve all|automatic approval/i);

assert.match(editor, /getContinuableLinkedComment\(\{ comments, patch \}\)/);
assert.match(editor, /setCommentReplyRequest/);
assert.match(editor, /patch\.status === "accepted" \? "Continue discussion" : "Discussion"/);
assert.doesNotMatch(editor, /new patch composer|patch discussion composer/i);

for (const accessibilityBehavior of [
  'aria-modal="true"',
  'role="dialog"',
  'event.key === "Escape"',
  'event.key !== "Tab"',
  'document.body.style.overflow = "hidden"',
  "aria-live=\"polite\"",
  'aria-describedby={patchDecisionExplanationId}'
]) {
  assert.ok(editor.includes(accessibilityBehavior), `Missing behavior: ${accessibilityBehavior}`);
}
assert.match(
  editor,
  /const modalRoot = dialog\?\.closest<HTMLElement>\("\.patch-review-backdrop"\);[\s\S]*?lockBodyScrollAndInertElements\(backgroundElements\)/
);

assert.match(css, /\.patch-review-workspace-layout\s*\{[\s\S]*?grid-template-columns: clamp\(280px, 24vw, 420px\) minmax\(0, 1fr\)/);
assert.match(
  css,
  /\.workspace-dialog-backdrop\s*\{[\s\S]*?--workspace-dialog-edge-inset: 16px;[\s\S]*?var\(--safe-area-left\)/
);
assert.match(
  css,
  /\.workspace-dialog-surface\s*\{[\s\S]*?width: 100%;[\s\S]*?height: calc\([\s\S]*?100dvh[\s\S]*?max-width: none;[\s\S]*?max-height: none;/
);
assert.match(css, /body:has\(\.workspace-dialog-backdrop\) \{\s*overflow: hidden !important;/);
for (const component of largeWorkspaceComponents) {
  assert.match(component, /workspace-dialog-backdrop/);
  assert.match(component, /workspace-dialog-surface/);
}
for (const component of compactSurfaceComponents) {
  assert.doesNotMatch(component, /workspace-dialog-(?:backdrop|surface)/);
}
assert.match(css, /\.patch-review-queue-row > button\[aria-current="true"\]/);
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.patch-review-preview-grid\s*\{\s*grid-template-columns: 1fr;/);
assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.patch-review-workspace-layout\s*\{\s*grid-template-rows: 64px minmax\(0, 1fr\);/);
assert.match(css, /\.patch-review-dialog-embedded \.patch-review-body\s*\{\s*display: contents;/);

console.log("Patch review foundation static tests passed.");
