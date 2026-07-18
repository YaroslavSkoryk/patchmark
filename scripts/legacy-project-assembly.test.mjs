import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeLegacyProjectIdentityCompatibility,
  cleanupIncompleteLegacyProjectAssembly,
  createLegacyProjectAssemblyPlan,
  executeLegacyProjectAssembly,
  findLegacyProjectIdentityCollisions,
  inspectIncompleteLegacyProjectAssembly,
  inspectLegacyProjectAssemblySource
} from "../lib/project/legacy-project-assembly.ts";
import {
  convertLegacyProject,
  readProjectManifest
} from "../lib/project/multi-document-project.ts";
import {
  getProjectDocumentExportIdentity,
  listProjectVersions,
  openProjectDocument,
  openProjectFolderHandle,
  readProjectComments,
  readProjectPatches,
  readProjectVersionMarkdown,
  saveProjectState
} from "../lib/project/patchmark-project.ts";
import {
  NodeDirectoryHandle,
  createNodeHandleController
} from "./lib/node-directory-handle.mjs";

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "patchmark-legacy-assembly-")
);

try {
  await runSuccessfulAssemblyScenario();
  await runPlanValidationScenarios();
  await runSourceChangeScenario();
  await runRecoverableSourceScenario();
  await runTransactionFaultScenarios();
  await runWriteFailureScenarios();
  await runInterruptedRecoveryScenarios();
  await runLegacyConversionRegression();
  process.stdout.write(
    `${JSON.stringify({
      assembleTwoLegacyProjects: true,
      independentImportedReviewState: true,
      sourceImmutability: true,
      filenameCollisionResolution: true,
      documentLocalDuplicateIdentity: true,
      sameDocumentDuplicateRejected: true,
      invalidSecondSource: true,
      sourceChangeDetection: true,
      failureInjection: true,
      destinationPortability: true,
      destinationOnlyDeletion: true,
      documentSpecificExports: true,
      legacyConversionRegression: true,
      manifestLastCommit: true,
      provenanceWithoutAbsolutePaths: true,
      interruptedTransactionRecovery: true,
      recoverableSourceLastKnownGood: true
    }, null, 2)}\n`
  );
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

async function runSuccessfulAssemblyScenario() {
  const actionPath = path.join(temporaryRoot, "success-action");
  const researchPath = path.join(temporaryRoot, "success-research");
  const destinationPath = path.join(temporaryRoot, "success-destination");
  createLegacyFixture(actionPath, {
    idPrefix: "ACTION",
    marker: "ACTION_PLAN_UNIQUE_MARKER",
    title: "Crust Chant Action Plan",
    newline: "\r\n"
  });
  createLegacyFixture(researchPath, {
    idPrefix: "READY",
    marker: "READY_TO_EAT_UNIQUE_MARKER",
    title: "Ready-to-Eat Investigation",
    newline: "\n"
  });
  await commitLegacyFixture(researchPath);
  fs.mkdirSync(destinationPath);

  const sourceTreesBefore = new Map([
    [actionPath, snapshotTree(actionPath)],
    [researchPath, snapshotTree(researchPath)]
  ]);
  const action = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(actionPath),
    "Action Plan"
  );
  const research = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(researchPath),
    "Ready-to-Eat Investigation"
  );
  assert.equal(action.summary.comments, 2);
  assert.equal(action.summary.replies, 1);
  assert.equal(action.summary.patches, 2);
  assert.equal(action.summary.versions, 2);
  assert.equal(research.summary.saveGeneration, 1);
  assert.ok(action.summary.warnings.some((warning) => warning.includes("future_field")));
  assert.deepEqual(findLegacyProjectIdentityCollisions([action, research]), []);

  const writes = [];
  const destination = new NodeDirectoryHandle(
    destinationPath,
    createNodeHandleController({
      beforeWrite(filePath) {
        writes.push(path.relative(destinationPath, filePath));
      }
    })
  );
  const plan = await createLegacyProjectAssemblyPlan({
    destination,
    projectTitle: "Crust Chant",
    documents: [
      {
        source: action,
        destinationPath: "action-plan.md",
        displayTitle: "Action Plan",
        role: "decision"
      },
      {
        source: research,
        destinationPath: "research/ready-to-eat-investigation.md",
        displayTitle: "Ready-to-Eat Investigation",
        role: "research"
      }
    ]
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.entries), true);
  assert.equal(plan.manifest.documents.length, 2);
  assert.notEqual(
    plan.manifest.documents[0].document_id,
    plan.manifest.documents[1].document_id
  );
  assert.ok(plan.manifest.project_id.startsWith("prj_"));

  const stages = [];
  const result = await executeLegacyProjectAssembly(plan, {
    onStage(context) {
      stages.push(context.stage);
    }
  });
  assert.equal(result.manifest.project_id, plan.manifest.project_id);
  assert.equal(result.loaded.project.projectManifest.project_id, plan.manifest.project_id);
  assert.ok(stages.includes("manifest_committed"));
  assert.ok(stages.indexOf("verified") < stages.indexOf("manifest_committed"));
  const manifestWrite = writes.findIndex(
    (filePath) => filePath === path.join(".patchmark", "project.json")
  );
  const firstStoreWrite = writes.findIndex((filePath) =>
    filePath.includes(path.join(".patchmark", "documents"))
  );
  assert.ok(firstStoreWrite >= 0 && manifestWrite > firstStoreWrite);
  assert.deepEqual(await readProjectManifest(destination), plan.manifest);
  assert.equal(
    fs.readFileSync(path.join(destinationPath, "action-plan.md")).equals(
      fs.readFileSync(path.join(actionPath, "document.md"))
    ),
    true
  );
  assert.equal(
    fs.readFileSync(
      path.join(destinationPath, "research", "ready-to-eat-investigation.md")
    ).equals(fs.readFileSync(path.join(researchPath, "document.md"))),
    true
  );

  for (const [sourcePath, before] of sourceTreesBefore) {
    assert.deepEqual(snapshotTree(sourcePath), before);
  }
  for (const entry of plan.entries) {
    const storePath = path.join(
      destinationPath,
      ".patchmark",
      "documents",
      entry.document.document_id
    );
    assert.equal(
      fs.readFileSync(path.join(storePath, "comments.json")).equals(
        fs.readFileSync(
          path.join(entry.source.directoryHandle.path, ".patchmark", "comments.json")
        )
      ),
      true
    );
    const ownership = JSON.parse(
      fs.readFileSync(path.join(storePath, "document.json"), "utf8")
    );
    assert.equal(ownership.document_id, entry.document.document_id);
    assert.equal(ownership.source, "legacy-assembly");
    const provenanceText = fs.readFileSync(
      path.join(storePath, "import-provenance.json"),
      "utf8"
    );
    assert.equal(provenanceText.includes(temporaryRoot), false);
    assert.equal(provenanceText.includes("/Users/"), false);
  }

  const actionDocument = plan.entries[0].document;
  const researchDocument = plan.entries[1].document;
  const loadedAction = await openProjectDocument(
    result.loaded.project,
    actionDocument.document_id
  );
  const loadedResearch = await openProjectDocument(
    result.loaded.project,
    researchDocument.document_id
  );
  assert.match(loadedAction.markdown, /ACTION_PLAN_UNIQUE_MARKER/);
  assert.doesNotMatch(loadedAction.markdown, /READY_TO_EAT_UNIQUE_MARKER/);
  assert.match(loadedResearch.markdown, /READY_TO_EAT_UNIQUE_MARKER/);
  assert.doesNotMatch(loadedResearch.markdown, /ACTION_PLAN_UNIQUE_MARKER/);
  assert.deepEqual(
    (await readProjectComments(loadedAction.project)).map(({ id }) => id),
    ["PM-COMMENT-ACTION-OPEN", "PM-COMMENT-ACTION-RESOLVED"]
  );
  assert.deepEqual(
    (await readProjectPatches(loadedResearch.project)).map(({ id }) => id),
    ["PM-PATCH-READY-PENDING", "PM-PATCH-READY-ACCEPTED"]
  );
  assert.deepEqual(
    (await listProjectVersions(loadedAction.project)).map(({ id }) => id),
    ["snapshot-ACTION-1", "snapshot-ACTION-2"]
  );
  assert.equal(loadedAction.project.persistence.generation, 0);
  assert.equal(loadedResearch.project.persistence.generation, 1);
  assert.deepEqual(getProjectDocumentExportIdentity(loadedAction.project), {
    project_name: "Crust Chant",
    project_id: plan.manifest.project_id,
    document_file: "action-plan.md",
    document_id: actionDocument.document_id,
    document_title: "Action Plan",
    document_role: "decision"
  });
  assert.equal(
    getProjectDocumentExportIdentity(loadedResearch.project).document_id,
    researchDocument.document_id
  );

  const actionComments = await readProjectComments(loadedAction.project);
  const actionPatches = await readProjectPatches(loadedAction.project);
  await saveProjectState({
    comments: actionComments,
    markdown: `${loadedAction.markdown}\nDestination-only edit.\n`,
    patches: actionPatches,
    project: loadedAction.project,
    reason: "assembly_isolation_test"
  });
  for (const [sourcePath, before] of sourceTreesBefore) {
    assert.deepEqual(snapshotTree(sourcePath), before);
  }
  const researchAfterActionEdit = await openProjectDocument(
    loadedAction.project,
    researchDocument.document_id
  );
  assert.equal(researchAfterActionEdit.project.persistence.generation, 1);
  assert.doesNotMatch(researchAfterActionEdit.markdown, /Destination-only edit/);

  const portablePath = path.join(temporaryRoot, "success-portable-copy");
  fs.cpSync(destinationPath, portablePath, { recursive: true });
  const portable = await openProjectFolderHandle(new NodeDirectoryHandle(portablePath));
  assert.equal(portable.project.projectManifest.project_id, plan.manifest.project_id);
  const portableResearch = await openProjectDocument(
    portable.project,
    researchDocument.document_id
  );
  assert.match(portableResearch.markdown, /READY_TO_EAT_UNIQUE_MARKER/);

  fs.rmSync(destinationPath, { force: true, recursive: true });
  for (const [sourcePath, before] of sourceTreesBefore) {
    assert.deepEqual(snapshotTree(sourcePath), before);
    const source = await openProjectFolderHandle(
      new NodeDirectoryHandle(sourcePath),
      { readOnly: true }
    );
    assert.equal(source.project.projectMode, "legacy");
  }
}

async function runPlanValidationScenarios() {
  const validPath = path.join(temporaryRoot, "validation-valid");
  const otherPath = path.join(temporaryRoot, "validation-other");
  createLegacyFixture(validPath, {
    idPrefix: "VALID",
    marker: "VALID_MARKER",
    title: "Valid Source"
  });
  createLegacyFixture(otherPath, {
    idPrefix: "OTHER",
    marker: "OTHER_MARKER",
    title: "Other Source"
  });
  const valid = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(validPath)
  );
  const other = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(otherPath)
  );

  const duplicateDestinationPath = path.join(temporaryRoot, "duplicate-destination");
  fs.mkdirSync(duplicateDestinationPath);
  await assert.rejects(
    () =>
      createLegacyProjectAssemblyPlan({
        destination: new NodeDirectoryHandle(duplicateDestinationPath),
        projectTitle: "Duplicate",
        documents: [
          createDocumentRequest(valid, "one.md"),
          createDocumentRequest(valid, "two.md")
        ]
      }),
    /same source project/
  );

  const collisionAPath = path.join(temporaryRoot, "collision-a");
  const collisionBPath = path.join(temporaryRoot, "collision-b");
  createLegacyFixture(collisionAPath, {
    idPrefix: "COLLISION",
    marker: "COLLISION_A",
    title: "Collision A"
  });
  createLegacyFixture(collisionBPath, {
    idPrefix: "COLLISION",
    marker: "COLLISION_B",
    title: "Collision B"
  });
  const collisionBCommentsPath = path.join(
    collisionBPath,
    ".patchmark",
    "comments.json"
  );
  const collisionBComments = JSON.parse(
    fs.readFileSync(collisionBCommentsPath, "utf8")
  );
  collisionBComments[0].comment = "Collision B isolated comment";
  collisionBComments[0].thread[0].content = "Collision B isolated reply";
  fs.writeFileSync(
    collisionBCommentsPath,
    `${JSON.stringify(collisionBComments, null, 2)}\n`
  );
  const collisionA = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(collisionAPath),
    "Collision A"
  );
  const collisionB = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(collisionBPath),
    "Collision B"
  );
  const collisions = findLegacyProjectIdentityCollisions([
    collisionA,
    collisionB
  ]);
  assert.deepEqual(collisions, []);
  const identityAnalysis = analyzeLegacyProjectIdentityCompatibility([
    collisionA,
    collisionB
  ]);
  assert.ok(
    identityAnalysis.allowedDocumentLocalDuplicates.some(
      ({ namespace, id }) =>
        namespace === "comment" && id === "PM-COMMENT-COLLISION-OPEN"
    )
  );
  const collisionDestinationPath = path.join(
    temporaryRoot,
    "collision-destination"
  );
  fs.mkdirSync(collisionDestinationPath);
  const collisionPlan = await createLegacyProjectAssemblyPlan({
    destination: new NodeDirectoryHandle(collisionDestinationPath),
    projectTitle: "Collision",
    documents: [
      createDocumentRequest(collisionA, "a.md"),
      createDocumentRequest(collisionB, "b.md")
    ]
  });
  const collisionResult = await executeLegacyProjectAssembly(collisionPlan);
  const firstCollisionDocument = await openProjectDocument(
    collisionResult.loaded.project,
    collisionPlan.entries[0].document.document_id
  );
  const secondCollisionDocument = await openProjectDocument(
    collisionResult.loaded.project,
    collisionPlan.entries[1].document.document_id
  );
  const firstCollisionComments = await readProjectComments(
    firstCollisionDocument.project
  );
  const secondCollisionComments = await readProjectComments(
    secondCollisionDocument.project
  );
  assert.equal(firstCollisionComments[0].id, secondCollisionComments[0].id);
  assert.notEqual(
    firstCollisionComments[0].comment,
    secondCollisionComments[0].comment
  );
  assert.equal(
    firstCollisionComments[0].thread[0].id,
    secondCollisionComments[0].thread[0].id
  );
  assert.notEqual(
    firstCollisionComments[0].thread[0].content,
    secondCollisionComments[0].thread[0].content
  );
  const firstCollisionPatches = await readProjectPatches(
    firstCollisionDocument.project
  );
  const secondCollisionPatches = await readProjectPatches(
    secondCollisionDocument.project
  );
  assert.equal(firstCollisionPatches[0].id, secondCollisionPatches[0].id);
  assert.equal(
    firstCollisionPatches[0].comment_id,
    firstCollisionComments[0].id
  );
  assert.equal(
    secondCollisionPatches[0].comment_id,
    secondCollisionComments[0].id
  );
  await saveProjectState({
    patches: firstCollisionPatches.map((patch, index) =>
      index === 0 ? { ...patch, status: "rejected" } : patch
    ),
    project: firstCollisionDocument.project,
    reason: "duplicate_patch_document_scope"
  });
  assert.equal(
    (await readProjectPatches(firstCollisionDocument.project))[0].status,
    "rejected"
  );
  assert.equal(
    (await readProjectPatches(secondCollisionDocument.project))[0].status,
    "pending"
  );
  const firstCollisionVersions = await listProjectVersions(
    firstCollisionDocument.project
  );
  const secondCollisionVersions = await listProjectVersions(
    secondCollisionDocument.project
  );
  assert.equal(firstCollisionVersions[0].id, secondCollisionVersions[0].id);
  assert.notEqual(
    await readProjectVersionMarkdown(
      firstCollisionDocument.project,
      firstCollisionVersions[0]
    ),
    await readProjectVersionMarkdown(
      secondCollisionDocument.project,
      secondCollisionVersions[0]
    )
  );

  const sameDocumentDuplicatePath = path.join(
    temporaryRoot,
    "same-document-duplicate"
  );
  createLegacyFixture(sameDocumentDuplicatePath, {
    idPrefix: "SAME-DOCUMENT",
    marker: "SAME_DOCUMENT_DUPLICATE",
    title: "Same-document duplicate"
  });
  const duplicateCommentsPath = path.join(
    sameDocumentDuplicatePath,
    ".patchmark",
    "comments.json"
  );
  const duplicateComments = JSON.parse(
    fs.readFileSync(duplicateCommentsPath, "utf8")
  );
  duplicateComments[1].id = duplicateComments[0].id;
  fs.writeFileSync(
    duplicateCommentsPath,
    `${JSON.stringify(duplicateComments, null, 2)}\n`
  );
  await assert.rejects(
    () =>
      inspectLegacyProjectAssemblySource(
        new NodeDirectoryHandle(sameDocumentDuplicatePath)
      ),
    /Duplicate legacy comment ID/
  );

  const filenameDestinationPath = path.join(temporaryRoot, "filename-destination");
  fs.mkdirSync(filenameDestinationPath);
  await assert.rejects(() =>
    createLegacyProjectAssemblyPlan({
      destination: new NodeDirectoryHandle(filenameDestinationPath),
      projectTitle: "Filename collision",
      documents: [
        createDocumentRequest(valid, "document.md"),
        createDocumentRequest(other, "DOCUMENT.md")
      ]
    })
  );
  assert.equal(fs.readdirSync(filenameDestinationPath).length, 0);

  const nonEmptyPath = path.join(temporaryRoot, "non-empty-destination");
  fs.mkdirSync(nonEmptyPath);
  fs.writeFileSync(path.join(nonEmptyPath, "keep.txt"), "keep");
  await assert.rejects(
    () =>
      createLegacyProjectAssemblyPlan({
        destination: new NodeDirectoryHandle(nonEmptyPath),
        projectTitle: "Non-empty",
        documents: [
          createDocumentRequest(valid, "valid.md"),
          createDocumentRequest(other, "other.md")
        ]
      }),
    /must be empty/
  );
  assert.equal(fs.readFileSync(path.join(nonEmptyPath, "keep.txt"), "utf8"), "keep");

  const overlapSourcePath = path.join(temporaryRoot, "overlap-source");
  const overlapDestinationPath = path.join(overlapSourcePath, "destination");
  createLegacyFixture(overlapSourcePath, {
    idPrefix: "OVERLAP",
    marker: "OVERLAP_MARKER",
    title: "Overlap Source"
  });
  fs.mkdirSync(overlapDestinationPath);
  const overlap = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(overlapSourcePath)
  );
  await assert.rejects(
    () =>
      createLegacyProjectAssemblyPlan({
        destination: new NodeDirectoryHandle(overlapDestinationPath),
        projectTitle: "Overlap",
        documents: [
          createDocumentRequest(overlap, "overlap.md"),
          createDocumentRequest(other, "other.md")
        ]
      }),
    /must not overlap/
  );

  const invalidPath = path.join(temporaryRoot, "invalid-source");
  fs.mkdirSync(path.join(invalidPath, ".patchmark"), { recursive: true });
  fs.writeFileSync(path.join(invalidPath, "document.md"), "# Invalid\n");
  fs.writeFileSync(
    path.join(invalidPath, ".patchmark", "manifest.json"),
    "{invalid"
  );
  fs.writeFileSync(path.join(invalidPath, ".patchmark", "comments.json"), "[]\n");
  fs.writeFileSync(path.join(invalidPath, ".patchmark", "patches.json"), "[]\n");
  await assert.rejects(
    () =>
      inspectLegacyProjectAssemblySource(
        new NodeDirectoryHandle(invalidPath),
        "Invalid Source"
      ),
    /Invalid Source could not be imported/
  );
}

async function runSourceChangeScenario() {
  const fixture = await createAssemblyFixture("source-change");
  const beforeA = snapshotTree(fixture.sourceAPath);
  const beforeB = snapshotTree(fixture.sourceBPath);
  await assert.rejects(
    () =>
      executeLegacyProjectAssembly(fixture.plan, {
        onStage({ stage }) {
          if (stage === "staging") {
            fs.appendFileSync(
              path.join(fixture.sourceBPath, "document.md"),
              "\nChanged during assembly.\n"
            );
          }
        }
      }),
    /changed while it was being imported/
  );
  assertDestinationEmpty(fixture.destinationPath);
  assert.deepEqual(snapshotTree(fixture.sourceAPath), beforeA);
  assert.notDeepEqual(snapshotTree(fixture.sourceBPath), beforeB);
  assert.equal(await readProjectManifest(new NodeDirectoryHandle(fixture.destinationPath)), null);
}

async function runRecoverableSourceScenario() {
  const recoveryPath = path.join(temporaryRoot, "recoverable-source");
  const companionPath = path.join(temporaryRoot, "recoverable-companion");
  const destinationPath = path.join(temporaryRoot, "recoverable-destination");
  const original = createLegacyFixture(recoveryPath, {
    idPrefix: "RECOVERABLE",
    marker: "RECOVERABLE_LKG_MARKER",
    title: "Recoverable Source"
  });
  createLegacyFixture(companionPath, {
    idPrefix: "RECOVERY-COMPANION",
    marker: "RECOVERY_COMPANION_MARKER",
    title: "Recovery Companion"
  });
  await commitLegacyFixture(recoveryPath);
  fs.appendFileSync(
    path.join(recoveryPath, "document.md"),
    "\nQUESTIONABLE_CURRENT_MARKER\n"
  );
  fs.writeFileSync(
    path.join(recoveryPath, ".patchmark", "comments.json"),
    "{invalid-current-comments"
  );
  fs.mkdirSync(destinationPath);
  const sourceBefore = snapshotTree(recoveryPath);
  const recoverable = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(recoveryPath),
    "Recoverable Source"
  );
  const companion = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(companionPath),
    "Recovery Companion"
  );
  assert.ok(
    recoverable.summary.warnings.some((warning) =>
      warning.includes("last-known-good generation")
    )
  );
  const plan = await createLegacyProjectAssemblyPlan({
    destination: new NodeDirectoryHandle(destinationPath),
    projectTitle: "Recovered Assembly",
    documents: [
      createDocumentRequest(recoverable, "recovered.md"),
      createDocumentRequest(companion, "companion.md")
    ]
  });
  const result = await executeLegacyProjectAssembly(plan);
  const loaded = await openProjectDocument(
    result.loaded.project,
    plan.entries[0].document.document_id
  );
  assert.equal(Buffer.from(loaded.markdown).equals(original.markdown), true);
  assert.doesNotMatch(loaded.markdown, /QUESTIONABLE_CURRENT_MARKER/);
  assert.equal(loaded.recovery, undefined);
  const questionableCopy = fs.readFileSync(
    path.join(
      destinationPath,
      ".patchmark",
      "documents",
      plan.entries[0].document.document_id,
      "recovery",
      "imported-questionable-current",
      "document.md"
    ),
    "utf8"
  );
  assert.match(questionableCopy, /QUESTIONABLE_CURRENT_MARKER/);
  assert.deepEqual(snapshotTree(recoveryPath), sourceBefore);
}

async function runTransactionFaultScenarios() {
  for (const stage of [
    "preflight",
    "staging",
    "before_source_copy",
    "source_copied",
    "verified",
    "manifest_committed",
    "reopened",
    "sources_verified",
    "complete"
  ]) {
    const fixture = await createAssemblyFixture(`fault-${stage}`);
    const beforeA = snapshotTree(fixture.sourceAPath);
    const beforeB = snapshotTree(fixture.sourceBPath);
    await assert.rejects(
      () =>
        executeLegacyProjectAssembly(fixture.plan, {
          onStage(context) {
            if (context.stage === stage) {
              throw new Error(`simulated ${stage} failure`);
            }
          }
        }),
      new RegExp(`simulated ${stage} failure`)
    );
    assertDestinationEmpty(fixture.destinationPath);
    assert.deepEqual(snapshotTree(fixture.sourceAPath), beforeA);
    assert.deepEqual(snapshotTree(fixture.sourceBPath), beforeB);
    assert.equal(await readProjectManifest(new NodeDirectoryHandle(fixture.destinationPath)), null);
  }
}

async function runWriteFailureScenarios() {
  const creationFailure = await createAssemblyFixture("destination-create-failure");
  const createDirectory = creationFailure.plan.destination.getDirectoryHandle.bind(
    creationFailure.plan.destination
  );
  creationFailure.plan.destination.getDirectoryHandle = async (name, options) => {
    if (name === ".patchmark" && options?.create) {
      throw new Error("simulated destination creation failure");
    }
    return createDirectory(name, options);
  };
  await assert.rejects(
    () => executeLegacyProjectAssembly(creationFailure.plan),
    /destination creation failure/
  );
  assertDestinationEmpty(creationFailure.destinationPath);

  for (const failure of ["markdown", "first-store", "second-store", "manifest"]) {
    const fixture = await createAssemblyFixture(`write-${failure}`, failure);
    await assert.rejects(
      () => executeLegacyProjectAssembly(fixture.plan),
      new RegExp(`simulated ${failure} write failure`)
    );
    assertDestinationEmpty(fixture.destinationPath);
    assert.equal(await readProjectManifest(new NodeDirectoryHandle(fixture.destinationPath)), null);
  }

  const verification = await createAssemblyFixture("verification-corruption");
  await assert.rejects(
    () =>
      executeLegacyProjectAssembly(verification.plan, {
        onStage({ stage, sourceLabel, documentId }) {
          if (stage === "source_copied" && sourceLabel?.endsWith("Source B")) {
            fs.appendFileSync(
              path.join(
                verification.destinationPath,
                ".patchmark",
                "documents",
                documentId,
                "comments.json"
              ),
              "corrupt"
            );
          }
        }
      }),
    /metadata comments.json was not copied byte-for-byte/
  );
  assertDestinationEmpty(verification.destinationPath);

  const reopen = await createAssemblyFixture("reopen-failure");
  await assert.rejects(
    () =>
      executeLegacyProjectAssembly(reopen.plan, {
        onStage({ stage }) {
          if (stage === "manifest_committed") {
            const documentId = reopen.plan.entries[0].document.document_id;
            fs.writeFileSync(
              path.join(
                reopen.destinationPath,
                ".patchmark",
                "documents",
                documentId,
                "document.json"
              ),
              '{"document_id":"wrong"}\n'
            );
          }
        }
      }),
    /ownership mismatch/
  );
  assertDestinationEmpty(reopen.destinationPath);
}

async function runInterruptedRecoveryScenarios() {
  const stagedPath = path.join(temporaryRoot, "interrupted-staging");
  const stagedDocumentId = "doc_interrupted";
  const stagedTransaction = path.join(
    stagedPath,
    ".patchmark",
    "transactions",
    "assembly_interrupted"
  );
  fs.mkdirSync(stagedTransaction, { recursive: true });
  fs.mkdirSync(
    path.join(stagedPath, ".patchmark", "documents", stagedDocumentId),
    { recursive: true }
  );
  fs.writeFileSync(path.join(stagedPath, "action.md"), "# Interrupted\n");
  fs.writeFileSync(
    path.join(
      stagedPath,
      ".patchmark",
      "documents",
      stagedDocumentId,
      "comments.json"
    ),
    "[]\n"
  );
  fs.writeFileSync(
    path.join(stagedTransaction, "assembly.json"),
    `${JSON.stringify({
      format: "patchmark-legacy-assembly-transaction",
      schema_version: 1,
      assembly_id: "assembly_interrupted",
      destination_project_id: "prj_interrupted",
      destination_title: "Interrupted",
      stage: "source_copied",
      updated_at: "2026-07-17T00:00:00.000Z",
      documents: [
        {
          destination_document_id: stagedDocumentId,
          destination_path: "action.md"
        }
      ]
    }, null, 2)}\n`
  );
  const stagedRoot = new NodeDirectoryHandle(stagedPath);
  const detected = await inspectIncompleteLegacyProjectAssembly(stagedRoot);
  assert.equal(detected?.assemblyId, "assembly_interrupted");
  assert.equal(detected?.canCleanSafely, true);
  fs.writeFileSync(path.join(stagedPath, "keep.txt"), "unexpected");
  assert.equal(
    (await inspectIncompleteLegacyProjectAssembly(stagedRoot))?.canCleanSafely,
    false
  );
  await assert.rejects(
    () => cleanupIncompleteLegacyProjectAssembly(stagedRoot),
    /unexpected files/
  );
  fs.rmSync(path.join(stagedPath, "keep.txt"));
  await cleanupIncompleteLegacyProjectAssembly(stagedRoot);
  assertDestinationEmpty(stagedPath);

  const valid = await createAssemblyFixture("interrupted-valid-commit");
  await executeLegacyProjectAssembly(valid.plan);
  writePendingAssemblyJournal(valid.destinationPath, valid.plan);
  const reopened = await openProjectFolderHandle(
    new NodeDirectoryHandle(valid.destinationPath)
  );
  assert.equal(
    reopened.project.projectManifest.project_id,
    valid.plan.manifest.project_id
  );
  assert.equal(
    fs.existsSync(
      path.join(
        valid.destinationPath,
        ".patchmark",
        "transactions",
        valid.plan.assemblyId
      )
    ),
    false
  );

  const invalid = await createAssemblyFixture("interrupted-invalid-commit");
  await executeLegacyProjectAssembly(invalid.plan);
  writePendingAssemblyJournal(invalid.destinationPath, invalid.plan);
  fs.writeFileSync(
    path.join(
      invalid.destinationPath,
      ".patchmark",
      "documents",
      invalid.plan.entries[0].document.document_id,
      "document.json"
    ),
    '{"document_id":"wrong"}\n'
  );
  await assert.rejects(
    () =>
      openProjectFolderHandle(new NodeDirectoryHandle(invalid.destinationPath)),
    /marked incomplete/
  );
  assert.equal(
    await readProjectManifest(new NodeDirectoryHandle(invalid.destinationPath)),
    null
  );
}

async function runLegacyConversionRegression() {
  const sourcePath = path.join(temporaryRoot, "conversion-regression");
  const expected = createLegacyFixture(sourcePath, {
    idPrefix: "CONVERT",
    marker: "CONVERSION_MARKER",
    title: "Conversion Regression"
  });
  const before = snapshotTree(sourcePath);
  const root = new NodeDirectoryHandle(sourcePath);
  const stages = [];
  const result = await convertLegacyProject({
    projectTitle: "Conversion Regression",
    root,
    onStage(stage) {
      stages.push(stage);
    }
  });
  assert.equal(result.manifest.documents.length, 1);
  assert.ok(stages.indexOf("document_store_committed") < stages.indexOf("manifest_committed"));
  assert.equal(
    fs.readFileSync(path.join(sourcePath, "document.md")).equals(expected.markdown),
    true
  );
  const after = snapshotTree(sourcePath);
  for (const [relativePath, hash] of before) {
    assert.equal(after.get(relativePath), hash);
  }
}

async function createAssemblyFixture(name, writeFailure) {
  const sourceAPath = path.join(temporaryRoot, `${name}-source-a`);
  const sourceBPath = path.join(temporaryRoot, `${name}-source-b`);
  const destinationPath = path.join(temporaryRoot, `${name}-destination`);
  createLegacyFixture(sourceAPath, {
    idPrefix: `${name.toUpperCase()}-A`,
    marker: `${name}_A_MARKER`,
    title: `${name} Source A`
  });
  createLegacyFixture(sourceBPath, {
    idPrefix: `${name.toUpperCase()}-B`,
    marker: `${name}_B_MARKER`,
    title: `${name} Source B`
  });
  fs.mkdirSync(destinationPath);
  const sourceA = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(sourceAPath),
    `${name} Source A`
  );
  const sourceB = await inspectLegacyProjectAssemblySource(
    new NodeDirectoryHandle(sourceBPath),
    `${name} Source B`
  );
  const documentIds = [];
  const destination = new NodeDirectoryHandle(
    destinationPath,
    createNodeHandleController({
      beforeWrite(filePath) {
        const relativePath = path.relative(destinationPath, filePath);
        if (writeFailure === "markdown" && relativePath === "a.md") {
          throw new Error("simulated markdown write failure");
        }
        if (
          writeFailure === "first-store" &&
          documentIds[0] &&
          relativePath === path.join(".patchmark", "documents", documentIds[0], "comments.json")
        ) {
          throw new Error("simulated first-store write failure");
        }
        if (
          writeFailure === "second-store" &&
          documentIds[1] &&
          relativePath === path.join(".patchmark", "documents", documentIds[1], "comments.json")
        ) {
          throw new Error("simulated second-store write failure");
        }
        if (
          writeFailure === "manifest" &&
          relativePath === path.join(".patchmark", "project.json")
        ) {
          throw new Error("simulated manifest write failure");
        }
      }
    })
  );
  const plan = await createLegacyProjectAssemblyPlan({
    destination,
    projectTitle: name,
    documents: [
      createDocumentRequest(sourceA, "a.md"),
      createDocumentRequest(sourceB, "b.md")
    ]
  });
  documentIds.push(...plan.entries.map((entry) => entry.document.document_id));
  return { destinationPath, plan, sourceAPath, sourceBPath };
}

function createLegacyFixture(
  projectPath,
  { idPrefix, marker, title, newline = "\n" }
) {
  const metadataPath = path.join(projectPath, ".patchmark");
  const versionsPath = path.join(metadataPath, "versions");
  const importsPath = path.join(metadataPath, "imports");
  fs.mkdirSync(versionsPath, { recursive: true });
  fs.mkdirSync(importsPath, { recursive: true });
  const markdownText = [
    `# ${title}`,
    "",
    marker,
    "",
    "Identical selected text appears in every fixture.",
    ""
  ].join(newline);
  const markdown = Buffer.from(markdownText, "utf8");
  const now = "2026-07-17T00:00:00.000Z";
  const openCommentId = `PM-COMMENT-${idPrefix}-OPEN`;
  const resolvedCommentId = `PM-COMMENT-${idPrefix}-RESOLVED`;
  const pendingPatchId = `PM-PATCH-${idPrefix}-PENDING`;
  const acceptedPatchId = `PM-PATCH-${idPrefix}-ACCEPTED`;
  const comments = [
    {
      id: openCommentId,
      type: "question",
      status: "open",
      anchor: {
        kind: "selected_text",
        selected_text: "Identical selected text",
        markdown_start_offset: markdownText.indexOf("Identical selected text"),
        markdown_end_offset:
          markdownText.indexOf("Identical selected text") +
          "Identical selected text".length,
        anchor_source: "markdown"
      },
      comment: `${idPrefix} open comment`,
      thread: [
        {
          id: `PM-THREAD-${idPrefix}-1`,
          role: "chatgpt",
          content: `${idPrefix} reply`,
          created_at: now,
          source_import_id: `PM-IMPORT-${idPrefix}`,
          source_patch_id: acceptedPatchId
        }
      ],
      export_state: { focus_state: "in_focus" },
      anchor_history: [
        {
          format_version: 2,
          history_id: `PM-HISTORY-${idPrefix}-1`,
          changed_at: now,
          reason: "anchor_reanchored_by_human",
          cause: "human_reanchor",
          source_patch_id: acceptedPatchId,
          previous: { kind: "selected_text", start: 0, end: 4 },
          next: { kind: "selected_text", start: 5, end: 9 }
        }
      ],
      patch_impacts: [
        {
          patch_id: acceptedPatchId,
          impacted_at: now,
          impact_kind: "offset_shifted_after_patch",
          result: "offset_shifted"
        }
      ],
      created_at: now,
      updated_at: now,
      future_field: { preserve: marker }
    },
    {
      id: resolvedCommentId,
      type: "decision_needed",
      status: "resolved",
      anchor: { kind: "document" },
      comment: `${idPrefix} resolved comment`,
      thread: [],
      export_state: { focus_state: "idle" },
      created_at: now,
      updated_at: now,
      resolved_at: now
    }
  ];
  const patches = [
    {
      id: pendingPatchId,
      status: "pending",
      patch_group_id: `PM-PATCH-GROUP-${idPrefix}`,
      patch_group_index: 1,
      patch_group_total: 2,
      comment_id: openCommentId,
      source_import_id: `PM-IMPORT-${idPrefix}`,
      original_text: "Identical selected text",
      suggested_text: `${idPrefix} pending suggestion`,
      reason: "Pending fixture proposal",
      created_at: now,
      future_field: marker
    },
    {
      id: acceptedPatchId,
      status: "accepted",
      patch_group_id: `PM-PATCH-GROUP-${idPrefix}`,
      patch_group_index: 2,
      patch_group_total: 2,
      comment_id: resolvedCommentId,
      source_import_id: `PM-IMPORT-${idPrefix}`,
      original_text: marker,
      suggested_text: `${marker}_ACCEPTED`,
      reason: "Accepted fixture proposal",
      created_at: now,
      resolved_at: now,
      accepted_at: now,
      applied_at: now,
      pre_apply_snapshot_id: `snapshot-${idPrefix}-1`,
      pre_apply_snapshot_file: `.patchmark/versions/snapshot-${idPrefix}-1.md`
    }
  ];
  const versionOne = Buffer.from(`# ${title}${newline}${newline}${marker}${newline}`);
  const versionTwo = markdown;
  const manifest = {
    schema_version: 1,
    project_name: title,
    document_file: "document.md",
    created_at: now,
    updated_at: now,
    current_version: `snapshot-${idPrefix}-2`,
    versions: [
      {
        id: `snapshot-${idPrefix}-1`,
        file: `.patchmark/versions/snapshot-${idPrefix}-1.md`,
        created_at: now,
        reason: "baseline",
        content_hash: sha256(versionOne)
      },
      {
        id: `snapshot-${idPrefix}-2`,
        file: `.patchmark/versions/snapshot-${idPrefix}-2.md`,
        created_at: now,
        reason: "reviewed",
        content_hash: sha256(versionTwo)
      }
    ],
    future_manifest_field: marker
  };
  fs.writeFileSync(path.join(projectPath, "document.md"), markdown);
  fs.writeFileSync(
    path.join(metadataPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(metadataPath, "comments.json"),
    `${JSON.stringify(comments, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(metadataPath, "patches.json"),
    `${JSON.stringify(patches, null, 2)}\n`
  );
  fs.writeFileSync(path.join(metadataPath, "tasks.json"), "[]\n");
  fs.writeFileSync(
    path.join(versionsPath, `snapshot-${idPrefix}-1.md`),
    versionOne
  );
  fs.writeFileSync(
    path.join(versionsPath, `snapshot-${idPrefix}-2.md`),
    versionTwo
  );
  fs.writeFileSync(
    path.join(importsPath, `import-${idPrefix}.json`),
    `${JSON.stringify({ id: `PM-IMPORT-${idPrefix}`, marker })}\n`
  );
  return { markdown };
}

async function commitLegacyFixture(projectPath) {
  const loaded = await openProjectFolderHandle(new NodeDirectoryHandle(projectPath));
  await saveProjectState({
    comments: await readProjectComments(loaded.project),
    markdown: `${loaded.markdown}\nCommitted fixture generation.\n`,
    patches: await readProjectPatches(loaded.project),
    project: loaded.project,
    reason: "fixture_committed_generation"
  });
}

function createDocumentRequest(source, destinationPath) {
  return {
    source,
    destinationPath,
    displayTitle: source.summary.suggestedDisplayTitle,
    role: null
  };
}

function snapshotTree(rootPath) {
  const snapshot = new Map();
  walk(rootPath, "");
  return snapshot;

  function walk(directoryPath, prefix) {
    for (const entry of fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, "directory");
        walk(entryPath, relativePath);
      } else {
        snapshot.set(relativePath, sha256(fs.readFileSync(entryPath)));
      }
    }
  }
}

function assertDestinationEmpty(destinationPath) {
  assert.deepEqual(fs.readdirSync(destinationPath), []);
}

function writePendingAssemblyJournal(destinationPath, plan) {
  const transactionPath = path.join(
    destinationPath,
    ".patchmark",
    "transactions",
    plan.assemblyId
  );
  fs.mkdirSync(transactionPath, { recursive: true });
  fs.writeFileSync(
    path.join(transactionPath, "assembly.json"),
    `${JSON.stringify({
      format: "patchmark-legacy-assembly-transaction",
      schema_version: 1,
      assembly_id: plan.assemblyId,
      destination_project_id: plan.manifest.project_id,
      destination_title: plan.manifest.title,
      stage: "manifest_committed",
      updated_at: new Date().toISOString(),
      documents: plan.entries.map((entry) => ({
        destination_document_id: entry.document.document_id,
        destination_path: entry.document.path
      }))
    }, null, 2)}\n`
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
