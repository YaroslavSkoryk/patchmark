import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const substantialValueBytes = 64;
const runtimeFieldPattern =
  /(^|_)(rect|top|bottom|dom|element|projection|visual_match|candidate|layout|performance|debug|cache)($|_)/i;

export function analyzePatchmarkPersistence({
  benchmarkRuns = 7,
  projectDir
}) {
  const documentPath = path.join(projectDir, "document.md");
  const commentsPath = path.join(projectDir, ".patchmark", "comments.json");
  const documentMarkdown = fs.readFileSync(documentPath, "utf8");
  const commentsRaw = fs.readFileSync(commentsPath, "utf8");
  const comments = JSON.parse(commentsRaw);

  if (!Array.isArray(comments)) {
    throw new Error("comments.json must contain an array.");
  }

  const fileAudit = auditProjectFiles(projectDir);
  const fieldStats = new Map();
  const repeatedStrings = new Map();
  const repeatedObjects = new Map();
  const runtimeFields = [];

  for (const comment of comments) {
    walkValue(comment, "comments[]", {
      fieldStats,
      repeatedObjects,
      repeatedStrings,
      runtimeFields
    });
  }

  const perComment = comments
    .map((comment) => auditComment(comment))
    .sort((first, second) => second.totalBytes - first.totalBytes);
  const commentSizes = perComment
    .map((comment) => comment.totalBytes)
    .sort((first, second) => first - second);
  const commentsCompactBytes = serializedBytes(comments);
  const historyAudit = comments.map(auditCommentHistory);
  const patchImpactAudit = comments.map(auditPatchImpacts);
  const threadAudit = auditThreads(comments);
  const recursiveHistory = auditRecursiveHistory(comments, documentMarkdown);
  const dryRun = estimateDryRunRules(comments);
  const repeatedStringRows = summarizeRepeatedValues(repeatedStrings);
  const repeatedObjectRows = summarizeRepeatedValues(repeatedObjects);
  const benchmark = benchmarkSerialization({
    benchmarkRuns,
    comments,
    commentsRaw
  });
  const smallComments = comments.map((comment) => ({
    ...comment,
    anchor_history: undefined,
    patch_impacts: undefined,
    thread: (comment.thread ?? []).slice(0, 1)
  }));
  const smallRaw = `${JSON.stringify(smallComments, null, 2)}\n`;

  return {
    projectDir,
    generatedAt: new Date().toISOString(),
    document: {
      bytes: Buffer.byteLength(documentMarkdown),
      lines: documentMarkdown.split(/\r?\n/).length,
      sha256: hashText(documentMarkdown)
    },
    files: fileAudit,
    comments: {
      count: comments.length,
      rawBytes: Buffer.byteLength(commentsRaw),
      compactBytes: commentsCompactBytes,
      prettyBytes: Buffer.byteLength(`${JSON.stringify(comments, null, 2)}\n`),
      gzipBytes: gzipSync(commentsRaw).byteLength,
      averageCommentBytes: round(
        perComment.reduce((total, comment) => total + comment.totalBytes, 0) /
          comments.length
      ),
      medianCommentBytes: percentile(commentSizes, 0.5),
      smallestCommentBytes: commentSizes[0] ?? 0,
      largestCommentBytes: commentSizes.at(-1) ?? 0,
      largestCommentPercent: percent(
        perComment[0]?.totalBytes ?? 0,
        commentsCompactBytes
      ),
      largestFivePercent: percent(
        perComment
          .slice(0, 5)
          .reduce((total, comment) => total + comment.totalBytes, 0),
        commentsCompactBytes
      ),
      perComment
    },
    fieldPaths: summarizeFieldStats(fieldStats),
    repeatedValues: {
      substantialStrings: repeatedStringRows,
      meaningfulObjects: repeatedObjectRows,
      estimatedStringDedupSavingsBytes: repeatedStringRows.reduce(
        (total, row) => total + row.duplicateBytes,
        0
      )
    },
    recursiveHistory,
    anchorHistory: historyAudit,
    patchImpacts: patchImpactAudit,
    threads: threadAudit,
    runtimeFields,
    dryRun,
    benchmark: {
      large: benchmark,
      small: benchmarkSerialization({
        benchmarkRuns,
        comments: smallComments,
        commentsRaw: smallRaw
      })
    }
  };
}

function auditProjectFiles(projectDir) {
  return listFiles(projectDir).map((filePath) => {
    const relativePath = path.relative(projectDir, filePath);
    const raw = fs.readFileSync(filePath);
    const row = {
      path: relativePath,
      rawBytes: raw.byteLength,
      gzipBytes: gzipSync(raw).byteLength,
      sha256: hashBuffer(raw)
    };

    if (!relativePath.endsWith(".json")) {
      return row;
    }

    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      const objects = Array.isArray(parsed) ? parsed : [parsed];
      const objectSizes = objects.map(serializedBytes);

      return {
        ...row,
        compactBytes: serializedBytes(parsed),
        prettyBytes: Buffer.byteLength(`${JSON.stringify(parsed, null, 2)}\n`),
        objectCount: objects.length,
        averageObjectBytes: round(
          objectSizes.reduce((total, size) => total + size, 0) /
            Math.max(1, objectSizes.length)
        ),
        maximumObjectBytes: Math.max(0, ...objectSizes)
      };
    } catch {
      return { ...row, invalidJson: true };
    }
  });
}

function auditComment(comment) {
  const topLevelBytes = Object.fromEntries(
    Object.entries(comment).map(([key, value]) => [key, serializedBytes(value)])
  );
  const anchorBytes = serializedBytes(comment.anchor);
  const anchorContextBytes = serializedBytes(comment.anchor?.anchor_context);

  return {
    commentId: comment.id,
    type: comment.type,
    status: comment.status,
    totalBytes: serializedBytes(comment),
    threadBytes: serializedBytes(comment.thread ?? []),
    anchorBytes,
    anchorContextBytes,
    anchorHistoryBytes: serializedBytes(comment.anchor_history ?? []),
    anchorHistoryCount: comment.anchor_history?.length ?? 0,
    patchImpactBytes: serializedBytes(comment.patch_impacts ?? []),
    patchImpactCount: comment.patch_impacts?.length ?? 0,
    recoveryHistoryBytes: serializedBytes(comment.recovery_history ?? []),
    relatedPatchMetadataBytes: serializedBytes(comment.patch_impacts ?? []),
    otherMetadataBytes: Object.entries(topLevelBytes)
      .filter(
        ([key]) =>
          ![
            "thread",
            "anchor",
            "anchor_history",
            "patch_impacts",
            "recovery_history"
          ].includes(key)
      )
      .reduce((total, [, size]) => total + size, 0)
  };
}

function auditCommentHistory(comment) {
  const history = comment.anchor_history ?? [];
  const exactHashes = history.map(hashValue);
  const transitionHashes = history.map((entry) =>
    hashValue({ previous: entry.previous_anchor, next: entry.new_anchor })
  );
  const transitionDirections = history.map((entry) => ({
    previous: hashValue(entry.previous_anchor),
    next: hashValue(entry.new_anchor)
  }));
  let consecutiveIdentical = 0;
  let pingPongTransitions = 0;

  for (let index = 1; index < history.length; index += 1) {
    if (exactHashes[index] === exactHashes[index - 1]) {
      consecutiveIdentical += 1;
    }
    if (
      transitionDirections[index - 1].previous === transitionDirections[index].next &&
      transitionDirections[index - 1].next === transitionDirections[index].previous
    ) {
      pingPongTransitions += 1;
    }
  }

  return {
    commentId: comment.id,
    entries: history.length,
    bytes: serializedBytes(history),
    uniqueEntries: new Set(exactHashes).size,
    duplicateEntries: history.length - new Set(exactHashes).size,
    consecutiveIdentical,
    uniqueTransitions: new Set(transitionHashes).size,
    repeatedTransitions: history.length - new Set(transitionHashes).size,
    noEffectiveAnchorChange: history.filter(
      (entry) =>
        entry.new_anchor !== undefined &&
        hashValue(entry.previous_anchor) === hashValue(entry.new_anchor)
    ).length,
    pingPongTransitions,
    uniqueTimestamps: new Set(history.map((entry) => entry.changed_at)).size,
    uniqueSourcePatches: new Set(
      history.map((entry) => entry.source_patch_id).filter(Boolean)
    ).size,
    reasons: countBy(history, (entry) => entry.reason),
    impactKinds: countBy(history, (entry) => entry.impact_kind ?? "none")
  };
}

function auditPatchImpacts(comment) {
  const impacts = comment.patch_impacts ?? [];
  const exactHashes = impacts.map(hashValue);
  const semanticKeys = impacts.map(
    (impact) =>
      `${impact.patch_id}\u0000${impact.impact_kind}\u0000${impact.result}\u0000${impact.note ?? ""}`
  );
  let consecutiveSemanticDuplicates = 0;

  for (let index = 1; index < semanticKeys.length; index += 1) {
    if (semanticKeys[index] === semanticKeys[index - 1]) {
      consecutiveSemanticDuplicates += 1;
    }
  }

  return {
    commentId: comment.id,
    entries: impacts.length,
    bytes: serializedBytes(impacts),
    uniqueExactEntries: new Set(exactHashes).size,
    duplicateExactEntries: impacts.length - new Set(exactHashes).size,
    uniqueSemanticEntries: new Set(semanticKeys).size,
    duplicateSemanticEntries: impacts.length - new Set(semanticKeys).size,
    consecutiveSemanticDuplicates,
    uniquePatchIds: new Set(impacts.map((impact) => impact.patch_id)).size,
    results: countBy(impacts, (impact) => impact.result),
    impactKinds: countBy(impacts, (impact) => impact.impact_kind)
  };
}

function auditThreads(comments) {
  const entries = comments.flatMap((comment) =>
    (comment.thread ?? []).map((entry) => ({ ...entry, commentId: comment.id }))
  );
  const roleRows = Object.entries(countBy(entries, (entry) => entry.role)).map(
    ([role, count]) => ({
      role,
      count,
      bytes: entries
        .filter((entry) => entry.role === role)
        .reduce((total, entry) => total + serializedBytes(entry), 0)
    })
  );
  const systemEntries = entries.filter((entry) => entry.role === "system");
  const contentKeys = systemEntries.map(
    (entry) => `${entry.content}\u0000${entry.source_patch_id ?? ""}`
  );
  const technicalEntries = systemEntries.filter((entry) =>
    /anchor|reanchor|recover|patch|offset|position/i.test(entry.content)
  );

  return {
    totalEntries: entries.length,
    totalBytes: entries.reduce((total, entry) => total + serializedBytes(entry), 0),
    roles: roleRows,
    systemEntries: systemEntries.length,
    systemBytes: systemEntries.reduce(
      (total, entry) => total + serializedBytes(entry),
      0
    ),
    technicalSystemEntries: technicalEntries.length,
    technicalSystemBytes: technicalEntries.reduce(
      (total, entry) => total + serializedBytes(entry),
      0
    ),
    duplicateSystemEntries:
      contentKeys.length - new Set(contentKeys).size
  };
}

function auditRecursiveHistory(comments, documentMarkdown) {
  const nestedHistoricalArrays = [];
  const documentSizedContexts = [];

  for (const comment of comments) {
    for (const [index, entry] of (comment.anchor_history ?? []).entries()) {
      for (const [side, anchor] of [
        ["previous_anchor", entry.previous_anchor],
        ["new_anchor", entry.new_anchor]
      ]) {
        if (!anchor) continue;
        const forbiddenPaths = findForbiddenHistoricalArrays(anchor);
        for (const forbiddenPath of forbiddenPaths) {
          nestedHistoricalArrays.push({
            commentId: comment.id,
            historyIndex: index,
            side,
            path: forbiddenPath
          });
        }
        for (const [field, value] of Object.entries(anchor.anchor_context ?? {})) {
          if (
            typeof value === "string" &&
            Buffer.byteLength(value) >= Buffer.byteLength(documentMarkdown) * 0.8
          ) {
            documentSizedContexts.push({
              commentId: comment.id,
              historyIndex: index,
              side,
              field,
              bytes: Buffer.byteLength(value),
              sha256: hashText(value),
              equalsCurrentDocument: value === documentMarkdown
            });
          }
        }
      }
    }
  }

  return {
    nestedHistoricalArrays,
    nestedHistoricalArrayCount: nestedHistoricalArrays.length,
    documentSizedContexts,
    documentSizedContextCount: documentSizedContexts.length,
    documentSizedContextBytes: documentSizedContexts.reduce(
      (total, row) => total + row.bytes,
      0
    )
  };
}

function estimateDryRunRules(comments) {
  const currentBytes = serializedBytes(comments);
  const rules = [];

  rules.push(
    estimateRule({
      id: "A",
      name: "Remove exact consecutive history entries",
      comments,
      transform(comment) {
        const history = comment.anchor_history ?? [];
        const nextHistory = history.filter(
          (entry, index) => index === 0 || hashValue(entry) !== hashValue(history[index - 1])
        );
        return { ...comment, anchor_history: nextHistory };
      }
    })
  );
  rules.push(
    estimateRule({
      id: "B",
      name: "Remove no-effective-anchor-change history entries",
      comments,
      transform(comment) {
        return {
          ...comment,
          anchor_history: (comment.anchor_history ?? []).filter(
            (entry) =>
              entry.new_anchor === undefined ||
              hashValue(entry.previous_anchor) !== hashValue(entry.new_anchor)
          )
        };
      }
    })
  );
  rules.push({
    id: "C",
    name: "Remove nested history arrays from history snapshots",
    eligibleRecords: comments.reduce(
      (total, comment) =>
        total +
        (comment.anchor_history ?? []).filter((entry) =>
          [entry.previous_anchor, entry.new_anchor]
            .filter(Boolean)
            .some((anchor) => findForbiddenHistoricalArrays(anchor).length > 0)
        ).length,
      0
    ),
    bytesSaved: 0,
    percentReduction: 0
  });
  rules.push(
    estimateRule({
      id: "D",
      name: "Store concise anchor transition evidence",
      comments,
      eligibleRecords: comments.reduce(
        (total, comment) => total + (comment.anchor_history ?? []).length,
        0
      ),
      transform(comment) {
        return {
          ...comment,
          anchor_history: (comment.anchor_history ?? []).map((entry) => ({
            ...entry,
            previous_anchor: conciseAnchor(entry.previous_anchor),
            new_anchor: entry.new_anchor ? conciseAnchor(entry.new_anchor) : undefined
          }))
        };
      }
    })
  );
  rules.push(
    estimateRule({
      id: "E",
      name: "Coalesce consecutive routine offset-shift history",
      comments,
      transform(comment) {
        const history = comment.anchor_history ?? [];
        return {
          ...comment,
          anchor_history: history.filter((entry, index) => {
            if (
              entry.reason !== "offset_shifted_after_patch" ||
              index === 0 ||
              index === history.length - 1
            ) {
              return true;
            }
            const previous = history[index - 1];
            const next = history[index + 1];
            return !(
              previous.reason === entry.reason &&
              next.reason === entry.reason &&
              previous.source_patch_id === entry.source_patch_id &&
              next.source_patch_id === entry.source_patch_id
            );
          })
        };
      }
    })
  );
  rules.push(
    estimateRule({
      id: "F",
      name: "Remove duplicate technical system messages",
      comments,
      transform(comment) {
        const seen = new Set();
        return {
          ...comment,
          thread: (comment.thread ?? []).filter((entry) => {
            if (
              entry.role !== "system" ||
              !/anchor|reanchor|recover|patch|offset|position/i.test(entry.content)
            ) {
              return true;
            }
            const key = `${entry.content}\u0000${entry.source_patch_id ?? ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
        };
      }
    })
  );
  rules.push(
    estimateRule({
      id: "G",
      name: "Deduplicate patch impacts by patch and outcome",
      comments,
      transform(comment) {
        const seen = new Set();
        return {
          ...comment,
          patch_impacts: (comment.patch_impacts ?? []).filter((impact) => {
            const key = `${impact.patch_id}\u0000${impact.impact_kind}\u0000${impact.result}\u0000${impact.note ?? ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
        };
      }
    })
  );
  rules.push(
    estimateRule({
      id: "H",
      name: "Retain first and last copy of repeated transition evidence",
      comments,
      transform(comment) {
        const history = comment.anchor_history ?? [];
        const keys = history.map(
          (entry) =>
            `${entry.reason}\u0000${entry.source_patch_id ?? ""}\u0000${entry.impact_kind ?? ""}\u0000${hashValue(entry.previous_anchor)}\u0000${hashValue(entry.new_anchor)}`
        );
        const first = new Map();
        const last = new Map();
        keys.forEach((key, index) => {
          if (!first.has(key)) first.set(key, index);
          last.set(key, index);
        });
        return {
          ...comment,
          anchor_history: history.filter(
            (_, index) => first.get(keys[index]) === index || last.get(keys[index]) === index
          )
        };
      }
    })
  );

  return { currentBytes, rules };
}

function estimateRule({ id, name, comments, eligibleRecords, transform }) {
  const transformed = comments.map(transform);
  const before = serializedBytes(comments);
  const after = serializedBytes(transformed);
  const beforeRecords = countHistoryRecords(comments);
  const afterRecords = countHistoryRecords(transformed);

  return {
    id,
    name,
    eligibleRecords:
      eligibleRecords ?? Math.max(0, beforeRecords - afterRecords),
    projectedBytes: after,
    bytesSaved: Math.max(0, before - after),
    percentReduction: percent(Math.max(0, before - after), before)
  };
}

function benchmarkSerialization({ benchmarkRuns, comments, commentsRaw }) {
  const compact = JSON.stringify(comments);
  const pretty = `${JSON.stringify(comments, null, 2)}\n`;
  const writePath = path.join(
    os.tmpdir(),
    `patchmark-persistence-audit-${process.pid}.json`
  );
  const timings = {
    parse: measureRuns(benchmarkRuns, () => JSON.parse(commentsRaw)),
    structuredClone: measureRuns(benchmarkRuns, () => structuredClone(comments)),
    stringifyCompact: measureRuns(benchmarkRuns, () => JSON.stringify(comments)),
    stringifyPretty: measureRuns(benchmarkRuns, () => JSON.stringify(comments, null, 2)),
    checksumSha256: measureRuns(benchmarkRuns, () => hashText(commentsRaw)),
    gzip: measureRuns(benchmarkRuns, () => gzipSync(commentsRaw)),
    filesystemWrite: measureRuns(benchmarkRuns, () => fs.writeFileSync(writePath, pretty)),
    filesystemRead: measureRuns(benchmarkRuns, () => fs.readFileSync(writePath)),
    totalPrettySave: measureRuns(benchmarkRuns, () => {
      fs.writeFileSync(writePath, `${JSON.stringify(comments, null, 2)}\n`);
    })
  };
  fs.rmSync(writePath, { force: true });

  return {
    runs: benchmarkRuns,
    rawBytes: Buffer.byteLength(commentsRaw),
    compactBytes: Buffer.byteLength(compact),
    prettyBytes: Buffer.byteLength(pretty),
    gzipBytes: gzipSync(commentsRaw).byteLength,
    timingsMs: timings
  };
}

function walkValue(value, fieldPath, audit) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkValue(item, `${fieldPath}[]`, audit);
    }
    return;
  }

  if (value && typeof value === "object") {
    if (isMeaningfulRepeatedObjectPath(fieldPath)) {
      recordRepeatedValue(audit.repeatedObjects, value, fieldPath);
    }
    for (const [key, child] of Object.entries(value)) {
      const nextPath = `${fieldPath}.${key}`;
      if (runtimeFieldPattern.test(key)) {
        audit.runtimeFields.push({ path: nextPath, bytes: serializedBytes(child) });
      }
      walkValue(child, nextPath, audit);
    }
    return;
  }

  const bytes = serializedBytes(value);
  const row = audit.fieldStats.get(fieldPath) ?? {
    path: fieldPath,
    occurrences: 0,
    totalBytes: 0,
    maximumBytes: 0
  };
  row.occurrences += 1;
  row.totalBytes += bytes;
  row.maximumBytes = Math.max(row.maximumBytes, bytes);
  audit.fieldStats.set(fieldPath, row);

  if (typeof value === "string" && bytes >= substantialValueBytes) {
    recordRepeatedValue(audit.repeatedStrings, value, fieldPath);
  }
}

function recordRepeatedValue(map, value, fieldPath) {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes < substantialValueBytes) return;
  const hash = hashText(serialized);
  const row = map.get(hash) ?? {
    hash,
    bytes,
    occurrences: 0,
    totalBytes: 0,
    paths: new Set()
  };
  row.occurrences += 1;
  row.totalBytes += bytes;
  row.paths.add(fieldPath);
  map.set(hash, row);
}

function summarizeRepeatedValues(map) {
  return [...map.values()]
    .filter((row) => row.occurrences > 1)
    .map((row) => ({
      hash: row.hash,
      bytes: row.bytes,
      occurrences: row.occurrences,
      totalBytes: row.totalBytes,
      duplicateBytes: row.totalBytes - row.bytes,
      paths: [...row.paths].sort()
    }))
    .sort((first, second) => second.duplicateBytes - first.duplicateBytes)
    .slice(0, 100);
}

function summarizeFieldStats(fieldStats) {
  return [...fieldStats.values()]
    .map((row) => ({
      ...row,
      averageBytes: round(row.totalBytes / row.occurrences)
    }))
    .sort((first, second) => second.totalBytes - first.totalBytes)
    .slice(0, 100);
}

function conciseAnchor(anchor) {
  if (!anchor || anchor.kind === "document") return { kind: "document" };
  if (anchor.kind === "section") {
    return {
      kind: "section",
      heading: anchor.heading,
      heading_level: anchor.heading_level,
      heading_path: anchor.heading_path,
      section_start_offset: anchor.section_start_offset,
      section_end_offset: anchor.section_end_offset
    };
  }
  return {
    kind: "selected_text",
    selected_text_hash: anchor.selected_text_hash ?? hashText(anchor.selected_text),
    selected_text_bytes: Buffer.byteLength(anchor.selected_text ?? ""),
    markdown_start_offset: anchor.markdown_start_offset,
    markdown_end_offset: anchor.markdown_end_offset,
    containing_heading: anchor.containing_heading,
    containing_heading_path: anchor.containing_heading_path,
    anchor_source: anchor.anchor_source,
    context: anchor.anchor_context
      ? {
          kind: anchor.anchor_context.kind,
          context_hash:
            anchor.anchor_context.context_hash ??
            hashText(anchor.anchor_context.markdown_text ?? anchor.anchor_context.plain_text),
          markdown_start_offset: anchor.anchor_context.markdown_start_offset,
          markdown_end_offset: anchor.anchor_context.markdown_end_offset,
          selected_start_in_context: anchor.anchor_context.selected_start_in_context,
          selected_end_in_context: anchor.anchor_context.selected_end_in_context
        }
      : undefined
  };
}

function findForbiddenHistoricalArrays(value, currentPath = "") {
  const matches = [];
  if (!value || typeof value !== "object") return matches;
  for (const [key, child] of Object.entries(value)) {
    const childPath = currentPath ? `${currentPath}.${key}` : key;
    if (["anchor_history", "patch_impacts", "recovery_history", "thread"].includes(key)) {
      matches.push(childPath);
    }
    matches.push(...findForbiddenHistoricalArrays(child, childPath));
  }
  return matches;
}

function listFiles(rootDir) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  walk(rootDir);
  return files.sort();
}

function isMeaningfulRepeatedObjectPath(fieldPath) {
  return /(?:anchor_context|previous_anchor|new_anchor|anchor_history\[\]|patch_impacts\[\]|thread\[\])$/.test(
    fieldPath
  );
}

function countBy(values, getKey) {
  return Object.fromEntries(
    [...values.reduce((map, value) => {
      const key = String(getKey(value));
      map.set(key, (map.get(key) ?? 0) + 1);
      return map;
    }, new Map())].sort((first, second) => second[1] - first[1])
  );
}

function countHistoryRecords(comments) {
  return comments.reduce(
    (total, comment) =>
      total +
      (comment.anchor_history?.length ?? 0) +
      (comment.patch_impacts?.length ?? 0) +
      (comment.thread?.length ?? 0),
    0
  );
}

function measureRuns(runs, callback) {
  const values = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    callback();
    values.push(performance.now() - startedAt);
  }
  values.sort((first, second) => first - second);
  return {
    median: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    maximum: round(values.at(-1) ?? 0)
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1)
  );
  return sortedValues[index];
}

function serializedBytes(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized);
}

function hashValue(value) {
  return hashText(JSON.stringify(value));
}

function hashText(value) {
  return crypto.createHash("sha256").update(value ?? "").digest("hex");
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function percent(value, total) {
  return total === 0 ? 0 : round((value / total) * 100);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const projectDir = process.env.PATCHMARK_PROJECT_DIR ?? process.argv[2];
  if (!projectDir) {
    throw new Error(
      "Set PATCHMARK_PROJECT_DIR or pass a Patchmark project directory."
    );
  }
  const report = analyzePatchmarkPersistence({ projectDir });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
