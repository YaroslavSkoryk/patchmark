import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const globals = readFileSync(join(root, "app/globals.css"), "utf8");
const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
const actionMenu = readFileSync(
  join(root, "components/action-menu.tsx"),
  "utf8"
);
const documentEditor = readFileSync(
  join(root, "components/document-editor.tsx"),
  "utf8"
);
const commentsPanel = readFileSync(
  join(root, "components/comments-panel.tsx"),
  "utf8"
);

assert.match(layout, /viewportFit: "cover"/);
assert.match(layout, /width: "device-width"/);

for (const inset of ["top", "right", "bottom", "left"]) {
  assert.match(
    globals,
    new RegExp(`--safe-area-${inset}: env\\(safe-area-inset-${inset}, 0px\\)`)
  );
  assert.match(actionMenu, new RegExp(`--safe-area-${inset}`));
}

assert.match(globals, /\.app-shell \{[\s\S]*?min-height: 100dvh;/);
assert.match(
  globals,
  /\.application-menu-panel \{[\s\S]*?max-height: calc\(100dvh - 72px - var\(--safe-area-bottom\)\)/
);
assert.match(
  globals,
  /\.comment-composer-backdrop \{[\s\S]*?var\(--safe-area-bottom\)/
);
assert.match(
  globals,
  /\.workspace-dialog-backdrop \{[\s\S]*?var\(--safe-area-bottom\)/
);
assert.match(
  globals,
  /\.comments-rail \{[\s\S]*?bottom: max\(8px, var\(--safe-area-bottom\)\)/
);
assert.match(
  globals,
  /\.reanchor-workspace:focus-visible \{[\s\S]*?inset 0 0 0 3px var\(--control-focus-ring\)/
);

assert.match(
  documentEditor,
  /const navigation = documentNavigationRef\.current;[\s\S]*?lockBodyScrollAndInertElements\(backgroundElements\)/
);
assert.match(
  documentEditor,
  /const modalRoot = dialog\?\.closest<HTMLElement>\("\.patch-review-backdrop"\);[\s\S]*?lockBodyScrollAndInertElements\(backgroundElements\)/
);
assert.match(
  documentEditor,
  /function lockBodyScrollAndInertElements[\s\S]*?document\.body\.style\.overflow = "hidden";[\s\S]*?applicationBar\.inert = true;[\s\S]*?element\.inert = true;/
);
assert.match(
  documentEditor,
  /function trapTabWithin[\s\S]*?event\.key !== "Tab"[\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/
);
assert.equal(
  (documentEditor.match(/className="document-navigation-backdrop"[\s\S]{0,140}aria-hidden="true"/g) ?? []).length,
  1
);
assert.equal(
  (documentEditor.match(/className="comments-drawer-backdrop"[\s\S]{0,140}aria-hidden="true"/g) ?? []).length,
  1
);

assert.match(
  documentEditor,
  /function restoreFocusToCommentCard\(commentId: string\)[\s\S]*?attempt < 10[\s\S]*?commentsTriggerRef\.current\?\.focus/
);
assert.match(
  documentEditor,
  /bottom: "var\(--safe-area-bottom\)"[\s\S]*?left: "var\(--safe-area-left\)"[\s\S]*?right: "var\(--safe-area-right\)"/
);

assert.match(globals, /@media \(hover: hover\) and \(pointer: fine\)/);
assert.match(globals, /@media \(pointer: coarse\)/);
assert.match(globals, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(
  globals,
  /\.editor-body:has\(> \.markdown-source-editor\) \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/
);
assert.match(
  globals,
  /\.markdown-source-editor \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/
);
assert.match(globals, /--application-bar-block-size: 48px;/);
assert.match(globals, /--document-workspace-block-start: 8px;/);
assert.match(
  globals,
  /\.editor-panel:has\(\.markdown-source-editor\) \{[\s\S]*?min-height: calc\([\s\S]*?100dvh[\s\S]*?--application-bar-block-size[\s\S]*?--document-workspace-block-start[\s\S]*?--app-shell-block-end-space[\s\S]*?--safe-area-bottom[\s\S]*?\);/
);
assert.match(
  globals,
  /@media \(max-width: 900px\) \{[\s\S]*?--app-shell-block-end-space: 20px;/
);
assert.equal(
  (commentsPanel.match(/onActivateComment=\{\(commentId\) => \{[\s\S]{0,120}?onSetActiveCommentState\(\{ kind: "comment", commentId \}\);[\s\S]{0,30}?\}\}/g) ?? []).length,
  2
);
assert.doesNotMatch(
  commentsPanel,
  /onActivateComment=\{\(commentId\) => \{[\s\S]{0,180}?onFindComment/
);
assert.match(
  commentsPanel,
  /onSelect=\{\(\) => onFindComment\(comment\)\}[\s\S]{0,80}?Find in document/
);
assert.match(
  commentsPanel,
  /function restoreFocusToCollapsedCommentCard\(commentId: string\)[\s\S]*?card\.focus\(\{ preventScroll: true \}\)/
);

console.log("Responsive accessibility foundation tests passed.");
