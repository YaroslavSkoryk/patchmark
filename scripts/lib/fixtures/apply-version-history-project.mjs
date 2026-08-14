import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_FIXTURE_IDS,
  getProjectFixtureRoot,
  writeProjectFixtureJson,
  writeProjectFixtureText
} from "../project-fixture-foundation.mjs";

const fixedTimestamp = "2040-07-01T09:00:00.000Z";

export const VERSION_HISTORY_FIXTURE = Object.freeze({
  activeCommentId: "PM-COMMENT-HISTORY-ACTIVE",
  documentId: "doc_fixture_atlas",
  projectId: "prj_fixture_atlas",
  versionScopeId: "legacy-document",
  versionIds: Object.freeze(
    Array.from({ length: 7 }, (_, index) =>
      `PM-VERSION-HISTORY-${String(index + 1).padStart(2, "0")}`
    )
  )
});

export function applyVersionHistoryProject(projectRoot) {
  const root = requireWritableLegacyCopy(projectRoot);
  const currentMarker =
    "The current violet lens records the authoritative invented signal.";
  const currentMarkdown = [
    "# Synthetic Lantern Archive",
    "",
    "This current document is deliberately distinct from every stored checkpoint.",
    "",
    "## Current Signal",
    "",
    currentMarker,
    "",
    "A quiet copper compass confirms that previewing history must remain read-only.",
    "",
    "## Current Notes",
    "",
    "Seven fictional checkpoints make ordering and selection exact."
  ].join("\n");
  const states = createHistoryStates();
  const fileWriteOrder = [3, 0, 6, 1, 5, 2, 4];
  const manifestOrder = [2, 0, 6, 1, 5, 3, 4];

  for (const stateIndex of fileWriteOrder) {
    const state = states[stateIndex];
    writeProjectFixtureText(root, state.file, state.markdown);
  }

  const originalManifest = JSON.parse(
    readFileSync(join(root, ".patchmark", "manifest.json"), "utf8")
  );
  const versions = manifestOrder.map((stateIndex) =>
    createVersionEntry(states[stateIndex])
  );
  writeProjectFixtureJson(root, ".patchmark/manifest.json", {
    ...originalManifest,
    updated_at: fixedTimestamp,
    current_version: states.at(-1).id,
    versions
  });

  const activeStart = currentMarkdown.indexOf(currentMarker);
  writeProjectFixtureText(root, "document.md", currentMarkdown);
  writeProjectFixtureJson(root, ".patchmark/comments.json", [
    {
      id: VERSION_HISTORY_FIXTURE.activeCommentId,
      type: "note",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: currentMarker,
        markdown_start_offset: activeStart,
        markdown_end_offset: activeStart + currentMarker.length,
        anchor_source: "markdown"
      },
      comment: "Keep the synthetic current signal visible after closing history.",
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: fixedTimestamp,
      updated_at: fixedTimestamp
    }
  ]);
  writeProjectFixtureJson(root, ".patchmark/patches.json", [
    {
      id: "PM-PATCH-7005",
      status: "accepted",
      comment_id: VERSION_HISTORY_FIXTURE.activeCommentId,
      display_title: "Align the invented cobalt lens",
      original_text: "The cobalt lens points toward the quiet western relay.",
      suggested_text: "The cobalt lens aligns with the quiet western relay.",
      reason: "Keep the synthetic relay state exact.",
      created_at: "2040-07-01T08:04:30.000Z",
      applied_at: "2040-07-01T08:05:30.000Z",
      pre_apply_snapshot_id: states[4].id,
      pre_apply_snapshot_file: states[4].file
    }
  ]);

  const entries = states.map((state) => ({
    ...createVersionEntry(state),
    markdown: state.markdown,
    title: state.title
  }));

  return {
    ...VERSION_HISTORY_FIXTURE,
    commentCount: 1,
    currentMarkdown,
    currentVersionId: states.at(-1).id,
    fileWriteOrder: fileWriteOrder.map((index) => states[index].id),
    manifestOrder: manifestOrder.map((index) => states[index].id),
    newestFirst: [...entries].reverse(),
    snapshotCount: states.length
  };
}

function createHistoryStates() {
  const specifications = [
    {
      reason: "Initial invented checkpoint",
      marker: "The first brass dial marks the fictional northern relay.",
      title: "Initial invented checkpoint"
    },
    {
      reason: "Record amber lens alignment",
      marker: "The amber lens records a calm synthetic horizon.",
      title: "Record amber lens alignment"
    },
    {
      reason: "Imported lantern plan",
      marker: "The imported paper lantern maps an imaginary eastern signal.",
      title: "Imported document version"
    },
    {
      reason: "Before restoring lantern draft",
      marker: "The restore checkpoint keeps a fictional silver aperture.",
      title: "Before restoring version"
    },
    {
      reason: "before applying patch PM-PATCH-7005",
      marker: "The cobalt lens points toward the quiet western relay.",
      title: "Before applying: Align the invented cobalt lens"
    },
    {
      reason: "human rewrite safety snapshot",
      marker: "The human rewrite checkpoint holds a synthetic green prism.",
      title: "Before human rewrite: Lantern Calibration",
      mutation: {
        author_type: "human",
        mutation_type: "human_rewrite",
        rewrite_session_id: "PM-REWRITE-HISTORY-06",
        target_kind: "section",
        heading_snapshot: "Lantern Calibration",
        base_text_sha256: "1".repeat(64),
        applied_text_sha256: "2".repeat(64),
        semantic_review_status: "reviewed"
      }
    },
    {
      reason: "manual snapshot",
      marker: "The latest manual checkpoint stores a fictional gold compass.",
      title: "Manual snapshot"
    }
  ];

  return specifications.map((specification, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const markdown = [
      `# Synthetic History State ${ordinal}`,
      "",
      specification.marker,
      "",
      `Checkpoint ordinal: ${ordinal}.`,
      "",
      "All names and observations in this snapshot are invented."
    ].join("\n");
    return {
      ...specification,
      id: VERSION_HISTORY_FIXTURE.versionIds[index],
      file: `.patchmark/versions/pm-version-history-${ordinal}.md`,
      createdAt: `2040-07-01T08:0${index}:00.000Z`,
      contentHash: createHash("sha256").update(markdown).digest("hex"),
      markdown
    };
  });
}

function createVersionEntry(state) {
  return {
    id: state.id,
    file: state.file,
    created_at: state.createdAt,
    reason: state.reason,
    content_hash: state.contentHash,
    ...(state.mutation ? { mutation: state.mutation } : {})
  };
}

function requireWritableLegacyCopy(projectRoot) {
  const root = realpathSync(projectRoot);
  const source = getProjectFixtureRoot(PROJECT_FIXTURE_IDS.legacyCore);

  if (root === source) {
    throw new Error("Version history must be applied to a fresh fixture copy.");
  }

  const manifest = JSON.parse(
    readFileSync(join(root, ".patchmark", "manifest.json"), "utf8")
  );
  if (
    manifest.project_id !== VERSION_HISTORY_FIXTURE.projectId ||
    manifest.document_id !== VERSION_HISTORY_FIXTURE.documentId
  ) {
    throw new Error("Version history requires the legacy schema core.");
  }

  return root;
}
