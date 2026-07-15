#!/usr/bin/env node
import {
  analyzeCommentHistoryProject,
  applyCommentHistoryCompaction,
  restoreCommentHistoryBackup,
  writeCompactionReport
} from "./lib/comment-history-compaction-maintenance.mjs";

const options = parseArguments(process.argv.slice(2));

try {
  const mode = options.restoreBackup
    ? "restore-backup"
    : options.apply
      ? "apply"
      : "dry-run";
  process.stdout.write(`Patchmark history compaction\n`);
  process.stdout.write(`Project: ${options.project}\n`);
  process.stdout.write(`Mode: ${mode}\n`);

  let output;

  if (options.restoreBackup) {
    output = {
      format_version: 1,
      kind: "patchmark.comment_history_compaction_restore",
      generated_at: new Date().toISOString(),
      project_path: options.project,
      restore: await restoreCommentHistoryBackup({
        backupPath: options.restoreBackup,
        failureStage: process.env.PATCHMARK_COMPACTION_FAIL_STAGE,
        projectPath: options.project
      })
    };
    printRestoreSummary(output);
  } else if (options.apply) {
    const result = await applyCommentHistoryCompaction({
      expectedSourceHash: options.expectedSourceHash,
      failureStage: process.env.PATCHMARK_COMPACTION_FAIL_STAGE,
      projectPath: options.project
    });
    output = { ...result.report, apply: result.apply };
    printDryRunSummary(output);
    process.stdout.write(`Backup: ${result.apply.backup_path}\n`);
    process.stdout.write(
      `Committed generation: ${result.apply.commit.generation}\n`
    );
  } else {
    const result = await analyzeCommentHistoryProject({
      failureStage: process.env.PATCHMARK_COMPACTION_FAIL_STAGE,
      projectPath: options.project
    });
    output = result.report;
    printDryRunSummary(output);
  }

  if (options.report) {
    const writtenPath = writeCompactionReport(options.report, output);
    process.stdout.write(`Report: ${writtenPath}\n`);
  }

  process.stdout.write(`--- PATCHMARK_COMPACTION_JSON ---\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Patchmark history compaction failed.\n`);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error?.backupPath) {
    process.stderr.write(`Verified backup retained at: ${error.backupPath}\n`);
  }
  if (error?.rollback) {
    process.stderr.write(
      `Automatic rollback committed generation ${error.rollback.commit.generation}.\n`
    );
  }
  process.exitCode = 1;
}

function parseArguments(argumentsList) {
  const options = {
    apply: false,
    dryRun: false,
    expectedSourceHash: undefined,
    project: undefined,
    report: undefined,
    restoreBackup: undefined
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--project") {
      options.project = requireValue(argumentsList, ++index, argument);
    } else if (argument === "--report") {
      options.report = requireValue(argumentsList, ++index, argument);
    } else if (argument === "--expected-source-hash") {
      options.expectedSourceHash = requireValue(
        argumentsList,
        ++index,
        argument
      );
    } else if (argument === "--restore-backup") {
      options.restoreBackup = requireValue(argumentsList, ++index, argument);
    } else if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.project) {
    throw new Error("--project is required and must name an explicit project path.");
  }
  if (options.apply && options.dryRun) {
    throw new Error("Choose either --apply or --dry-run, not both.");
  }
  if (options.restoreBackup && (options.apply || options.dryRun)) {
    throw new Error("--restore-backup cannot be combined with apply/dry-run mode.");
  }
  return options;
}

function requireValue(argumentsList, index, option) {
  const value = argumentsList[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function printDryRunSummary(report) {
  process.stdout.write(`Source fingerprint: ${report.project_fingerprint}\n`);
  process.stdout.write(
    `Comments: ${report.comment_count}; legacy history: ${report.legacy_history_count}; concise history: ${report.concise_history_count}\n`
  );
  process.stdout.write(
    `Estimated comments.json: ${report.comments_file_bytes} -> ${report.estimated_output_bytes} bytes (${report.estimated_reduction_percentage}% reduction)\n`
  );
  process.stdout.write(
    `Affected comments: ${report.comments_affected}; blocking errors: ${report.blocking_validation_errors.length}; warnings: ${report.warnings.length}\n`
  );
}

function printRestoreSummary(output) {
  process.stdout.write(`Backup: ${output.restore.backup_path}\n`);
  process.stdout.write(
    `Safety backup: ${output.restore.safety_backup_path}\n`
  );
  process.stdout.write(
    `Restored through generation: ${output.restore.commit.generation}\n`
  );
}

function printHelp() {
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  npm run compact:comment-history -- --project /path/to/project [--dry-run] [--report /path/report.json]\n`
  );
  process.stdout.write(
    `  npm run compact:comment-history -- --project /path/to/project --apply [--expected-source-hash HASH]\n`
  );
  process.stdout.write(
    `  npm run compact:comment-history -- --project /path/to/project --restore-backup /path/to/backup\n`
  );
  process.stdout.write(`Dry-run is the default. Apply is never inferred.\n`);
}
