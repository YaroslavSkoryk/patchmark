import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editorSource = readFileSync("components/document-editor.tsx", "utf8");
const previewSource = readFileSync("components/pdf-export-preview.tsx", "utf8");
const readonlyRendererSource = readFileSync(
  "components/mdx-readonly-preview-client.tsx",
  "utf8"
);
const cssSource = readFileSync("app/globals.css", "utf8");

assert.match(editorSource, /import \{ PdfExportPreview \}/);
assert.match(editorSource, /const \[pdfExportTarget, setPdfExportTarget\]/);
assert.match(
  editorSource,
  /onSelect=\{\(\) =>[\s\S]{0,80}setPdfExportTarget\(\{[\s\S]{0,300}Export PDF/
);
assert.match(editorSource, /documentId:\s*projectHandle\?\.document\?\.document_id/);
assert.match(editorSource, /fileName=\{pdfExportTarget\.fileName\}/);
assert.match(editorSource, /markdown=\{pdfExportTarget\.markdown\}/);

assert.match(previewSource, /createPortal/);
assert.match(previewSource, /window\.print\(\)/);
assert.match(previewSource, /patchmark-pdf-preview-open/);
assert.match(previewSource, /waitForPreviewAssets/);
assert.match(previewSource, /Print \/ Save PDF/);
assert.doesNotMatch(previewSource, /saveProjectDocument|writeProject|createProjectSnapshot/);

assert.match(readonlyRendererSource, /MDXEditor/);
assert.match(readonlyRendererSource, /readOnly/);
assert.match(readonlyRendererSource, /tablePlugin\(\)/);
assert.match(readonlyRendererSource, /linkPlugin\(\)/);
assert.doesNotMatch(readonlyRendererSource, /toolbarPlugin/);

assert.match(cssSource, /@page\s*\{\s*size: A4 portrait;/);
assert.match(cssSource, /@media print/);
assert.match(
  cssSource,
  /body\.patchmark-pdf-preview-open > :not\(\.pdf-export-portal-root\)/
);
assert.match(cssSource, /body\.patchmark-pdf-preview-open \.pdf-export-header/);
assert.match(cssSource, /body\.patchmark-pdf-preview-open \.patchmark-pdf-prose table/);

console.log("pdf-export-preview tests passed");
