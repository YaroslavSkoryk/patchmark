import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzePatchmarkPersistence } from "./persistence-size-audit.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "patchmark-size-audit-test-"));
fs.mkdirSync(path.join(root, ".patchmark", "versions"), { recursive: true });
fs.writeFileSync(path.join(root, "document.md"), "# Test\n\nSelected text.\n");
fs.writeFileSync(
  path.join(root, ".patchmark", "manifest.json"),
  JSON.stringify({ schema_version: 1, document_file: "document.md" })
);
const anchor = {
  kind: "selected_text",
  selected_text: "Selected text.",
  markdown_start_offset: 8,
  markdown_end_offset: 22,
  anchor_context: {
    kind: "paragraph",
    plain_text: "Selected text.",
    markdown_text: "Selected text."
  }
};
const duplicateEntry = {
  changed_at: "2026-01-01T00:00:00.000Z",
  reason: "anchor_recovered_after_patch",
  previous_anchor: anchor,
  new_anchor: anchor,
  impact_kind: "linked_comment"
};
fs.writeFileSync(
  path.join(root, ".patchmark", "comments.json"),
  JSON.stringify(
    [
      {
        id: "PM-COMMENT-0001",
        type: "note",
        status: "open",
        anchor,
        comment: "Test",
        thread: [],
        export_state: { focus_state: "idle" },
        anchor_history: [duplicateEntry, duplicateEntry],
        patch_impacts: [
          {
            patch_id: "PM-PATCH-0001",
            impacted_at: "2026-01-01T00:00:00.000Z",
            impact_kind: "linked_comment",
            result: "reanchored"
          },
          {
            patch_id: "PM-PATCH-0001",
            impacted_at: "2026-01-02T00:00:00.000Z",
            impact_kind: "linked_comment",
            result: "reanchored"
          }
        ],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }
    ],
    null,
    2
  )
);
fs.writeFileSync(path.join(root, ".patchmark", "patches.json"), "[]\n");

try {
  const report = analyzePatchmarkPersistence({ benchmarkRuns: 1, projectDir: root });
  assert.equal(report.comments.count, 1);
  assert.equal(report.anchorHistory[0].duplicateEntries, 1);
  assert.equal(report.anchorHistory[0].consecutiveIdentical, 1);
  assert.equal(report.anchorHistory[0].noEffectiveAnchorChange, 2);
  assert.equal(report.patchImpacts[0].duplicateSemanticEntries, 1);
  assert.equal(report.recursiveHistory.nestedHistoricalArrayCount, 0);
  assert.ok(report.dryRun.rules.find((rule) => rule.id === "A").bytesSaved > 0);
  assert.ok(report.dryRun.rules.find((rule) => rule.id === "B").bytesSaved > 0);
  assert.ok(report.dryRun.rules.find((rule) => rule.id === "G").bytesSaved > 0);
  console.log("Persistence size audit tests passed.");
} finally {
  fs.rmSync(root, { force: true, recursive: true });
}
