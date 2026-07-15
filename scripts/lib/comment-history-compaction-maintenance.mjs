import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { compactLegacyCommentHistory } from "../../lib/comments/comment-history-compaction.ts";
import {
  getProjectPersistenceDebugState,
  openProjectFolder,
  readProjectComments,
  readProjectPatches,
  resetProjectPersistenceDebugState,
  saveProjectState
} from "../../lib/project/patchmark-project.ts";
import {
  createNodeHandleController,
  NodeDirectoryHandle
} from "./node-directory-handle.mjs";

const backupFormatVersion = 1;
const criticalProjectFiles = [
  "document.md",
  ".patchmark/comments.json",
  ".patchmark/patches.json",
  ".patchmark/manifest.json"
];

export async function analyzeCommentHistoryProject({
  projectPath,
  failureStage
}) {
  const startedAt = performance.now();
  const absoluteProjectPath = validateProjectPath(projectPath);
  const sourceFiles = collectSourceFiles(absoluteProjectPath);
  const sourceFingerprint = createFilesFingerprint(
    absoluteProjectPath,
    sourceFiles
  );
  const commentsPath = path.join(
    absoluteProjectPath,
    ".patchmark",
    "comments.json"
  );
  const commentsRaw = fs.readFileSync(commentsPath, "utf8");
  const commentsParse = measure(() => JSON.parse(commentsRaw));
  const rawComments = commentsParse.value;

  if (!Array.isArray(rawComments)) {
    throw new Error(".patchmark/comments.json must contain an array.");
  }

  const load = await measureAsync(() =>
    loadProject(absoluteProjectPath, createFailureController(failureStage))
  );
  const { loaded, normalizedComments, patches } = load.value;
  assertProjectWritableAndConsistent(loaded);
  validateRawCommentNormalization(rawComments, normalizedComments);
  const compact = measure(() =>
    compactLegacyCommentHistory({
      comments: rawComments,
      commentsFileBytes: Buffer.byteLength(commentsRaw),
      markdown: loaded.markdown,
      patches
    })
  );
  const compactedRaw = `${JSON.stringify(compact.value.comments, null, 2)}\n`;
  const stringifyBefore = benchmark(() => JSON.stringify(rawComments));
  const stringifyAfter = benchmark(() =>
    JSON.stringify(compact.value.comments)
  );
  const parseAfter = benchmark(() => JSON.parse(compactedRaw));
  const report = {
    format_version: 1,
    kind: "patchmark.comment_history_compaction_dry_run",
    generated_at: new Date().toISOString(),
    project_path: absoluteProjectPath,
    project_fingerprint: sourceFingerprint,
    comments_file_path: commentsPath,
    source_files: describeFiles(absoluteProjectPath, sourceFiles),
    ...compact.value.report,
    gzip_bytes_before: gzipSync(commentsRaw).byteLength,
    gzip_bytes_after: gzipSync(compactedRaw).byteLength,
    timings_ms: {
      total_analysis: round(performance.now() - startedAt),
      project_load: round(load.duration),
      comments_parse: round(commentsParse.duration),
      normalization: load.value.normalizationMs,
      canonical_validation_and_compaction: round(compact.duration),
      stringify_before_median: stringifyBefore,
      stringify_after_median: stringifyAfter,
      parse_after_median: parseAfter
    }
  };

  return {
    absoluteProjectPath,
    compactedComments: compact.value.comments,
    loaded,
    normalizedComments,
    patches,
    report,
    sourceFiles,
    sourceFingerprint
  };
}

export async function applyCommentHistoryCompaction({
  expectedSourceHash,
  failureStage,
  projectPath
}) {
  const analysis = await analyzeCommentHistoryProject({
    projectPath,
    failureStage
  });
  assertAnalysisCanApply(analysis.report);

  if (
    expectedSourceHash &&
    expectedSourceHash !== analysis.sourceFingerprint
  ) {
    throw new Error(
      `Source fingerprint changed after dry run. Expected ${expectedSourceHash}, found ${analysis.sourceFingerprint}.`
    );
  }

  const immediatelyBeforeBackup = createFilesFingerprint(
    analysis.absoluteProjectPath,
    analysis.sourceFiles
  );
  if (immediatelyBeforeBackup !== analysis.sourceFingerprint) {
    throw new Error("Source project changed during compaction analysis.");
  }

  assertDiskSpace({
    projectPath: analysis.absoluteProjectPath,
    sourceFiles: analysis.sourceFiles,
    estimatedOutputBytes: analysis.report.estimated_output_bytes
  });
  const backup = createVerifiedBackup({
    failureStage,
    kind: "pre_compaction",
    projectPath: analysis.absoluteProjectPath,
    sourceFiles: analysis.sourceFiles,
    sourceFingerprint: analysis.sourceFingerprint
  });

  if (failureStage === "serialization") {
    const error = new Error("Injected compact serialization failure.");
    error.backupPath = backup.backupPath;
    throw error;
  }

  const beforeCommit = createFilesFingerprint(
    analysis.absoluteProjectPath,
    analysis.sourceFiles
  );
  if (beforeCommit !== analysis.sourceFingerprint) {
    const error = new Error(
      "Source project changed after backup; compacted output was not installed."
    );
    error.backupPath = backup.backupPath;
    throw error;
  }

  let commitResult;
  try {
    resetProjectPersistenceDebugState(analysis.loaded.project);
    commitResult = await saveProjectState({
      comments: analysis.compactedComments,
      markdown: analysis.loaded.markdown,
      patches: analysis.patches,
      project: analysis.loaded.project,
      reason: "compact_legacy_anchor_history"
    });

    if (commitResult.status !== "committed") {
      throw new Error(
        `Compaction did not create one committed generation (${commitResult.status}).`
      );
    }

    if (failureStage === "post_validate") {
      throw new Error("Injected post-apply validation failure.");
    }

    const validation = await validateAppliedProject({
      beforeComments: analysis.compactedComments,
      projectPath: analysis.absoluteProjectPath
    });
    const afterFiles = collectSourceFiles(analysis.absoluteProjectPath);
    const afterFingerprint = createFilesFingerprint(
      analysis.absoluteProjectPath,
      afterFiles
    );

    return {
      ...analysis,
      apply: {
        backup_path: backup.backupPath,
        backup_manifest: backup.manifest,
        commit: commitResult,
        persistence_debug: getProjectPersistenceDebugState(
          analysis.loaded.project
        ),
        post_apply_validation: validation,
        source_fingerprint_before: analysis.sourceFingerprint,
        source_fingerprint_after: afterFingerprint,
        files_after: describeFiles(analysis.absoluteProjectPath, afterFiles)
      }
    };
  } catch (error) {
    if (commitResult?.status === "committed") {
      const rollback = await restoreCommentHistoryBackup({
        backupPath: backup.backupPath,
        failureStage: undefined,
        projectPath: analysis.absoluteProjectPath,
        safetyKind: "failed_compaction"
      });
      error.rollback = rollback;
    }
    error.backupPath = backup.backupPath;
    throw error;
  }
}

export async function restoreCommentHistoryBackup({
  backupPath,
  failureStage,
  projectPath,
  safetyKind = "pre_restore"
}) {
  const absoluteProjectPath = validateProjectPath(projectPath);
  const verifiedBackup = verifyBackup({
    backupPath,
    expectedProjectPath: absoluteProjectPath
  });
  const currentFiles = collectSourceFiles(absoluteProjectPath);
  const currentFingerprint = createFilesFingerprint(
    absoluteProjectPath,
    currentFiles
  );
  const safetyBackup = createVerifiedBackup({
    failureStage,
    kind: safetyKind,
    projectPath: absoluteProjectPath,
    sourceFiles: currentFiles,
    sourceFingerprint: currentFingerprint
  });
  const controller = createFailureController(failureStage);
  const { loaded } = await loadProject(absoluteProjectPath, controller);
  assertProjectWritableAndConsistent(loaded);
  const originalDocument = readBackupText(
    verifiedBackup.backupPath,
    "document.md"
  );
  const originalComments = JSON.parse(
    readBackupText(verifiedBackup.backupPath, ".patchmark/comments.json")
  );
  const originalPatches = JSON.parse(
    readBackupText(verifiedBackup.backupPath, ".patchmark/patches.json")
  );
  const originalManifest = JSON.parse(
    readBackupText(verifiedBackup.backupPath, ".patchmark/manifest.json")
  );

  resetProjectPersistenceDebugState(loaded.project);
  const commit = await saveProjectState({
    comments: originalComments,
    manifest: originalManifest,
    markdown: originalDocument,
    patches: originalPatches,
    project: loaded.project,
    reason: "restore_history_compaction_backup"
  });

  if (commit.status !== "committed") {
    throw new Error(`Backup restore did not commit (${commit.status}).`);
  }

  const validation = await validateRestoredProject({
    backup: verifiedBackup,
    projectPath: absoluteProjectPath
  });

  return {
    backup_path: verifiedBackup.backupPath,
    safety_backup_path: safetyBackup.backupPath,
    commit,
    validation
  };
}

export function writeCompactionReport(reportPath, report) {
  const absoluteReportPath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
  writeFileAtomic(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`);
  return absoluteReportPath;
}

async function validateAppliedProject({ beforeComments, projectPath }) {
  const reloaded = await loadProject(projectPath, createNodeHandleController());
  assertProjectWritableAndConsistent(reloaded.loaded);
  assertCommentSemanticsEqual(beforeComments, reloaded.normalizedComments);
  const secondPass = compactLegacyCommentHistory({
    comments: reloaded.normalizedComments,
    markdown: reloaded.loaded.markdown,
    patches: reloaded.patches
  });

  if (
    secondPass.report.legacy_history_count !== 0 ||
    secondPass.report.estimated_reduction_bytes !== 0 ||
    secondPass.report.blocking_validation_errors.length > 0
  ) {
    throw new Error("Compacted project failed the idempotence validation.");
  }

  resetProjectPersistenceDebugState(reloaded.loaded.project);
  const noOp = await saveProjectState({
    comments: reloaded.normalizedComments,
    markdown: reloaded.loaded.markdown,
    patches: reloaded.patches,
    project: reloaded.loaded.project,
    reason: "validate_compaction_no_op"
  });
  const debug = getProjectPersistenceDebugState(reloaded.loaded.project);

  if (
    noOp.status !== "unchanged" ||
    debug.serializationCount !== 0 ||
    debug.writeCount !== 0 ||
    debug.bytesWritten !== 0
  ) {
    throw new Error("Post-compaction no-op save performed persistence work.");
  }

  return {
    comment_count: reloaded.normalizedComments.length,
    idempotent: true,
    no_op_save: {
      status: noOp.status,
      serialization_count: debug.serializationCount,
      write_count: debug.writeCount,
      bytes_written: debug.bytesWritten
    }
  };
}

async function validateRestoredProject({ backup, projectPath }) {
  const reloaded = await loadProject(projectPath, createNodeHandleController());
  assertProjectWritableAndConsistent(reloaded.loaded);
  const documentHash = hashBuffer(
    fs.readFileSync(path.join(projectPath, "document.md"))
  );
  const commentsHash = hashBuffer(
    fs.readFileSync(path.join(projectPath, ".patchmark/comments.json"))
  );
  const patchesHash = hashBuffer(
    fs.readFileSync(path.join(projectPath, ".patchmark/patches.json"))
  );
  const backedUp = Object.fromEntries(
    backup.manifest.files.map((file) => [file.path, file.sha256])
  );

  if (documentHash !== backedUp["document.md"]) {
    throw new Error("Restored document.md does not match the backup.");
  }
  const restoredCommentsText = fs.readFileSync(
    path.join(projectPath, ".patchmark/comments.json"),
    "utf8"
  );
  const backupCommentsText = readBackupText(
    backup.backupPath,
    ".patchmark/comments.json"
  );
  const restoredPatchesText = fs.readFileSync(
    path.join(projectPath, ".patchmark/patches.json"),
    "utf8"
  );
  const backupPatchesText = readBackupText(
    backup.backupPath,
    ".patchmark/patches.json"
  );
  const commentsSemanticallyEqual =
    stableSerialize(JSON.parse(restoredCommentsText)) ===
    stableSerialize(JSON.parse(backupCommentsText));
  const patchesSemanticallyEqual =
    stableSerialize(JSON.parse(restoredPatchesText)) ===
    stableSerialize(JSON.parse(backupPatchesText));

  if (!commentsSemanticallyEqual) {
    throw new Error("Restored comments.json is not semantically equal to the backup.");
  }
  if (!patchesSemanticallyEqual) {
    throw new Error("Restored patches.json is not semantically equal to the backup.");
  }

  return {
    project_loadable: true,
    document_hash_matches: true,
    comments_hash_matches:
      commentsHash === backedUp[".patchmark/comments.json"],
    comments_semantically_equal: commentsSemanticallyEqual,
    patches_hash_matches: patchesHash === backedUp[".patchmark/patches.json"],
    patches_semantically_equal: patchesSemanticallyEqual
  };
}

async function loadProject(projectPath, controller) {
  const root = new NodeDirectoryHandle(projectPath, controller);
  const previousWindow = globalThis.window;
  globalThis.window = { showDirectoryPicker: async () => root };
  const normalizationStarted = performance.now();

  try {
    const loaded = await openProjectFolder();
    if (!loaded) {
      throw new Error("Project directory selection was unexpectedly cancelled.");
    }
    const normalizedComments = await readProjectComments(loaded.project);
    const patches = await readProjectPatches(loaded.project);
    return {
      loaded,
      normalizedComments,
      patches,
      normalizationMs: round(performance.now() - normalizationStarted)
    };
  } finally {
    globalThis.window = previousWindow;
  }
}

function assertProjectWritableAndConsistent(loaded) {
  if (loaded.recovery || loaded.project.persistence.recovery) {
    const recovery = loaded.recovery ?? loaded.project.persistence.recovery;
    throw new Error(
      `Project is not in a writable consistent state: ${recovery.message}`
    );
  }
  if (loaded.project.persistence.readSource !== "current") {
    throw new Error("Project is not reading from its current committed generation.");
  }
}

function validateRawCommentNormalization(rawComments, normalizedComments) {
  if (rawComments.length !== normalizedComments.length) {
    throw new Error("Comment normalization changed the comment count.");
  }

  for (let index = 0; index < rawComments.length; index += 1) {
    const raw = omitMaintenanceFields(rawComments[index]);
    const normalized = omitMaintenanceFields(normalizedComments[index]);
    if (stableSerialize(raw) !== stableSerialize(normalized)) {
      throw new Error(
        `${rawComments[index]?.id ?? `comments[${index}]`}: normal loading would change protected comment fields; compacting was refused.`
      );
    }
  }
}

function assertAnalysisCanApply(report) {
  if (report.blocking_validation_errors.length > 0) {
    throw new Error(
      `Compaction validation failed: ${report.blocking_validation_errors.join(" ")}`
    );
  }
  if (report.legacy_history_count === 0 || report.estimated_reduction_bytes === 0) {
    throw new Error("No eligible legacy comment history requires compaction.");
  }
}

function createVerifiedBackup({
  failureStage,
  kind,
  projectPath,
  sourceFiles,
  sourceFingerprint
}) {
  if (failureStage === "backup") {
    throw new Error("Injected backup creation failure.");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    projectPath,
    ".patchmark",
    "backups",
    `history-compaction-${timestamp}-${kind}`
  );

  if (fs.existsSync(backupPath)) {
    throw new Error(`Backup already exists: ${backupPath}`);
  }

  fs.mkdirSync(path.join(backupPath, "files"), { recursive: true });
  const files = [];

  try {
    for (const relativePath of sourceFiles) {
      const sourcePath = path.join(projectPath, relativePath);
      const targetPath = path.join(backupPath, "files", relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      const source = describeFile(projectPath, relativePath);
      const copied = describeFile(path.join(backupPath, "files"), relativePath);
      if (source.sha256 !== copied.sha256 || source.bytes !== copied.bytes) {
        throw new Error(`Could not verify backup file ${relativePath}.`);
      }
      files.push(source);
    }

    const manifest = {
      format_version: backupFormatVersion,
      kind: "patchmark.comment_history_compaction_backup",
      backup_reason: kind,
      created_at: new Date().toISOString(),
      source_project_path: projectPath,
      source_project_fingerprint: sourceFingerprint,
      files
    };
    writeFileAtomic(
      path.join(backupPath, "backup-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const verified = verifyBackup({
      backupPath,
      expectedProjectPath: projectPath
    });
    return { backupPath, manifest: verified.manifest };
  } catch (error) {
    fs.rmSync(backupPath, { force: true, recursive: true });
    throw error;
  }
}

function verifyBackup({ backupPath, expectedProjectPath }) {
  const absoluteBackupPath = path.resolve(backupPath);
  const manifestPath = path.join(absoluteBackupPath, "backup-manifest.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup manifest is missing: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest.format_version !== backupFormatVersion ||
    manifest.kind !== "patchmark.comment_history_compaction_backup" ||
    path.resolve(manifest.source_project_path) !== path.resolve(expectedProjectPath) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Backup manifest is invalid or belongs to another project.");
  }

  for (const file of manifest.files) {
    const copiedPath = path.join(absoluteBackupPath, "files", file.path);
    if (!fs.existsSync(copiedPath)) {
      throw new Error(`Backup file is missing: ${file.path}`);
    }
    const current = describeFile(path.join(absoluteBackupPath, "files"), file.path);
    if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) {
      throw new Error(`Backup file hash mismatch: ${file.path}`);
    }
  }

  return { backupPath: absoluteBackupPath, manifest };
}

function readBackupText(backupPath, relativePath) {
  return fs.readFileSync(path.join(backupPath, "files", relativePath), "utf8");
}

function collectSourceFiles(projectPath) {
  const required = criticalProjectFiles.filter((relativePath) => {
    const filePath = path.join(projectPath, relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required Patchmark project file is missing: ${filePath}`);
    }
    return true;
  });
  const optional = [".patchmark/save-commit.json"].filter((relativePath) =>
    fs.existsSync(path.join(projectPath, relativePath))
  );
  const recoveryPath = path.join(projectPath, ".patchmark", "recovery");
  const recovery = fs.existsSync(recoveryPath)
    ? listFiles(recoveryPath).map((filePath) => path.relative(projectPath, filePath))
    : [];
  return [...required, ...optional, ...recovery].sort();
}

function validateProjectPath(projectPath) {
  if (!projectPath || typeof projectPath !== "string") {
    throw new Error("--project must be an explicit Patchmark project path.");
  }
  const absoluteProjectPath = path.resolve(projectPath);
  const stats = fs.statSync(absoluteProjectPath);
  if (!stats.isDirectory()) {
    throw new Error(`Project path is not a directory: ${absoluteProjectPath}`);
  }
  if (
    !fs.existsSync(path.join(absoluteProjectPath, "document.md")) ||
    !fs.existsSync(path.join(absoluteProjectPath, ".patchmark", "manifest.json"))
  ) {
    throw new Error(`Not a Patchmark project: ${absoluteProjectPath}`);
  }
  return absoluteProjectPath;
}

function assertDiskSpace({ projectPath, sourceFiles, estimatedOutputBytes }) {
  const sourceBytes = sourceFiles.reduce(
    (total, relativePath) =>
      total + fs.statSync(path.join(projectPath, relativePath)).size,
    0
  );
  const requiredBytes =
    sourceBytes * 3 + estimatedOutputBytes * 2 + 32 * 1024 * 1024;
  const stats = fs.statfsSync(projectPath);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);

  if (availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient disk space. Required safety reserve ${requiredBytes} bytes; available ${availableBytes} bytes.`
    );
  }
}

function createFilesFingerprint(projectPath, files) {
  const evidence = files.map((relativePath) => describeFile(projectPath, relativePath));
  return hashText(stableSerialize(evidence));
}

function describeFiles(projectPath, files) {
  return files.map((relativePath) => describeFile(projectPath, relativePath));
}

function describeFile(rootPath, relativePath) {
  const filePath = path.join(rootPath, relativePath);
  const contents = fs.readFileSync(filePath);
  return {
    path: relativePath,
    bytes: contents.byteLength,
    sha256: hashBuffer(contents)
  };
}

function assertCommentSemanticsEqual(before, after) {
  if (stableSerialize(before) !== stableSerialize(after)) {
    throw new Error("Reloaded compacted comments are not semantically identical.");
  }
}

function omitMaintenanceFields(comment) {
  if (!comment || typeof comment !== "object") {
    return comment;
  }
  const { anchor_history, patch_impacts, ...protectedFields } = comment;
  void anchor_history;
  void patch_impacts;
  return protectedFields;
}

function createFailureController(failureStage) {
  if (failureStage === "temporary_write") {
    return createNodeHandleController({
      beforeWrite(targetPath) {
        if (path.basename(targetPath).startsWith(".patchmark-tmp-")) {
          throw new Error("Injected temporary write failure.");
        }
      }
    });
  }
  if (failureStage === "rename_install") {
    return createNodeHandleController({
      beforeRename(_temporaryPath, targetPath) {
        if (
          path.basename(targetPath) === "manifest.json" &&
          path.basename(path.dirname(targetPath)) === ".patchmark"
        ) {
          throw new Error("Injected rename/install failure.");
        }
      }
    });
  }
  if (failureStage === "rollback_write") {
    return createNodeHandleController({
      beforeWrite(targetPath) {
        if (path.basename(targetPath).startsWith(".patchmark-tmp-")) {
          throw new Error("Injected interrupted rollback write.");
        }
      }
    });
  }
  return createNodeHandleController();
}

function listFiles(directoryPath) {
  return fs.readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

function writeFileAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function benchmark(callback, runs = 5) {
  const durations = [];
  for (let index = 0; index < runs; index += 1) {
    durations.push(measure(callback).duration);
  }
  durations.sort((first, second) => first - second);
  return round(durations[Math.floor(durations.length / 2)] ?? 0);
}

function measure(callback) {
  const startedAt = performance.now();
  const value = callback();
  return { value, duration: performance.now() - startedAt };
}

async function measureAsync(callback) {
  const startedAt = performance.now();
  const value = await callback();
  return { value, duration: performance.now() - startedAt };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function hashText(value) {
  return hashBuffer(Buffer.from(value));
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
