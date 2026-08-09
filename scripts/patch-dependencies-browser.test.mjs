import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CdpClient,
  assertEditorIsReachable,
  clickButtonByText,
  createPage,
  createProjectPickerShim,
  evaluate,
  findChromeExecutable,
  inventoryProject,
  startFixtureFileServer,
  waitForDevToolsUrl,
  waitForEditorShell,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl =
  process.env.PATCHMARK_EDITOR_URL ?? "http://127.0.0.1:3120/";
const fixtureRoot = mkdtempSync(
  join(tmpdir(), "patchmark-dependency-browser-")
);
const projectDir = join(fixtureRoot, "Dependency Review Fixture");
createDependencyFixture(projectDir);
const inventory = inventoryProject(projectDir);
const fixtureServer = await startFixtureFileServer(projectDir, inventory);
const chromePath =
  process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

if (!chromePath) {
  throw new Error("Chrome was not found for patch dependency browser tests.");
}

await assertEditorIsReachable(editorUrl);

const userDataDir = mkdtempSync(
  join(tmpdir(), "patchmark-dependency-browser-chrome-")
);
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

let client;

try {
  const browserWsUrl = await waitForDevToolsUrl(chrome);
  const pageWsUrl = await createPage(browserWsUrl, "about:blank");
  client = await CdpClient.connect(pageWsUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: createProjectPickerShim({
      baseUrl: fixtureServer.baseUrl,
      directories: inventory.directories,
      files: inventory.files,
      projectName: "Dependency Review Fixture"
    })
  });
  await client.call("Page.navigate", { url: editorUrl });
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelectorAll(".comment-floating-item article[aria-label]").length === 1`,
    "dependency fixture comment"
  );
  await evaluate(client, {
    expression: `(() => {
      const article = document.querySelector(".comment-floating-item article[aria-label]");
      if (!article) throw new Error("Comment card not found.");
      article.click();
      return true;
    })()`,
    userGesture: true
  });
  await waitFor(
    client,
    `Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Review related patches")`,
    "related patches action"
  );

  await clickButtonByText(client, "Review related patches");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Review Patch Group"]'))`,
    "patch group"
  );
  await openGroupPatch(client, "Update dependent line");
  await waitForPatchDialog(client, "Update dependent line");

  const blockedState = await readPatchDialogState(client);
  assert.equal(blockedState.acceptDisabled, true);
  assert.match(blockedState.dependencyText, /Requires 1 patch/);
  assert.match(blockedState.dependencyText, /Base prerequisite change/);
  assert.match(blockedState.dependencyText, /1 awaiting review/);
  assert.equal(blockedState.reviewDependencyButton, true);

  await clickButtonByText(client, "Review required patch");
  await waitForPatchDialog(client, "Base prerequisite change");
  const prerequisiteState = await readPatchDialogState(client);
  assert.equal(prerequisiteState.acceptDisabled, false);
  assert.equal(prerequisiteState.hasDependencySummary, false);

  await evaluate(client, {
    expression: `window.confirm = () => true; true`,
    userGesture: true
  });
  await clickButtonByText(client, "Accept Patch");
  await waitFor(
    client,
    `(() => {
      const raw = window.__patchmarkFixtureWrites?.get(".patchmark/patches.json");
      if (!raw) return false;
      const patches = JSON.parse(raw);
      return patches[0]?.status === "accepted" && patches[1]?.status === "pending";
    })()`,
    "prerequisite persistence"
  );

  await clickButtonByText(client, "Back to group");
  await waitFor(
    client,
    `Boolean(document.querySelector('[aria-label="Review Patch Group"]'))`,
    "patch group after prerequisite"
  );
  await openGroupPatch(client, "Update dependent line");
  await waitForPatchDialog(client, "Update dependent line");

  const unlockedState = await readPatchDialogState(client);
  assert.equal(unlockedState.acceptDisabled, false);
  assert.match(unlockedState.dependencyText, /1 accepted/);
  assert.match(unlockedState.dependencyText, /✓ Base prerequisite change/);
  assert.equal(unlockedState.documentHasDependentReplacement, false);
  assert.equal(unlockedState.dependentStatus, "pending");

  await clickButtonByText(client, "Accept Patch");
  await waitFor(
    client,
    `(() => {
      const raw = window.__patchmarkFixtureWrites?.get(".patchmark/patches.json");
      const markdown = window.__patchmarkFixtureWrites?.get("document.md") ?? "";
      if (!raw) return false;
      const patches = JSON.parse(raw);
      return patches[1]?.status === "accepted" &&
        markdown.includes("Dependent line accepted.") &&
        markdown.includes("## Appendix\\n\\nDependent line.");
    })()`,
    "dependent provenance acceptance"
  );
  const acceptedState = await readPatchDialogState(client);
  assert.equal(acceptedState.documentHasDependentReplacement, true);
  assert.equal(acceptedState.appendixCopyPreserved, true);

  await client.call("Page.reload");
  await waitForEditorShell(client);
  await clickButtonByText(client, "Open Project Folder");
  await waitFor(
    client,
    `document.querySelectorAll(".comment-floating-item article[aria-label]").length === 1`,
    "reopened dependency project"
  );
  const restartedMarkdown = readFileSync(join(projectDir, "document.md"), "utf8");
  const restartedPatches = JSON.parse(
    readFileSync(join(projectDir, ".patchmark", "patches.json"), "utf8")
  );
  assert.ok(restartedMarkdown.includes("Dependent line accepted."));
  assert.ok(restartedMarkdown.includes("## Appendix\n\nDependent line."));
  assert.ok(restartedPatches.every((patch) => patch.status === "accepted"));

  console.log(
    JSON.stringify(
      {
        acceptUnlockedAfterPrerequisite: true,
        appendixCopyPreserved: true,
        dependentAcceptedAtMappedOriginal: true,
        dependentAppliedAutomatically: false,
        dependencyNavigation: true,
        pendingDependencyBlocked: true,
        restartPersistence: true
      },
      null,
      2
    )
  );
} finally {
  await client?.close().catch(() => {});
  chrome.kill("SIGTERM");
  await waitForProcessExit(chrome, 2_000);
  await fixtureServer.close();
  rmSync(userDataDir, { force: true, recursive: true });
  rmSync(fixtureRoot, { force: true, recursive: true });
}

async function openGroupPatch(client, title) {
  await evaluate(client, {
    expression: `(() => {
      const card = Array.from(document.querySelectorAll(".patch-group-patch-card"))
        .find((element) => element.textContent?.includes(${JSON.stringify(title)}));
      const button = card?.querySelector("button:not([disabled])");
      if (!button) throw new Error("Patch card not found: ${title}");
      button.click();
      return true;
    })()`,
    userGesture: true
  });
}

async function waitForPatchDialog(client, title) {
  await waitFor(
    client,
    `document.querySelector('[aria-label="Review Patch Proposal"] h2')?.textContent?.trim() === ${JSON.stringify(title)}`,
    `patch dialog ${title}`
  );
}

async function readPatchDialogState(client) {
  return evaluate(client, {
    expression: `(() => {
      const dialog = document.querySelector('[aria-label="Review Patch Proposal"]');
      const accept = Array.from(dialog?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent?.trim() === "Accept Patch");
      const dependency = dialog?.querySelector(".patch-dependency-summary");
      const raw = window.__patchmarkFixtureWrites?.get(".patchmark/patches.json");
      const patches = raw ? JSON.parse(raw) : [];
      const documentWrite = window.__patchmarkFixtureWrites?.get("document.md") ?? "";
      return {
        acceptDisabled: Boolean(accept?.disabled),
        dependencyText: dependency?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        dependentStatus: patches[1]?.status ?? "pending",
        documentHasDependentReplacement:
          documentWrite.includes("Dependent line accepted."),
        appendixCopyPreserved:
          documentWrite.includes("## Appendix\\n\\nDependent line."),
        hasDependencySummary: Boolean(dependency),
        reviewDependencyButton: Array.from(dependency?.querySelectorAll("button") ?? [])
          .some((button) => button.textContent?.trim() === "Review required patch")
      };
    })()`
  });
}

async function waitFor(client, expression, label) {
  let latestValue;

  for (let attempt = 0; attempt < 240; attempt += 1) {
    latestValue = await evaluate(client, { expression });
    if (latestValue) {
      return;
    }
    await delay(50);
  }

  throw new Error(
    `Timed out waiting for ${label}. Latest value: ${JSON.stringify(latestValue)}`
  );
}

function createDependencyFixture(root) {
  const metadata = join(root, ".patchmark");
  mkdirSync(join(metadata, "versions"), { recursive: true });
  mkdirSync(join(metadata, "context-packs"), { recursive: true });
  mkdirSync(join(metadata, "imports"), { recursive: true });
  mkdirSync(join(metadata, "recovery"), { recursive: true });
  const now = "2026-07-24T00:00:00.000Z";
  const markdown = `# Dependency Review

## Changes

Dependent line.

## Summary

Base line.
`;
  const selectedText = "Base line.";
  const selectedStart = markdown.indexOf(selectedText);
  const comment = {
    id: "PM-COMMENT-0019",
    type: "note",
    status: "open",
    anchor: {
      kind: "selected_text",
      selected_text: selectedText,
      markdown_start_offset: selectedStart,
      markdown_end_offset: selectedStart + selectedText.length,
      context_before: markdown.slice(0, selectedStart),
      context_after: markdown.slice(selectedStart + selectedText.length),
      anchor_source: "markdown"
    },
    comment: "Review these coordinated changes.",
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: now,
    updated_at: now
  };
  const commonPatch = {
    status: "pending",
    patch_group_id: "PM-PATCH-GROUP-0001",
    patch_group_total: 2,
    comment_id: comment.id,
    source_import_id: "PM-IMPORT-DEPENDENCY",
    target_heading: "## Changes",
    suggested_text_sources: [],
    reason_sources: [],
    risk_sources: [],
    created_at: now
  };
  const documentId = "doc_dependency_fixture";
  const baseDocumentSha256 = createHash("sha256").update(markdown).digest("hex");
  const createProvenance = (patchKey, originalText, targetHeading) => {
    const start = markdown.indexOf(originalText);
    return {
      schema_version: 1,
      document_id: documentId,
      patch_key: patchKey,
      base_document_sha256: baseDocumentSha256,
      base_start: start,
      base_end: start + originalText.length,
      current_start: start,
      current_end: start + originalText.length,
      original_text_fingerprint: createTextFingerprint(originalText),
      target_heading: targetHeading,
      heading_ancestry:
        targetHeading === "## Summary"
          ? ["# Dependency Review", "## Summary"]
          : ["# Dependency Review", "## Changes"],
      base_occurrence_count: 1,
      resolution_method: "heading_scoped_full_text",
      mapping_state: "mapped"
    };
  };
  const patches = [
    {
      ...commonPatch,
      id: "PM-PATCH-0001",
      patch_group_index: 1,
      source_patch_key: "base-prerequisite",
      depends_on_patch_ids: [],
      depends_on_patch_keys_snapshot: [],
      display_title: "Base prerequisite change",
      target_heading: "## Summary",
      original_text: "Base line.",
      suggested_text: "Base line accepted.\n\n## Appendix\n\nDependent line.",
      target_provenance: createProvenance(
        "base-prerequisite",
        "Base line.",
        "## Summary"
      ),
      reason: "Creates the prerequisite document state."
    },
    {
      ...commonPatch,
      id: "PM-PATCH-0002",
      patch_group_index: 2,
      source_patch_key: "dependent-change",
      depends_on_patch_ids: ["PM-PATCH-0001"],
      depends_on_patch_keys_snapshot: ["base-prerequisite"],
      display_title: "Update dependent line",
      target_heading: "## Changes",
      original_text: "Dependent line.",
      suggested_text: "Dependent line accepted.",
      target_provenance: createProvenance(
        "dependent-change",
        "Dependent line.",
        "## Changes"
      ),
      reason: "Applies only after the base change."
    }
  ];

  writeFileSync(join(root, "document.md"), markdown);
  writeFileSync(
    join(metadata, "manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        project_id: "prj_dependency_fixture",
        document_id: documentId,
        project_name: "Dependency Review Fixture",
        document_file: "document.md",
        created_at: now,
        updated_at: now
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(metadata, "comments.json"),
    `${JSON.stringify([comment], null, 2)}\n`
  );
  writeFileSync(
    join(metadata, "patches.json"),
    `${JSON.stringify(patches, null, 2)}\n`
  );
  writeFileSync(join(metadata, "tasks.json"), "[]\n");
}

function createTextFingerprint(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
