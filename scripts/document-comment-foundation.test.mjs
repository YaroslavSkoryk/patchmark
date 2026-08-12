import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const commentsPanel = readFileSync("components/comments-panel.tsx", "utf8");
const documentEditor = readFileSync("components/document-editor.tsx", "utf8");
const documentTools = readFileSync("components/document-tools.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

assert.match(documentEditor, /const \[commentsOpen, setCommentsOpen\] = useState\(false\)/);
assert.match(documentEditor, /aria-controls="document-comments-panel"/);
assert.match(documentEditor, /aria-expanded=\{commentsOpen\}/);
assert.match(documentEditor, /aria-label=\{`Open comments\./);
assert.match(documentEditor, /hidden=\{!commentsOpen\}/);
assert.match(documentEditor, /role=\{isNarrowNavigation && commentsOpen \? "dialog"/);
assert.match(documentEditor, /aria-modal=\{isNarrowNavigation && commentsOpen/);
assert.match(documentEditor, /restoreCommentsTriggerFocusRef\.current/);
assert.match(documentEditor, /commentsTriggerRef\.current\?\.focus\(\)/);
assert.match(documentEditor, /event\.key === "Escape"[\s\S]*?closeComments\(\)/);
assert.match(documentEditor, /applicationBar\.inert = true/);
assert.match(
  documentEditor,
  /const rail = commentsRailRef\.current;[\s\S]*?lockBodyScrollAndInertElements\(backgroundElements\)/
);
assert.match(documentEditor, /setMobileNavigationOpen\(false\)[\s\S]*?setCommentsOpen\(true\)/);
assert.doesNotMatch(documentEditor, /localStorage[\s\S]{0,120}commentsOpen/);

assert.match(documentEditor, /<DocumentTools/);
assert.doesNotMatch(documentEditor, /<DocumentOutline/);
assert.doesNotMatch(documentEditor, /<VersionHistoryPanel/);
assert.match(documentTools, /<details className="document-tools">/);
assert.match(documentTools, /role="tablist"/);
assert.match(documentTools, /aria-selected=\{activeTool === "outline"\}/);
assert.match(documentTools, /aria-selected=\{activeTool === "history"\}/);
assert.match(documentTools, /onCompareVersion=\{onCompareVersion\}/);
assert.match(documentTools, /onViewVersion=\{onViewVersion\}/);

assert.match(commentsPanel, /<h2>Comments<\/h2>/);
assert.match(commentsPanel, /\{comments\.length\} total · \{openCommentCount\} open/);
assert.match(commentsPanel, /<details className="comment-list-tools">/);
assert.match(
  commentsPanel,
  /useSpatialCommentLayout[\s\S]*?\? commentPositions[\s\S]*?: EMPTY_COMMENT_POSITIONS/
);
assert.match(
  commentsPanel,
  /data-comment-layout=\{useSpatialCommentLayout \? "spatial" : "compact"\}/
);
assert.match(documentEditor, /data-editor-mode=\{mode\}/);
assert.match(documentEditor, /spatialLayout=\{mode === "visual"\}/);
assert.match(
  documentEditor,
  /function measureCommentPositions[\s\S]*?if \(mode !== "visual" \|\|/
);
assert.match(commentsPanel, /className="comment-compact-heading"/);
assert.match(commentsPanel, /className="comment-card-active"|"comment-card-active"/);
assert.match(commentsPanel, /<ActionMenu[\s\S]*?More actions for comment/);
assert.match(commentsPanel, /Find in document/);
assert.match(commentsPanel, /Mark for ChatGPT/);
assert.match(commentsPanel, /Change anchor/);
assert.match(commentsPanel, /Edit comment/);
assert.match(commentsPanel, /comment-action-menu-item-destructive/);
assert.match(commentsPanel, />\s*Move to Trash\s*<\/ActionMenuItem>/);
assert.match(commentsPanel, /Review patch\{pendingPatchCount/);
assert.match(commentsPanel, /Re-anchor/);
assert.doesNotMatch(
  commentsPanel,
  /onActivateComment=\{\(commentId\) => \{[\s\S]{0,180}?onFindComment/
);
assert.match(
  commentsPanel,
  /onSelect=\{\(\) => onFindComment\(comment\)\}[\s\S]{0,80}?Find in document/
);
assert.match(commentsPanel, /restoreFocusToCollapsedCommentCard/);

assert.match(documentEditor, /document-context-status document-context-status-/);
assert.match(documentEditor, /saveFeedback\.kind === "error"[\s\S]*?document-save-banner-error/);
assert.match(css, /\.document-workspace\[data-comments-open="true"\][\s\S]*?336px/);
assert.match(css, /\.patchmark-prose\s*\{[\s\S]*?max-width: 920px/);
assert.match(css, /\.comment-card-compact\s*\{[\s\S]*?border-bottom:/);
assert.match(css, /\.comment-card-active\s*\{[\s\S]*?border: 1px solid/);
assert.match(
  css,
  /@media \(min-width: 901px\)[\s\S]*?\.comments-rail\[data-editor-mode="markdown"\][\s\S]*?max-height: calc\([\s\S]*?overflow-y: auto;/
);
assert.match(css, /\.comment-action-menu-panel\s*\{[\s\S]*?position: fixed/);
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.comments-rail\s*\{[\s\S]*?position: fixed/);
assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.comments-rail\s*\{[\s\S]*?max-height: 76dvh/);
assert.match(css, /\.application-bar\s*\{[\s\S]*?height: 56px/);

console.log("Document/comment foundation tests passed.");
