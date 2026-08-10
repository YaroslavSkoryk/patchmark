import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const applicationBar = readFileSync(
  new URL("../components/application-bar.tsx", import.meta.url),
  "utf8"
);
const documentEditor = readFileSync(
  new URL("../components/document-editor.tsx", import.meta.url),
  "utf8"
);
const documentActions = readFileSync(
  new URL("../components/document-actions.tsx", import.meta.url),
  "utf8"
);
const markdownFileLoader = readFileSync(
  new URL("../components/markdown-file-loader.tsx", import.meta.url),
  "utf8"
);
const projectNavigator = readFileSync(
  new URL("../components/project-document-navigator.tsx", import.meta.url),
  "utf8"
);
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

assert.doesNotMatch(page, /Markdown-first document editor/);
assert.doesNotMatch(page, /app-header/);

for (const semantic of [
  'aria-controls={menuId}',
  'aria-expanded={open}',
  'aria-haspopup="menu"',
  'role="menu"',
  'role="menuitem"',
  'event.key === "Escape"',
  'document.addEventListener("pointerdown", handleOutsidePointer)',
  'triggerRef.current?.focus()'
]) {
  assert.ok(applicationBar.includes(semantic), `Missing menu behavior: ${semantic}`);
}

for (const [label, handler] of [
  ["Open Project Folder", "handleOpenProjectFolder"],
  [
    "Create Project From Existing Patchmark Projects",
    "handleOpenLegacyProjectAssembly"
  ],
  [
    "Create Project From Current Document",
    "handleCreateProjectFromCurrentDocument"
  ],
  ["Save As", "handleSaveAs"],
  ["Generate ChatGPT Prompt", "handleGenerateChatGptPrompt"],
  ["Import ChatGPT Response", "handleOpenChatGptImportDialog"],
  ["Guided Review", "handleOpenGuidedReview"]
]) {
  assert.match(
    documentEditor,
    new RegExp(`onSelect=\\{${handler}\\}[\\s\\S]{0,180}${label}`),
    `${label} must keep its original handler`
  );
}

assert.match(
  documentEditor,
  /downloadMarkdown\(fileName, markdown\);[\s\S]{0,80}handleDownload\(\);[\s\S]{0,180}Download \.md/,
  "Download must keep the original download and feedback behavior"
);
assert.match(
  documentEditor,
  /setPdfExportTarget\(\{[\s\S]{0,300}Export PDF/,
  "PDF export must keep the original preview state"
);
assert.match(documentEditor, /<ApplicationMenu label="File">/);
assert.match(documentEditor, /<ApplicationMenu label="Review">/);
assert.doesNotMatch(documentEditor, /className="project-actions"/);
assert.match(documentEditor, /<MarkdownFileLoader[\s\S]{0,100}menuItem/);

for (const label of ["Save Changes", "Create Snapshot", "Copy Markdown"]) {
  assert.ok(documentActions.includes(label), `${label} must remain document-local`);
}

for (const label of ["Save As", "Download .md", "Export PDF"]) {
  assert.equal(
    documentActions.includes(label),
    false,
    `${label} should not remain duplicated in the document action row`
  );
  assert.ok(documentEditor.includes(label), `${label} must remain in the File menu`);
}

assert.match(markdownFileLoader, /role=\{menuItem \? "menuitem" : undefined\}/);
assert.match(
  markdownFileLoader,
  /accept="\.md,\.markdown,text\/markdown,text\/x-markdown,text\/plain"/
);
assert.match(projectNavigator, />New document<\/summary>/);
assert.match(projectNavigator, /Add existing document/);

assert.match(
  css,
  /\.application-bar\s*\{[\s\S]*?height: 56px;[\s\S]*?border-bottom: 1px solid var\(--border\)/
);
assert.match(css, /\.application-identity\s*\{[\s\S]*?font-size: 1\.1875rem/);
assert.match(css, /\.document-workspace\s*\{[\s\S]*?margin: 16px auto 0/);
assert.match(css, /\.application-menu-panel\s*\{[\s\S]*?z-index: 80/);
assert.match(
  css,
  /@media \(max-width: 520px\)[\s\S]*?\.application-menu-panel[\s\S]*?right: 20px;[\s\S]*?left: 20px;/
);

console.log("Application shell tests passed.");
