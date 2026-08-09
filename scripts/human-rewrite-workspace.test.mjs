import assert from "node:assert/strict";
import {
  analyzeRewriteImpact,
  markPendingPatchesAfterHumanRewrite
} from "../lib/rewrite-workspace/rewrite-impact-analysis.ts";
import {
  buildRewriteReviewRequest,
  createRewriteSession,
  getCurrentRewriteReview,
  importRewriteReview,
  updateRewriteDraft
} from "../lib/rewrite-workspace/rewrite-review-protocol.ts";
import {
  captureRewriteTarget,
  resolveRewriteTarget,
  resolveRewriteTargetForRefresh
} from "../lib/rewrite-workspace/rewrite-target-resolution.ts";
import {
  createMemoryRewriteSessionStorage,
  discardLegacyRewriteSession,
  discardRewriteRecoveryCopy,
  readLegacyRewriteSessions,
  readRewriteRecoveryCopies,
  saveLegacyRewriteSessionForTests,
  saveRewriteRecoveryCopy,
  setRewriteSessionStorageForTests
} from "../lib/rewrite-workspace/rewrite-session-storage.ts";
import {
  parseRewriteProjectSessionStore,
  serializeRewriteProjectSessionStore
} from "../lib/rewrite-workspace/rewrite-project-session-schema.ts";
import { createVersionHistoryEntries } from "../lib/project/version-history-display.ts";

const projectId = "prj_rewrite_fixture";
const documentId = "doc_strategy";
const markdown = [
  "# Strategy",
  "",
  "Introductory context.",
  "",
  "## Growth Path",
  "",
  "The current plan is provisional and depends on repeat demand.",
  "",
  "| Stage | Gate |",
  "| --- | --- |",
  "| Launch | Reliable delivery |",
  "",
  "## Risks",
  "",
  "Capacity remains uncertain."
].join("\n");
const selectionText = "provisional and depends on repeat demand";
const selectionStart = markdown.indexOf(selectionText);
const selectionEnd = selectionStart + selectionText.length;

const selectionCapture = captureRewriteTarget({
  end: selectionEnd,
  headingLine: 5,
  kind: "selection",
  markdown,
  start: selectionStart
});
assert.equal(selectionCapture.text, selectionText);
assert.equal(selectionCapture.target.heading_snapshot, "Growth Path");

const sectionCapture = captureRewriteTarget({
  headingLine: 5,
  kind: "section",
  markdown
});
assert.equal(sectionCapture.text.startsWith("## Growth Path"), true);
assert.equal(sectionCapture.text.includes("## Risks"), false);

const movedMarkdown = `Preface.\n\n${markdown}`;
const movedSelection = resolveRewriteTarget({
  baseText: selectionCapture.text,
  markdown: movedMarkdown,
  target: selectionCapture.target
});
assert.equal(movedSelection?.text, selectionText);

const changedMarkdown = markdown.replace(selectionText, "definitive and already validated");
assert.equal(
  resolveRewriteTarget({
    baseText: selectionCapture.text,
    markdown: changedMarkdown,
    target: selectionCapture.target
  }),
  null
);
assert.equal(
  resolveRewriteTargetForRefresh({
    baseText: selectionCapture.text,
    markdown: changedMarkdown,
    target: selectionCapture.target
  })?.text,
  "definitive and already validated"
);

const session = await createRewriteSession({
  baseDocumentGeneration: 72,
  baseText: sectionCapture.text,
  documentId,
  documentTitle: "Strategy",
  localProjectInstanceId: "local_project_primary",
  markdown,
  projectId,
  projectTitle: "Strategy Project",
  target: sectionCapture.target
});
assert.equal(session.human_draft, session.base_text);
assert.equal(session.human_draft_sha256, session.base_text_sha256);

const storage = createMemoryRewriteSessionStorage();
setRewriteSessionStorageForTests(storage);
await saveRewriteRecoveryCopy({
  basedOnAuthoritativeRevision: 0,
  recoveryRevision: 1,
  session
});
assert.equal(
  (await readRewriteRecoveryCopies({
    documentId,
    localProjectInstanceId: "local_project_primary",
    projectId
  }))[0]?.rewrite_session_id,
  session.rewrite_session_id
);
assert.deepEqual(
  await readRewriteRecoveryCopies({
    documentId,
    localProjectInstanceId: "local_project_other",
    projectId
  }),
  []
);
const competingSession = await createRewriteSession({
  baseDocumentGeneration: 72,
  baseText: selectionCapture.text,
  documentId,
  documentTitle: "Strategy",
  localProjectInstanceId: "local_project_primary",
  markdown,
  projectId,
  projectTitle: "Strategy Project",
  target: selectionCapture.target
});
assert.throws(
  () => serializeRewriteProjectSessionStore({
    identity: { projectId, documentId },
    sessions: [session, competingSession]
  }),
  /at most one active Human Rewrite session/
);
const createdOtherDocumentSession = await createRewriteSession({
  baseDocumentGeneration: 1,
  baseText: selectionCapture.text,
  documentId: "doc_appendix",
  documentTitle: "Appendix",
  localProjectInstanceId: "local_project_primary",
  markdown,
  projectId,
  projectTitle: "Strategy Project",
  target: selectionCapture.target
});
const otherDocumentSession = {
  ...createdOtherDocumentSession,
  rewrite_session_id: session.rewrite_session_id
};
await saveRewriteRecoveryCopy({
  basedOnAuthoritativeRevision: 0,
  recoveryRevision: 1,
  session: otherDocumentSession
});
assert.equal(
  (await readRewriteRecoveryCopies({
    documentId: "doc_appendix",
    localProjectInstanceId: "local_project_primary",
    projectId
  }))[0]?.rewrite_session_id,
  otherDocumentSession.rewrite_session_id
);

const drafted = await updateRewriteDraft({
  humanDraft: sectionCapture.text.replace("provisional", "deliberately cautious"),
  intentNote: "Simplify without strengthening certainty.",
  session
});
const request = await buildRewriteReviewRequest(drafted);
assert.equal(request.prompt_text.includes(session.rewrite_session_id), true);
assert.equal(request.prompt_text.includes(JSON.stringify(sectionCapture.text)), true);
assert.equal(request.prompt_sha256.length, 64);

const response = createReviewResponse(request.session);
const currentImport = importRewriteReview({
  responseText: `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``,
  session: request.session
});
assert.equal(currentImport.current, true);
assert.equal(getCurrentRewriteReview(currentImport.session)?.response?.summary, response.summary);
assert.throws(() =>
  importRewriteReview({
    responseText: JSON.stringify(response),
    session: currentImport.session
  })
);

const changedDraft = await updateRewriteDraft({
  humanDraft: `${request.session.human_draft}\n\nAdditional human clarification.`,
  intentNote: request.session.intent_note,
  session: request.session
});
const historicalImport = importRewriteReview({
  responseText: JSON.stringify(response),
  session: changedDraft
});
assert.equal(historicalImport.current, false);
assert.equal(getCurrentRewriteReview(historicalImport.session), null);
const revisedAfterReview = await updateRewriteDraft({
  humanDraft: `${currentImport.session.human_draft}\n\nSecond-round clarification.`,
  intentNote: currentImport.session.intent_note,
  session: currentImport.session
});
const secondRequest = await buildRewriteReviewRequest(revisedAfterReview);
assert.equal(secondRequest.session.review_rounds.length, 2);
assert.equal(secondRequest.session.review_rounds[0].status, "imported");
assert.equal(secondRequest.session.review_rounds[1].status, "awaiting_response");
const serializedStore = serializeRewriteProjectSessionStore({
  identity: { projectId, documentId },
  sessions: [secondRequest.session]
});
const restoredStore = parseRewriteProjectSessionStore({
  identity: { projectId, documentId },
  text: serializedStore
});
assert.deepEqual(restoredStore.sessions[0], secondRequest.session);
await saveLegacyRewriteSessionForTests(secondRequest.session);
const legacySessions = await readLegacyRewriteSessions({
  documentId,
  localProjectInstanceId: "local_project_primary",
  projectId
});
assert.equal(legacySessions[0]?.human_draft, secondRequest.session.human_draft);
assert.equal(legacySessions[0]?.review_rounds.length, 2);

const selectedComment = {
  id: "PM-COMMENT-0001",
  type: "question",
  status: "open",
  anchor: {
    kind: "selected_text",
    selected_text: selectionText,
    markdown_start_offset: selectionStart,
    markdown_end_offset: selectionEnd,
    containing_heading: "Growth Path",
    containing_heading_level: 2
  },
  comment: "Does this preserve the cautious decision?",
  thread: [],
  export_state: { focus_state: "awaiting_reply" },
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z"
};
const documentComment = {
  ...selectedComment,
  id: "PM-COMMENT-0002",
  anchor: { kind: "document" },
  comment: "Review the whole document."
};
const pendingPatch = {
  id: "PM-PATCH-0001",
  status: "pending",
  comment_id: selectedComment.id,
  target_heading: "Growth Path",
  original_text: selectionText,
  suggested_text: "validated and ready for growth",
  reason: "Strengthen the plan.",
  created_at: "2026-08-02T00:00:00.000Z"
};
const bookmark = {
  format_version: 1,
  document: { project_id: projectId, document_id: documentId },
  anchor: selectedComment.anchor,
  created_at: "2026-08-02T00:00:00.000Z",
  updated_at: "2026-08-02T00:00:00.000Z"
};
const target = resolveRewriteTarget({
  baseText: sectionCapture.text,
  markdown,
  target: sectionCapture.target
});
assert.ok(target);
const analysis = analyzeRewriteImpact({
  bookmark,
  bookmarkSimulation: {
    commentId: "bookmark",
    outcome: "recovery_required",
    validationStatus: "not_found"
  },
  commentSimulation: [
    {
      commentId: selectedComment.id,
      outcome: "recovery_required",
      validationStatus: "not_found"
    }
  ],
  comments: [selectedComment, documentComment],
  markdown,
  patches: [pendingPatch],
  reviewBatches: [
    {
      batch_id: "review_batch_active",
      status: "exported",
      ordered_comment_ids: [selectedComment.id]
    }
  ],
  target
});
assert.equal(analysis.affectedComments, 1);
assert.equal(analysis.documentComments, 1);
assert.equal(analysis.bookmarkAffected, true);
assert.equal(analysis.pendingPatches, 1);
assert.equal(analysis.activeReviewBatchComments, 1);

const markedPatches = markPendingPatchesAfterHumanRewrite({
  analysis,
  appliedAt: "2026-08-02T01:00:00.000Z",
  patches: [pendingPatch],
  session: drafted
});
assert.equal(markedPatches[0].status, "stale");
assert.equal(
  markedPatches[0].human_rewrite_impact.reason,
  "overlapping_human_rewrite"
);

const versionEntries = createVersionHistoryEntries({
  comments: [],
  patches: [],
  versions: [
    {
      id: "snapshot-human-rewrite",
      file: ".patchmark/versions/snapshot-human-rewrite.md",
      created_at: "2026-08-02T01:00:00.000Z",
      reason: `before human rewrite ${session.rewrite_session_id}`,
      mutation: {
        author_type: "human",
        mutation_type: "human_rewrite",
        rewrite_session_id: session.rewrite_session_id,
        target_kind: "section",
        heading_snapshot: "Growth Path",
        base_text_sha256: session.base_text_sha256,
        applied_text_sha256: drafted.human_draft_sha256,
        semantic_review_status: "reviewed"
      }
    }
  ]
});
assert.equal(versionEntries[0].typeLabel, "Human rewrite safety snapshot");
assert.equal(
  versionEntries[0].detailItems.some(
    (item) => item.label === "Authorship" && item.value === "Human-authored"
  ),
  true
);

await discardRewriteRecoveryCopy(session);
await discardRewriteRecoveryCopy(otherDocumentSession);
await discardLegacyRewriteSession(secondRequest.session);
assert.deepEqual(
  await readRewriteRecoveryCopies({
    documentId,
    localProjectInstanceId: "local_project_primary",
    projectId
  }),
  []
);
setRewriteSessionStorageForTests(null);

process.stdout.write(
  `${JSON.stringify(
    {
      selectionAndSectionCapture: true,
      staleAndRefreshResolution: true,
      documentScopedBrowserRecovery: true,
      oneActiveSessionPerDocument: true,
      authoritativeSchemaRoundTrip: true,
      legacyRecoverySchemaMigration: true,
      exactReviewIdentity: true,
      currentAndHistoricalReviews: true,
      repeatedReviewRounds: true,
      duplicateImportRejected: true,
      impactAnalysis: true,
      patchNeedsReviewMetadata: true,
      humanAuthoredVersionHistory: true
    },
    null,
    2
  )}\n`
);

function createReviewResponse(reviewSession) {
  const round = reviewSession.review_rounds.at(-1);
  return {
    protocol: "patchmark.human_rewrite_review_import",
    protocol_version: 1,
    rewrite_session_id: reviewSession.rewrite_session_id,
    rewrite_review_id: round.rewrite_review_id,
    project_id: reviewSession.project_id,
    document_id: reviewSession.document_id,
    base_text_sha256: round.base_text_sha256,
    human_draft_sha256: round.human_draft_sha256,
    overall_assessment: "review_recommended",
    summary: "The rewrite preserves the plan while changing the certainty wording.",
    meaning_preserved: [
      {
        point: "Growth remains conditional.",
        current_text_evidence: "depends on repeat demand",
        rewrite_evidence: "depends on repeat demand"
      }
    ],
    meaning_changed: [],
    omitted_points: [],
    new_claims: [],
    contradictions: [],
    certainty_changes: [
      {
        topic: "Plan certainty",
        from: "provisional",
        to: "deliberately cautious",
        impact: "The rewrite describes intent rather than status."
      }
    ],
    source_impacts: [],
    ambiguities: [],
    suggested_draft_edits: []
  };
}
