import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeCommentHistoryProject,
  applyCommentHistoryCompaction,
  restoreCommentHistoryBackup
} from "./lib/comment-history-compaction-maintenance.mjs";

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "patchmark-history-compaction-test-")
);

try {
  const dryRunFixture = createFixture("dry-run");
  const dryRunBefore = hashCurrentFiles(dryRunFixture);
  const dryRun = await analyzeCommentHistoryProject({
    projectPath: dryRunFixture
  });
  assert.deepEqual(hashCurrentFiles(dryRunFixture), dryRunBefore);
  assert.equal(dryRun.report.legacy_history_count, 4);
  assert.ok(dryRun.report.estimated_reduction_bytes > 0);

  const applyFixture = createFixture("apply");
  const applyBefore = hashCurrentFiles(applyFixture);
  const applied = await applyCommentHistoryCompaction({
    expectedSourceHash: (
      await analyzeCommentHistoryProject({ projectPath: applyFixture })
    ).sourceFingerprint,
    projectPath: applyFixture
  });
  assert.equal(applied.apply.commit.status, "committed");
  assert.equal(applied.apply.commit.generation, 1);
  assert.equal(applied.apply.post_apply_validation.idempotent, true);
  assert.equal(
    applied.apply.post_apply_validation.no_op_save.write_count,
    0
  );
  assert.ok(fs.existsSync(applied.apply.backup_path));
  assert.notEqual(hashCurrentFiles(applyFixture).comments, applyBefore.comments);
  assert.equal(hashCurrentFiles(applyFixture).document, applyBefore.document);
  assert.equal(hashCurrentFiles(applyFixture).patches, applyBefore.patches);

  const second = await analyzeCommentHistoryProject({
    projectPath: applyFixture
  });
  assert.equal(second.report.legacy_history_count, 0);
  assert.equal(second.report.estimated_reduction_bytes, 0);
  await assert.rejects(
    applyCommentHistoryCompaction({ projectPath: applyFixture }),
    /No eligible legacy comment history/
  );

  const restored = await restoreCommentHistoryBackup({
    backupPath: applied.apply.backup_path,
    projectPath: applyFixture
  });
  assert.equal(restored.validation.document_hash_matches, true);
  assert.equal(restored.validation.comments_semantically_equal, true);
  assert.equal(restored.validation.patches_semantically_equal, true);
  const restoredHashes = hashCurrentFiles(applyFixture);
  assert.equal(restoredHashes.document, applyBefore.document);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(applyFixture, ".patchmark/comments.json"))),
    JSON.parse(
      fs.readFileSync(
        path.join(applied.apply.backup_path, "files/.patchmark/comments.json")
      )
    )
  );
  assert.equal(restoredHashes.patches, applyBefore.patches);

  const interruptedRollbackFixture = createFixture("interrupted-rollback");
  const interruptedApplied = await applyCommentHistoryCompaction({
    projectPath: interruptedRollbackFixture
  });
  await assert.rejects(
    restoreCommentHistoryBackup({
      backupPath: interruptedApplied.apply.backup_path,
      failureStage: "rollback_write",
      projectPath: interruptedRollbackFixture
    }),
    /Injected interrupted rollback write/
  );
  const afterInterruptedRollback = await analyzeCommentHistoryProject({
    projectPath: interruptedRollbackFixture
  });
  assert.equal(afterInterruptedRollback.report.legacy_history_count, 0);

  const sourceChangedFixture = createFixture("source-changed");
  const sourceChangedAnalysis = await analyzeCommentHistoryProject({
    projectPath: sourceChangedFixture
  });
  fs.appendFileSync(path.join(sourceChangedFixture, "document.md"), "\nChanged.\n");
  await assert.rejects(
    applyCommentHistoryCompaction({
      expectedSourceHash: sourceChangedAnalysis.sourceFingerprint,
      projectPath: sourceChangedFixture
    }),
    /Source fingerprint changed after dry run/
  );

  const backupFailureFixture = createFixture("backup-failure");
  const backupFailureBefore = hashCurrentFiles(backupFailureFixture);
  await assert.rejects(
    applyCommentHistoryCompaction({
      failureStage: "backup",
      projectPath: backupFailureFixture
    }),
    /Injected backup creation failure/
  );
  assert.deepEqual(hashCurrentFiles(backupFailureFixture), backupFailureBefore);

  const serializationFixture = createFixture("serialization-failure");
  const serializationBefore = hashCurrentFiles(serializationFixture);
  let serializationError;
  try {
    await applyCommentHistoryCompaction({
      failureStage: "serialization",
      projectPath: serializationFixture
    });
  } catch (error) {
    serializationError = error;
  }
  assert.match(serializationError.message, /serialization failure/);
  assert.ok(fs.existsSync(serializationError.backupPath));
  assert.deepEqual(hashCurrentFiles(serializationFixture), serializationBefore);

  for (const failureStage of ["temporary_write", "rename_install"]) {
    const fixture =
      failureStage === "rename_install"
        ? createCommittedFixture(failureStage)
        : createFixture(failureStage);
    const before = hashCurrentFiles(fixture);
    const commitBefore = fs.existsSync(
      path.join(fixture, ".patchmark/save-commit.json")
    )
      ? hash(path.join(fixture, ".patchmark/save-commit.json"))
      : null;
    let failure;
    try {
      await applyCommentHistoryCompaction({
        failureStage,
        projectPath: fixture
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.ok(fs.existsSync(failure.backupPath));
    if (failureStage === "temporary_write") {
      assert.deepEqual(hashCurrentFiles(fixture), before);
    } else {
      assert.equal(
        hash(path.join(fixture, ".patchmark/save-commit.json")),
        commitBefore,
        "Commit metadata must not advance after install failure."
      );
      await assert.rejects(
        analyzeCommentHistoryProject({ projectPath: fixture }),
        /not in a writable consistent state/
      );
    }
  }

  const postValidationFixture = createFixture("post-validation");
  const postValidationBefore = hashCurrentFiles(postValidationFixture);
  let postValidationError;
  try {
    await applyCommentHistoryCompaction({
      failureStage: "post_validate",
      projectPath: postValidationFixture
    });
  } catch (error) {
    postValidationError = error;
  }
  assert.match(postValidationError.message, /post-apply validation failure/);
  assert.equal(
    postValidationError.rollback.validation.comments_semantically_equal,
    true
  );
  const postValidationAfter = hashCurrentFiles(postValidationFixture);
  assert.equal(postValidationAfter.document, postValidationBefore.document);
  assert.notEqual(postValidationAfter.comments, "");
  assert.equal(postValidationAfter.patches, postValidationBefore.patches);

  process.stdout.write(
    `${JSON.stringify(
      {
        dryRunNoMutation: true,
        applyGeneration: applied.apply.commit.generation,
        backupVerified: true,
        noOpWrites: 0,
        idempotentSecondRun: true,
        rollbackVerified: true,
        sourceChangeRejected: true,
        failureStages: [
          "backup",
          "serialization",
          "temporary_write",
          "rename_install",
          "post_validate",
          "rollback_write"
        ]
      },
      null,
      2
    )}\n`
  );
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

function createFixture(name) {
  const projectPath = path.join(temporaryRoot, name);
  const metadataPath = path.join(projectPath, ".patchmark");
  fs.mkdirSync(metadataPath, { recursive: true });
  const markdown = ["# Fixture", "", "Alpha target.", "", "Beta target."].join(
    "\n"
  );
  const alphaStart = markdown.indexOf("Alpha target.");
  const betaStart = markdown.indexOf("Beta target.");
  const alpha = createAnchor("Alpha target.", alphaStart);
  const beta = createAnchor("Beta target.", betaStart);
  const comment = {
    id: "PM-COMMENT-0001",
    type: "note",
    status: "open",
    anchor: alpha,
    comment: "Preserve this comment.",
    thread: [
      {
        id: "PM-THREAD-0001",
        role: "user",
        content: "Preserve this user reply.",
        created_at: "2026-07-15T00:00:00.000Z"
      },
      {
        id: "PM-THREAD-0002",
        role: "chatgpt",
        content: "Preserve this ChatGPT reply.",
        created_at: "2026-07-15T00:00:01.000Z",
        sources: [
          {
            title: "Fixture source",
            url: "https://example.com/source"
          }
        ]
      }
    ],
    export_state: { focus_state: "idle" },
    anchor_history: [
      transition(alpha, beta),
      transition(alpha, beta),
      transition(beta, alpha),
      transition(alpha, alpha)
    ],
    patch_impacts: [
      impact("2026-07-15T00:00:00.000Z"),
      impact("2026-07-15T00:00:01.000Z")
    ],
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
  const manifest = {
    schema_version: 1,
    project_name: `Fixture ${name}`,
    document_file: "document.md",
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
  fs.writeFileSync(path.join(projectPath, "document.md"), markdown);
  fs.writeFileSync(
    path.join(metadataPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(metadataPath, "comments.json"),
    `${JSON.stringify([comment], null, 2)}\n`
  );
  fs.writeFileSync(path.join(metadataPath, "patches.json"), "[]\n");
  return projectPath;
}

function createCommittedFixture(name) {
  const projectPath = createFixture(name);
  const metadataPath = path.join(projectPath, ".patchmark");
  const manifestPath = path.join(metadataPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const commitId = "PM-SAVE-000001-FIXTURE";
  const committedManifest = {
    ...manifest,
    save_generation: 1,
    save_commit_id: commitId
  };
  const manifestText = `${JSON.stringify(committedManifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, manifestText);
  const files = {
    document: descriptor(
      "document.md",
      fs.readFileSync(path.join(projectPath, "document.md"))
    ),
    comments: descriptor(
      ".patchmark/comments.json",
      fs.readFileSync(path.join(metadataPath, "comments.json"))
    ),
    patches: descriptor(
      ".patchmark/patches.json",
      fs.readFileSync(path.join(metadataPath, "patches.json"))
    ),
    manifest: descriptor(".patchmark/manifest.json", Buffer.from(manifestText))
  };
  fs.writeFileSync(
    path.join(metadataPath, "save-commit.json"),
    `${JSON.stringify(
      {
        format_version: 1,
        generation: 1,
        commit_id: commitId,
        created_at: "2026-07-15T00:00:00.000Z",
        files
      },
      null,
      2
    )}\n`
  );
  return projectPath;
}

function createAnchor(selectedText, start) {
  return {
    kind: "selected_text",
    selected_text: selectedText,
    selected_text_hash: `fixture:${selectedText}`,
    markdown_start_offset: start,
    markdown_end_offset: start + selectedText.length,
    containing_heading: "Fixture",
    containing_heading_level: 1,
    containing_heading_path: ["Fixture"],
    anchor_source: "visual",
    anchor_context: {
      kind: "paragraph",
      plain_text: selectedText,
      markdown_text: selectedText,
      markdown_start_offset: start,
      markdown_end_offset: start + selectedText.length
    },
    action_context: {
      default_scope: "containing_section",
      include_document_brief: true,
      include_open_comments: "same_section",
      intent_hint: "note"
    }
  };
}

function transition(previousAnchor, newAnchor) {
  return {
    changed_at: "2026-07-15T00:00:00.000Z",
    reason: "anchor_recovered_after_patch",
    source_patch_id: "PM-PATCH-0001",
    previous_anchor: previousAnchor,
    new_anchor: newAnchor,
    impact_kind: "linked_comment"
  };
}

function impact(impactedAt) {
  return {
    patch_id: "PM-PATCH-0001",
    impacted_at: impactedAt,
    impact_kind: "linked_comment",
    result: "reanchored",
    note: "Same impact"
  };
}

function hashCurrentFiles(projectPath) {
  return {
    document: hash(path.join(projectPath, "document.md")),
    comments: hash(path.join(projectPath, ".patchmark/comments.json")),
    patches: hash(path.join(projectPath, ".patchmark/patches.json")),
    manifest: hash(path.join(projectPath, ".patchmark/manifest.json"))
  };
}

function hash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function descriptor(relativePath, contents) {
  return {
    path: relativePath,
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
    bytes: contents.byteLength
  };
}
