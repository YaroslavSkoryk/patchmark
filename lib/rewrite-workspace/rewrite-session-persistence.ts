import {
  readProjectRewriteSessionRecords,
  RewriteProjectSessionConflictError,
  saveProjectRewriteSessionRecord,
  saveProjectStateWithRewriteSessionRecord,
  verifyProjectRewriteSessionRecord,
  type PatchmarkProjectHandle
} from "../project/patchmark-project.ts";
import type {
  PatchmarkComment,
  PatchmarkManifest,
  PatchmarkPatch
} from "../project/project-types.ts";
import {
  discardLegacyRewriteSession,
  discardRewriteRecoveryCopy,
  discardRewriteRecoveryCopyIfRevision,
  readLegacyRewriteSessions,
  readRewriteRecoveryCopies,
  saveRewriteRecoveryCopy
} from "./rewrite-session-storage.ts";
import type {
  RewriteRecoveryRecord,
  RewriteSession,
  RewriteTerminalSession
} from "./rewrite-session-types.ts";

export type RewritePersistenceNotice =
  | "legacy_migrated"
  | "project_copy_rebound"
  | null;

export type RewriteRecoveryConflict = {
  kind: "newer_recovery" | "divergent_recovery" | "legacy_divergence";
  projectSession: RewriteSession | null;
  recoverySession: RewriteSession;
  recoveryRecord: RewriteRecoveryRecord | null;
  projectSavedAt: string | null;
  recoverySavedAt: string;
};

export type RewriteSessionLoadResult = {
  conflict: RewriteRecoveryConflict | null;
  notice: RewritePersistenceNotice;
  session: RewriteSession | null;
  source: "project" | "recovery_only" | "none";
};

export type RewriteProjectSaveResult = {
  queueLength: number;
  recoveryAvailable: boolean;
  session: RewriteSession;
};

export class RewriteSessionPersistenceError extends Error {
  readonly conflict: boolean;
  readonly recoverySaved: boolean;

  constructor({
    cause,
    recoverySaved
  }: {
    cause: unknown;
    recoverySaved: boolean;
  }) {
    const conflict = cause instanceof RewriteProjectSessionConflictError;
    super(
      conflict
        ? "This rewrite draft changed in another Patchmark window. Reload or compare before saving."
        : cause instanceof Error
          ? cause.message
          : String(cause)
    );
    this.name = "RewriteSessionPersistenceError";
    this.conflict = conflict;
    this.recoverySaved = recoverySaved;
  }
}

export type RewriteSessionPersistenceCoordinator = ReturnType<
  typeof createRewriteSessionPersistenceCoordinator
>;

export function createRewriteSessionPersistenceCoordinator({
  localProjectInstanceId,
  project
}: {
  localProjectInstanceId: string;
  project: PatchmarkProjectHandle;
}) {
  let authoritativeRevision = 0;
  let recoveryRevision = 0;
  let queuedOperations = 0;
  let saveQueue = Promise.resolve();

  async function load(): Promise<RewriteSessionLoadResult> {
    const identity = getIdentity(project);
    const projectRecords = await readProjectRewriteSessionRecords(project);
    const activeProjectSession = projectRecords.find(
      (record): record is RewriteSession => record.status === "draft"
    ) ?? null;
    const terminalIds = new Set(
      projectRecords
        .filter((record) => record.status !== "draft")
        .map((record) => record.rewrite_session_id)
    );
    const [legacySessions, recoveryRecords] = await Promise.all([
      readLegacyRewriteSessions({
        documentId: identity.documentId,
        localProjectInstanceId,
        projectId: identity.projectId
      }),
      readRewriteRecoveryCopies({
        documentId: identity.documentId,
        localProjectInstanceId,
        projectId: identity.projectId
      })
    ]);

    await Promise.all([
      ...legacySessions
        .filter((session) => terminalIds.has(session.rewrite_session_id))
        .map((session) => discardLegacyRewriteSession(session).catch(() => undefined)),
      ...recoveryRecords
        .filter((record) => terminalIds.has(record.rewrite_session_id))
        .map((record) => discardRewriteRecoveryCopy(record.session).catch(() => undefined))
    ]);

    if (activeProjectSession) {
      authoritativeRevision = activeProjectSession.authoritative_revision;
      recoveryRevision = Math.max(
        recoveryRevision,
        ...recoveryRecords.map((record) => record.recovery_revision)
      );
      let projectSession = activeProjectSession;
      let notice: RewritePersistenceNotice = null;
      if (projectSession.local_project_instance_id !== localProjectInstanceId) {
        const rebound = {
          ...projectSession,
          local_project_instance_id: localProjectInstanceId,
          updated_at: new Date().toISOString()
        };
        try {
          projectSession = (await persist(rebound, "rebind_rewrite_project_copy")).session;
          notice = "project_copy_rebound";
        } catch {
          projectSession = rebound;
        }
      }

      const legacy = legacySessions.find(
        (session) => session.rewrite_session_id === projectSession.rewrite_session_id
      );
      if (legacy) {
        if (areSessionsEquivalent(projectSession, legacy)) {
          await discardLegacyRewriteSession(legacy).catch(() => undefined);
        } else {
          return {
            conflict: createConflict({
              kind: "legacy_divergence",
              projectSession,
              recoverySession: legacy,
              recoveryRecord: null
            }),
            notice,
            session: projectSession,
            source: "project"
          };
        }
      }

      const recovery = recoveryRecords.find(
        (record) => record.rewrite_session_id === projectSession.rewrite_session_id
      );
      if (recovery) {
        if (areSessionsEquivalent(projectSession, recovery.session)) {
          await discardRewriteRecoveryCopy(recovery.session).catch(() => undefined);
        } else {
          return {
            conflict: createConflict({
              kind:
                recovery.based_on_authoritative_revision ===
                projectSession.authoritative_revision
                  ? "newer_recovery"
                  : "divergent_recovery",
              projectSession,
              recoverySession: recovery.session,
              recoveryRecord: recovery
            }),
            notice,
            session: projectSession,
            source: "project"
          };
        }
      }

      return { conflict: null, notice, session: projectSession, source: "project" };
    }

    const legacyCandidate = legacySessions.find(
      (session) => !terminalIds.has(session.rewrite_session_id)
    );
    if (legacyCandidate) {
      const migrated = {
        ...legacyCandidate,
        local_project_instance_id: localProjectInstanceId,
        authoritative_revision: 0,
        authoritative_generation: project.persistence.generation,
        stale_reference: false
      };
      try {
        const saved = await persist(migrated, "migrate_legacy_rewrite_session");
        if (!(await verifyProjectRewriteSessionRecord({ project, session: saved.session }))) {
          throw new Error("The migrated Human Rewrite session could not be verified.");
        }
        await discardLegacyRewriteSession(legacyCandidate);
        return {
          conflict: null,
          notice: "legacy_migrated",
          session: saved.session,
          source: "project"
        };
      } catch {
        return {
          conflict: null,
          notice: null,
          session: migrated,
          source: "recovery_only"
        };
      }
    }

    const recoveryCandidate = recoveryRecords.find(
      (record) => !terminalIds.has(record.rewrite_session_id)
    );
    if (recoveryCandidate) {
      recoveryRevision = recoveryCandidate.recovery_revision;
      const candidate = {
        ...recoveryCandidate.session,
        local_project_instance_id: localProjectInstanceId
      };
      try {
        const saved = await persist(candidate, "recover_browser_rewrite_session");
        return {
          conflict: null,
          notice: null,
          session: saved.session,
          source: "project"
        };
      } catch {
        return {
          conflict: null,
          notice: null,
          session: candidate,
          source: "recovery_only"
        };
      }
    }

    return { conflict: null, notice: null, session: null, source: "none" };
  }

  async function persist(
    session: RewriteSession,
    reason: string
  ): Promise<RewriteProjectSaveResult> {
    const ownedSession = {
      ...session,
      local_project_instance_id: localProjectInstanceId,
      authoritative_revision: authoritativeRevision
    };
    recoveryRevision += 1;
    const requestedRecoveryRevision = recoveryRevision;
    let recoveryAvailable = false;
    try {
      await saveRewriteRecoveryCopy({
        basedOnAuthoritativeRevision: authoritativeRevision,
        recoveryRevision: requestedRecoveryRevision,
        session: ownedSession
      });
      recoveryAvailable = true;
    } catch {
      recoveryAvailable = false;
    }

    return enqueue(async (queueLength) => {
      try {
        const saved = await saveProjectRewriteSessionRecord({
          expectedRevision: authoritativeRevision,
          project,
          reason,
          record: ownedSession
        });
        const savedSession = saved.record as RewriteSession;
        authoritativeRevision = savedSession.authoritative_revision;
        await discardRewriteRecoveryCopyIfRevision({
          recoveryRevision: requestedRecoveryRevision,
          session: savedSession
        }).catch(() => undefined);
        return { queueLength, recoveryAvailable, session: savedSession };
      } catch (cause) {
        throw new RewriteSessionPersistenceError({ cause, recoverySaved: recoveryAvailable });
      }
    });
  }

  async function resolveConflict(
    conflict: RewriteRecoveryConflict,
    choice: "project" | "recovery"
  ): Promise<RewriteSession | null> {
    if (choice === "project") {
      if (conflict.recoveryRecord) {
        await discardRewriteRecoveryCopy(conflict.recoverySession);
      } else {
        await discardLegacyRewriteSession(conflict.recoverySession);
      }
      if (conflict.projectSession) {
        authoritativeRevision = conflict.projectSession.authoritative_revision;
      }
      return conflict.projectSession;
    }
    authoritativeRevision = conflict.projectSession?.authoritative_revision ?? 0;
    const recovered = {
      ...conflict.recoverySession,
      local_project_instance_id: localProjectInstanceId,
      authoritative_revision: authoritativeRevision,
      updated_at: new Date().toISOString()
    };
    const saved = await persist(recovered, "recover_newer_browser_rewrite_draft");
    if (conflict.recoveryRecord) {
      await discardRewriteRecoveryCopy(conflict.recoverySession).catch(() => undefined);
    } else {
      await discardLegacyRewriteSession(conflict.recoverySession).catch(() => undefined);
    }
    return saved.session;
  }

  async function commitApplied({
    comments,
    manifest,
    markdown,
    patches,
    session,
    versionId
  }: {
    comments: PatchmarkComment[];
    manifest: PatchmarkManifest;
    markdown: string;
    patches: PatchmarkPatch[];
    session: RewriteSession;
    versionId: string;
  }): Promise<RewriteTerminalSession> {
    const appliedAt = new Date().toISOString();
    await preserveRecovery(session).catch(() => undefined);
    const terminal = createTerminalSession({
      project,
      session,
      status: "applied",
      timestamp: appliedAt,
      versionId
    });
    return enqueue(async () => {
      const result = await saveProjectStateWithRewriteSessionRecord({
        comments,
        expectedRevision: authoritativeRevision,
        manifest,
        markdown,
        patches,
        project,
        reason: `human_rewrite:${session.rewrite_session_id}`,
        rewriteSessionRecord: terminal
      });
      const savedTerminal = result.record as RewriteTerminalSession;
      authoritativeRevision = savedTerminal.authoritative_revision;
      await discardRewriteRecoveryCopy(session).catch(() => undefined);
      return savedTerminal;
    });
  }

  async function discard(session: RewriteSession): Promise<RewriteTerminalSession> {
    const discardedAt = new Date().toISOString();
    const recoverySaved = await preserveRecovery(session)
      .then(() => true)
      .catch(() => false);
    const terminal = createTerminalSession({
      project,
      session,
      status: "discarded",
      timestamp: discardedAt
    });
    return enqueue(async () => {
      try {
        const result = await saveProjectStateWithRewriteSessionRecord({
          expectedRevision: authoritativeRevision,
          project,
          reason: `discard_human_rewrite:${session.rewrite_session_id}`,
          rewriteSessionRecord: terminal
        });
        const savedTerminal = result.record as RewriteTerminalSession;
        authoritativeRevision = savedTerminal.authoritative_revision;
        await discardRewriteRecoveryCopy(session).catch(() => undefined);
        return savedTerminal;
      } catch (cause) {
        throw new RewriteSessionPersistenceError({ cause, recoverySaved });
      }
    });
  }

  async function preserveRecovery(session: RewriteSession): Promise<void> {
    recoveryRevision += 1;
    await saveRewriteRecoveryCopy({
      basedOnAuthoritativeRevision: authoritativeRevision,
      recoveryRevision,
      session: {
        ...session,
        authoritative_revision: authoritativeRevision,
        local_project_instance_id: localProjectInstanceId
      }
    });
  }

  function enqueue<T>(operation: (queueLength: number) => Promise<T>): Promise<T> {
    queuedOperations += 1;
    const queueLength = queuedOperations;
    const run = saveQueue
      .catch(() => undefined)
      .then(() => operation(queueLength))
      .finally(() => {
        queuedOperations -= 1;
      });
    saveQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    commitApplied,
    discard,
    load,
    persist,
    resolveConflict
  };
}

function createTerminalSession({
  project,
  session,
  status,
  timestamp,
  versionId
}: {
  project: PatchmarkProjectHandle;
  session: RewriteSession;
  status: "applied" | "discarded";
  timestamp: string;
  versionId?: string;
}): RewriteTerminalSession {
  return {
    schema_version: 1,
    rewrite_session_id: session.rewrite_session_id,
    local_project_instance_id: session.local_project_instance_id,
    project_id: session.project_id,
    document_id: session.document_id,
    status,
    authoritative_revision: session.authoritative_revision,
    authoritative_generation: project.persistence.generation,
    human_draft_sha256: session.human_draft_sha256,
    updated_at: timestamp,
    ...(status === "applied" ? { applied_at: timestamp } : { discarded_at: timestamp }),
    ...(versionId ? { version_id: versionId } : {})
  };
}

function createConflict({
  kind,
  projectSession,
  recoveryRecord,
  recoverySession
}: {
  kind: RewriteRecoveryConflict["kind"];
  projectSession: RewriteSession;
  recoveryRecord: RewriteRecoveryRecord | null;
  recoverySession: RewriteSession;
}): RewriteRecoveryConflict {
  return {
    kind,
    projectSession,
    recoverySession,
    recoveryRecord,
    projectSavedAt: projectSession.updated_at,
    recoverySavedAt: recoveryRecord?.saved_at ?? recoverySession.updated_at
  };
}

function areSessionsEquivalent(left: RewriteSession, right: RewriteSession): boolean {
  return (
    left.base_text_sha256 === right.base_text_sha256 &&
    left.human_draft_sha256 === right.human_draft_sha256 &&
    left.intent_note === right.intent_note &&
    JSON.stringify(left.review_rounds) === JSON.stringify(right.review_rounds) &&
    JSON.stringify(left.reference_history) === JSON.stringify(right.reference_history)
  );
}

function getIdentity(project: PatchmarkProjectHandle) {
  const projectId = project.projectManifest?.project_id ?? project.manifest.project_id;
  const documentId = project.document?.document_id ?? project.manifest.document_id;
  if (!projectId || !documentId) {
    throw new Error("Patchmark document identity is incomplete.");
  }
  return { projectId, documentId };
}
