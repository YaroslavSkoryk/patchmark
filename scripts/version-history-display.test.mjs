import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getPatchDisplayTitle,
  getPatchDisplayTitleInfo,
  getPatchGroupDisplayTitle
} from "../lib/patches/patch-display-title.ts";
import { parsePatchmarkCommentReplyImport } from "../lib/imports/patchmark-comment-reply-import.ts";
import {
  createVersionHistoryEntries,
  formatVersionTargetHeading,
  getSidebarVersionHistoryEntries,
  isWeakVersionTitle
} from "../lib/project/version-history-display.ts";

function version(index, overrides = {}) {
  const padded = String(index).padStart(4, "0");

  return {
    id: overrides.id ?? `snapshot-20260712-${padded}`,
    file:
      overrides.file ??
      `.patchmark/versions/snapshot-20260712-${padded}.md`,
    created_at:
      overrides.created_at ??
      new Date(Date.UTC(2026, 6, 12, 10, index)).toISOString(),
    reason: overrides.reason ?? "manual snapshot",
    content_hash: overrides.content_hash
  };
}

function patch(index, overrides = {}) {
  const id = overrides.id ?? `PM-PATCH-${String(index).padStart(4, "0")}`;

  return {
    id,
    status: overrides.status ?? "pending",
    comment_id: overrides.comment_id,
    display_title: overrides.display_title,
    patch_group_id: overrides.patch_group_id,
    patch_group_index: overrides.patch_group_index,
    patch_group_total: overrides.patch_group_total,
    source_import_id: overrides.source_import_id,
    target_heading: overrides.target_heading,
    original_text: overrides.original_text ?? "Original text",
    suggested_text: overrides.suggested_text ?? "Suggested text",
    reason: overrides.reason ?? "Improve the selected text.",
    created_at:
      overrides.created_at ?? new Date(Date.UTC(2026, 6, 12, 9, index)).toISOString(),
    pre_apply_snapshot_id: overrides.pre_apply_snapshot_id,
    pre_apply_snapshot_file: overrides.pre_apply_snapshot_file
  };
}

function comment(id, text) {
  return {
    id,
    type: "question",
    status: "open",
    anchor: { kind: "document" },
    comment: text,
    thread: [],
    export_state: { focus_state: "idle" },
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z"
  };
}

{
  const versions = Array.from({ length: 10 }, (_, index) => {
    const item = version(index + 1, {
      reason: `before accepting patch PM-PATCH-${String(index + 1).padStart(4, "0")}`
    });

    return item;
  });
  const patches = versions.map((snapshot, index) =>
    patch(index + 1, {
      display_title: `Add market signal ${index + 1}`,
      pre_apply_snapshot_id: snapshot.id,
      pre_apply_snapshot_file: snapshot.file
    })
  );
  const entries = createVersionHistoryEntries({
    comments: [],
    patches,
    versions
  });
  const sidebarEntries = getSidebarVersionHistoryEntries(entries);

  assert.equal(entries.length, 10);
  assert.equal(sidebarEntries.length, 3);
  assert.deepEqual(
    sidebarEntries.map((entry) => entry.version.id),
    [
      "snapshot-20260712-0010",
      "snapshot-20260712-0009",
      "snapshot-20260712-0008"
    ]
  );
  assert.equal(sidebarEntries[0].title, "Before applying: Add market signal 10");
}

{
  const versions = [version(1), version(2)];
  const entries = createVersionHistoryEntries({
    comments: [],
    patches: [],
    versions
  });
  const sidebarEntries = getSidebarVersionHistoryEntries(entries);

  assert.equal(entries.length, 2);
  assert.equal(sidebarEntries.length, 2);
  assert.deepEqual(
    sidebarEntries.map((entry) => entry.title),
    ["Manual snapshot", "Manual snapshot"]
  );
}

{
  const versions = [version(1), version(2), version(3), version(4)];
  const entries = createVersionHistoryEntries({
    comments: [],
    patches: [],
    versions
  });

  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((entry) => entry.version.id),
    [
      "snapshot-20260712-0004",
      "snapshot-20260712-0003",
      "snapshot-20260712-0002",
      "snapshot-20260712-0001"
    ]
  );
}

{
  const titledPatch = patch(22, {
    display_title: "Add market signals for sourdough",
    target_heading: "Market View"
  });
  const titleInfo = getPatchDisplayTitleInfo(titledPatch);

  assert.equal(titleInfo.title, "Add market signals for sourdough");
  assert.equal(titleInfo.source, "display_title");
  assert.equal(titleInfo.isTechnicalFallback, false);
}

{
  const legacyPatch = patch(23, {
    target_heading: "5.1 Early Pricing Reference Points"
  });
  const firstTitle = getPatchDisplayTitle(legacyPatch);
  const secondTitle = getPatchDisplayTitle(legacyPatch);

  assert.equal(firstTitle, "Update 5.1 Early Pricing Reference Points");
  assert.equal(secondTitle, firstTitle);
  assert.notEqual(firstTitle, "Patch PM-PATCH-0023");
  assert.equal(legacyPatch.id, "PM-PATCH-0023");
}

{
  const groupComment = comment(
    "PM-COMMENT-0008",
    "Can you move references inline across the document?"
  );
  const groupPatches = [1, 2, 3].map((index) =>
    patch(index, {
      comment_id: groupComment.id,
      patch_group_id: "PM-PATCH-GROUP-0001",
      patch_group_index: index,
      patch_group_total: 3,
      reason: "Use inline citations for this section."
    })
  );

  assert.equal(
    getPatchGroupDisplayTitle(groupPatches, groupComment),
    "Move references inline across the document"
  );
  assert.equal(
    getPatchDisplayTitle(groupPatches[1], {
      comment: groupComment,
      includeGroupPosition: true
    }),
    "Move references inline across the document · Patch 2 of 3"
  );
}

{
  const manualEntry = createVersionHistoryEntries({
    comments: [],
    patches: [],
    versions: [version(1, { reason: "manual snapshot" })]
  })[0];
  const orphanEntry = createVersionHistoryEntries({
    comments: [],
    patches: [],
    versions: [
      version(2, {
        reason: "before accepting patch PM-PATCH-9999"
      })
    ]
  })[0];

  assert.equal(manualEntry.title, "Manual snapshot");
  assert.equal(manualEntry.relatedPatchId, undefined);
  assert.equal(orphanEntry.title, "Pre-apply safety snapshot");
}

{
  const storedHeading = "### 5.1 Early Pricing Reference Points";

  assert.equal(
    formatVersionTargetHeading(storedHeading),
    "5.1 Early Pricing Reference Points"
  );
  assert.equal(formatVersionTargetHeading("Price # reference"), "Price # reference");
  assert.equal(storedHeading, "### 5.1 Early Pricing Reference Points");
}

{
  assert.equal(isWeakVersionTitle("What does it mean?"), true);
  assert.equal(isWeakVersionTitle("What is the reasoning behind this thesis"), true);
  assert.equal(isWeakVersionTitle("Can we find more information"), true);
  assert.equal(isWeakVersionTitle("Please review"), true);
  assert.equal(isWeakVersionTitle("Add artisan bakery price references"), false);
  assert.equal(isWeakVersionTitle("What Customers Need"), false);
}

{
  const weakPatch = patch(24, {
    display_title: "What does it mean?",
    original_text: "Current text",
    pre_apply_snapshot_id: "snapshot-20260712-0024",
    reason: "What is this?",
    suggested_text: "Updated text",
    target_heading: "## 4. Target Customer Segments"
  });
  const weakEntry = createVersionHistoryEntries({
    comments: [comment("PM-COMMENT-0024", "What does it mean?")],
    patches: [weakPatch],
    versions: [
      version(24, {
        id: "snapshot-20260712-0024",
        reason: "before accepting patch PM-PATCH-0024"
      })
    ]
  })[0];

  assert.equal(
    weakEntry.title,
    "Before applying: Update 4. Target Customer Segments"
  );
  assert.equal(weakEntry.targetHeading, "4. Target Customer Segments");
  assert.equal(weakEntry.relatedPatchId, "PM-PATCH-0024");
  assert.equal(weakPatch.display_title, "What does it mean?");
  assert.equal(weakPatch.target_heading, "## 4. Target Customer Segments");
}

{
  const strongPatch = patch(25, {
    display_title: "Add artisan bakery price references",
    original_text: "",
    pre_apply_snapshot_id: "snapshot-20260712-0025",
    reason: "What does it mean?",
    suggested_text: "New pricing references",
    target_heading: "### 5.1 Early Pricing Reference Points"
  });
  const strongEntry = createVersionHistoryEntries({
    comments: [],
    patches: [strongPatch],
    versions: [
      version(25, {
        id: "snapshot-20260712-0025",
        reason: "before applying patch PM-PATCH-0025"
      })
    ]
  })[0];

  assert.equal(
    strongEntry.title,
    "Before applying: Add artisan bakery price references"
  );
}

{
  const addPatch = patch(26, {
    display_title: "Change this",
    original_text: "",
    pre_apply_snapshot_id: "snapshot-20260712-0026",
    reason: "Please review",
    suggested_text: "New content",
    target_heading: "## Source Notes"
  });
  const removePatch = patch(27, {
    display_title: "Update",
    original_text: "Old content",
    pre_apply_snapshot_id: "snapshot-20260712-0027",
    reason: "Please review",
    suggested_text: "",
    target_heading: "## Source Notes"
  });
  const entries = createVersionHistoryEntries({
    comments: [],
    patches: [addPatch, removePatch],
    versions: [
      version(26, {
        id: "snapshot-20260712-0026",
        reason: "before accepting patch PM-PATCH-0026"
      }),
      version(27, {
        id: "snapshot-20260712-0027",
        reason: "before accepting patch PM-PATCH-0027"
      })
    ]
  });

  assert.deepEqual(
    entries.map((entry) => entry.title),
    [
      "Before applying: Remove content from Source Notes",
      "Before applying: Add content to Source Notes"
    ]
  );
}

{
  const parsed = parsePatchmarkCommentReplyImport(
    JSON.stringify({
      protocol: "patchmark.comment_reply_import",
      protocol_version: 1,
      summary: "Imported patch.",
      replies: [],
      patch_proposals: [
        {
          comment_id: "PM-COMMENT-0001",
          title: "Add Thailand bakery market signals",
          target_heading: "Market View",
          original_text: "Old text",
          suggested_text: "New text",
          suggested_text_sources: [],
          reason: "Adds stronger market evidence.",
          reason_sources: [],
          risk_sources: []
        }
      ],
      open_questions: []
    })
  );

  assert.equal(
    parsed.patch_proposals[0].display_title,
    "Add Thailand bakery market signals"
  );
}

{
  const componentSource = readFileSync(
    "components/version-history-panel.tsx",
    "utf8"
  );
  const helperSource = readFileSync(
    "lib/project/version-history-display.ts",
    "utf8"
  );
  const snapshotDialogSource = readFileSync(
    "components/snapshot-dialog.tsx",
    "utf8"
  );
  const globalStyles = readFileSync("app/globals.css", "utf8");

  assert.match(componentSource, /View all versions/);
  assert.match(componentSource, /role="dialog"/);
  assert.match(componentSource, /aria-modal="true"/);
  assert.match(componentSource, /version-history-dialog-body/);
  assert.match(componentSource, /openArchiveButtonRef\.current\?\.focus/);
  assert.match(componentSource, /createPortal/);
  assert.match(componentSource, /document\.body/);
  assert.match(componentSource, /element\.inert = true/);
  assert.match(componentSource, /body\.style\.overflow = "hidden"/);
  assert.match(componentSource, /event\.key !== "Tab"/);
  assert.match(componentSource, /onViewVersion\(entry\.version, entry\.title\)/);
  assert.match(componentSource, /onCompareVersion\(entry\.version, entry\.title\)/);
  assert.match(componentSource, /data-version-id=\{entry\.version\.id\}/);
  assert.doesNotMatch(componentSource, /Related patch:/);
  assert.match(helperSource, /Snapshot file/);
  assert.match(globalStyles, /-webkit-line-clamp: 2/);
  assert.match(globalStyles, /\.version-entry-full \.version-entry-heading strong/);
  assert.match(globalStyles, /--layer-modal: 100/);
  assert.match(globalStyles, /z-index: var\(--layer-modal\)/);
  assert.match(snapshotDialogSource, /dialog\.displayTitle \?\? dialog\.version\.id/);
}

console.log("Version history display tests passed.");
