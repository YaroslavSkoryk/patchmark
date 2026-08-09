import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const projectResumeBanner = readFileSync(
  new URL("../components/project-resume-banner.tsx", import.meta.url),
  "utf8"
);
const pdfExportPreview = readFileSync(
  new URL("../components/pdf-export-preview.tsx", import.meta.url),
  "utf8"
);
const rewriteWorkspace = readFileSync(
  new URL(
    "../components/rewrite-workspace/rewrite-workspace.tsx",
    import.meta.url
  ),
  "utf8"
);

for (const token of [
  "--control-hover-overlay",
  "--control-pressed-overlay",
  "--control-pressed-border",
  "--control-selected-border",
  "--control-focus-ring",
  "--control-focus-halo",
  "--control-disabled-opacity",
  "--control-loading-opacity"
]) {
  assert.match(css, new RegExp(`${token}:`), `Missing interaction token ${token}`);
}

assert.match(
  css,
  /@media \(hover: hover\) and \(pointer: fine\)/,
  "Hover feedback must be limited to true hover pointers"
);

const hoverMediaStart = css.indexOf(
  "@media (hover: hover) and (pointer: fine)"
);
const firstHoverSelector = css.indexOf(":hover");

assert.ok(hoverMediaStart >= 0, "Hover media query should exist");
assert.ok(
  firstHoverSelector > hoverMediaStart,
  "No hover selector should run before the hover-capable media query"
);
assert.equal(
  css.slice(0, hoverMediaStart).includes(":hover"),
  false,
  "Touch devices must not inherit component hover rules"
);

assert.match(
  css,
  /:not\(:disabled\):not\(\[aria-disabled="true"\]\):active\s*\{[\s\S]*?--control-pressed-overlay/,
  "Enabled controls need immediate active-state feedback"
);
assert.match(
  css,
  /\[aria-pressed="true"\][\s\S]*?\[aria-selected="true"\][\s\S]*?--control-selected-border/,
  "Persistent selected state must use ARIA semantics"
);
assert.match(
  css,
  /:focus-visible\s*\{[\s\S]*?outline: 2px solid var\(--control-focus-ring\)[\s\S]*?box-shadow: 0 0 0 1px var\(--control-focus-halo\)/,
  "Keyboard focus needs a non-color-only ring and halo"
);
assert.match(
  css,
  /:is\(:disabled, \[aria-disabled="true"\]\)[\s\S]*?--control-disabled-opacity/,
  "Disabled controls need shared non-actionable styling"
);
assert.match(
  css,
  /\[aria-busy="true"\][\s\S]*?cursor: progress[\s\S]*?--control-loading-opacity/,
  "Loading controls need shared busy styling"
);
assert.match(
  css,
  /@media \(pointer: coarse\)[\s\S]*?min-block-size: 40px/,
  "Touch controls need a reasonable minimum hit height"
);
assert.match(
  css,
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition: none !important/,
  "The interaction layer must respect reduced motion"
);

assert.doesNotMatch(
  css,
  /\[tabindex\]:not\(\[tabindex="-1"\]\)/,
  "Generic tabindex selectors would capture editor internals"
);

for (const [source, stateExpression] of [
  [projectResumeBanner, "aria-busy={busy}"],
  [pdfExportPreview, 'aria-busy={printState === "preparing"}'],
  [rewriteWorkspace, "aria-busy={isApplying}"]
]) {
  assert.ok(
    source.includes(stateExpression),
    `Expected precise loading semantics: ${stateExpression}`
  );
}

assert.match(
  projectResumeBanner,
  /aria-busy=\{busy\}[\s\S]*?disabled=\{busy\}/,
  "Opening a project must block duplicate activation while busy"
);
assert.match(
  pdfExportPreview,
  /aria-busy=\{printState === "preparing"\}[\s\S]*?disabled=\{printState === "preparing" \|\| Boolean\(renderError\)\}/,
  "Preparing a PDF must block duplicate activation"
);
assert.match(
  rewriteWorkspace,
  /aria-busy=\{isApplying\}[\s\S]*?disabled=\{isApplying\}/,
  "Applying a rewrite must block duplicate activation"
);

console.log("Control interaction foundation tests passed.");
