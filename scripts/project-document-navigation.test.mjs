import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const actionMenu = readFileSync("components/action-menu.tsx", "utf8");
const applicationBar = readFileSync("components/application-bar.tsx", "utf8");
const documentEditor = readFileSync("components/document-editor.tsx", "utf8");
const navigator = readFileSync(
  "components/project-document-navigator.tsx",
  "utf8"
);
const css = readFileSync("app/globals.css", "utf8");

assert.match(applicationBar, /<ActionMenu/);
assert.match(actionMenu, /createPortal/);
assert.match(actionMenu, /aria-haspopup="menu"/);
assert.match(actionMenu, /aria-expanded=\{open\}/);
assert.match(actionMenu, /event\.key === "Escape"/);
assert.match(actionMenu, /document\.addEventListener\("pointerdown"/);
assert.match(actionMenu, /triggerRef\.current\?\.focus\(\)/);

assert.match(navigator, /aria-current=\{isActive \? "page" : undefined\}/);
assert.match(navigator, /aria-expanded=\{projectExpanded\}/);
assert.doesNotMatch(navigator, /role="tree"/);
assert.match(navigator, /Actions for \$\{document\.display_title\}/);
assert.match(navigator, /Move up/);
assert.match(navigator, /Move down/);
assert.match(navigator, /Rename/);
assert.match(navigator, /Change role/);
assert.match(navigator, /Move to group/);
assert.match(navigator, /Archive/);
assert.match(navigator, /project-navigation-menu-item-destructive/);
assert.match(navigator, />Add document<\/summary>/);
assert.match(navigator, />Create new document<\/summary>/);
assert.equal((navigator.match(/>Add document<\/summary>/g) ?? []).length, 1);
assert.match(navigator, /Add existing document/);
assert.match(navigator, /writeGroupCollapseState/);
assert.match(navigator, /patchmark:document-group-collapsed:/);
assert.match(navigator, /maxLength=\{240\}/);
assert.match(navigator, /event\.key === "Escape"/);

assert.match(documentEditor, /className="application-navigation-trigger"/);
assert.match(documentEditor, /className="document-navigation-backdrop"/);
assert.match(documentEditor, /aria-modal=\{isNarrowNavigation/);
assert.match(documentEditor, /role=\{isNarrowNavigation/);
assert.match(documentEditor, /document\.body\.style\.overflow = "hidden"/);
assert.match(documentEditor, /event\.key !== "Tab"/);
assert.match(documentEditor, /setMobileNavigationOpen\(false\);[\s\S]{0,120}handleSelectProjectDocument/);
assert.match(documentEditor, /<ApplicationMenu label="File">/);
assert.match(documentEditor, /<ApplicationMenu label="Review">/);

assert.match(css, /grid-template-columns: 272px minmax\(0, 1fr\)/);
assert.match(css, /\.document-workspace\[data-comments-open="true"\][\s\S]*?336px/);
assert.match(css, /\.document-workspace\[data-navigation-collapsed="true"\]/);
assert.match(css, /\.project-document-item\s*\{[\s\S]*?border: 0;[\s\S]*?border-left: 3px solid transparent/);
assert.match(css, /\.project-document-item\[data-active="true"\][\s\S]*?border-left-color: var\(--accent\)/);
assert.match(css, /\.project-navigation-menu-panel\s*\{[\s\S]*?position: fixed;[\s\S]*?z-index: 100/);
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.document-sidebar\s*\{[\s\S]*?position: fixed;[\s\S]*?top: calc\(56px \+ var\(--safe-area-top\)\)/);
assert.match(css, /\.application-bar\s*\{[\s\S]*?height: 56px/);

console.log("Project/document navigation foundation tests passed.");
