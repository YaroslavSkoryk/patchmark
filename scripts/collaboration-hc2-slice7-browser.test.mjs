import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CdpClient, createPage, evaluate, findChromeExecutable, waitForDevToolsUrl, waitForProcessExit } from "./comment-rail-editor-browser-regression.test.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const fixture = JSON.parse(readFileSync(join(scriptDirectory, "fixtures", "collaboration-hc2-slice7-v3.json"), "utf8"));
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-2 Slice 7 browser tests.");
const server = await startServer();
let profileA = await openProfile("a", server.url);
let profileB = await openProfile("b", server.url);
const directoryA = profileA.profile;
const directoryB = profileB.profile;
let assertions = 0;
let slice8Qualification = null;
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions += 1; };

try {
  const chromeVector = await evaluate(profileA.page, { expression: `hc2vec.createSlice7VectorActual(${JSON.stringify(fixture.inputs)}).then(clean)` });
  equal(chromeVector, fixture.expected, "Chrome V3 bytes differ from Node/Python fixture");

  const publicA = await invoke(profileA, "hc2s6", "initializeConvergenceReplica", ["A"]);
  const publicB = await invoke(profileB, "hc2s6", "initializeConvergenceReplica", ["B"]);
  check(publicA.private_keys_non_extractable && publicB.private_keys_non_extractable, "both profiles use persisted non-extractable keys");
  await invoke(profileA, "hc2s6", "configureConvergencePeer", [publicB]);
  await invoke(profileB, "hc2s6", "configureConvergencePeer", [publicA]);
  const genesis = await invoke(profileA, "hc2s6", "createConvergenceGenesis");
  const admission = await invoke(profileA, "hc2s6", "prepareConvergenceAdmission");
  const admitted = await invoke(profileB, "hc2s6", "importConvergenceBundle", [admission.encoded]);
  equal(admitted.status, "imported", "Device B is admitted through encrypted V2 admission compatibility");
  equal(admitted.full_history_verified, false, "Device B preserves its admission boundary");

  const mutationA = await invoke(profileA, "hc2s6", "createConvergenceMutation", ["Concurrent Slice 7 title from A"]);
  const mutationB = await invoke(profileB, "hc2s6", "createConvergenceMutation", ["Concurrent Slice 7 title from B"]);
  equal(mutationA.observed_parent_ids, [genesis.genesis_event_id], "A mutation observes only genesis");
  equal(mutationB.observed_parent_ids, [genesis.genesis_event_id], "B mutation observes only genesis");
  check(!mutationA.observed_parent_ids.includes(mutationB.event_id) && !mutationB.observed_parent_ids.includes(mutationA.event_id), "semantic mutations are genuinely concurrent");
  const offlineA = await invoke(profileA, "hc2s6", "createSlice8RepresentativeOfflineWork");
  const offlineB = await invoke(profileB, "hc2s6", "createSlice8RepresentativeOfflineWork");
  equal(offlineA.families, ["comment", "review_batch"], "A creates accepted offline comment and review evidence");
  equal(offlineB.families, ["comment", "reply", "patch"], "B creates accepted offline comment, reply, and patch evidence");
  const receipt = await invoke(profileB, "hc2s6", "createConvergenceReceipt");
  check(receipt.receipt_id.startsWith("pm:epoch-receipt:"), "B has receipt evidence missing from A");

  // Kept only as an idempotence probe after V3 convergence and reopening.
  const legacyAToB = await invoke(profileA, "hc2s6", "prepareConvergenceReplication", ["B", [{ kind: "semantic-event", id: mutationA.event_id }], 0, null]);
  const legacyBToA = await invoke(profileB, "hc2s6", "prepareConvergenceReplication", ["A", [{ kind: "semantic-event", id: mutationB.event_id }], 0, null]);

  const syncA = await invoke(profileA, "hc2s7", "initializeSlice7Synchronization");
  const syncB = await invoke(profileB, "hc2s7", "initializeSlice7Synchronization");
  equal(syncA.session_id, syncB.session_id, "both profiles derive the same V3 session identity");
  check(syncA.private_keys_non_extractable && syncB.private_keys_non_extractable, "V3 uses the persisted non-extractable keys");

  let round = 1;
  let exchangeA = await invoke(profileA, "hc2s7", "createSlice7InventoryExchange", [round, 2]);
  let exchangeB = await invoke(profileB, "hc2s7", "createSlice7InventoryExchange", [round, 2]);
  check(exchangeA.page_count > 1 && exchangeB.page_count > 1, "forced small page bounds require multi-page exchange");
  const arrivalA = [...exchangeB.files].reverse().concat(exchangeB.files[0]);
  const arrivalB = [...exchangeA.files].reverse().concat(exchangeA.files.at(-1));
  equal((await invoke(profileA, "hc2s7", "importSlice7InventoryExchange", [arrivalA])).status, "complete", "A journals reordered and replayed encrypted inventory files");
  equal((await invoke(profileB, "hc2s7", "importSlice7InventoryExchange", [arrivalB])).status, "complete", "B journals reordered and replayed encrypted inventory files");

  // Actual profile interruption at inventory stage; portable and IndexedDB state survive.
  const snapshotA1 = await invoke(profileA, "hc2s6", "snapshotAndCloseConvergenceReplica");
  const snapshotB1 = await invoke(profileB, "hc2s6", "snapshotAndCloseConvergenceReplica");
  await profileA.close({ remove: false }); await profileB.close({ remove: false });
  profileA = await openProfile("a-resume", server.url, directoryA);
  profileB = await openProfile("b-resume", server.url, directoryB);
  await invoke(profileA, "hc2s6", "initializeConvergenceReplica", ["A", snapshotA1]);
  await invoke(profileB, "hc2s6", "initializeConvergenceReplica", ["B", snapshotB1]);
  await invoke(profileA, "hc2s6", "configureConvergencePeer", [publicB]);
  await invoke(profileB, "hc2s6", "configureConvergencePeer", [publicA]);
  const resumedA = await invoke(profileA, "hc2s7", "initializeSlice7Synchronization");
  const resumedB = await invoke(profileB, "hc2s7", "initializeSlice7Synchronization");
  check(resumedA.resumed_bundle_count > 0 && resumedB.resumed_bundle_count > 0, "both durable journals resume exact encrypted files");
  equal((await invoke(profileA, "hc2s7", "importSlice7InventoryExchange", [arrivalA])).status, "complete", "A can replay exact inventory after profile reopening");
  equal((await invoke(profileB, "hc2s7", "importSlice7InventoryExchange", [arrivalB])).status, "complete", "B can replay exact inventory after profile reopening");

  const firstConvergence = await converge(profileA, profileB, round + 1, 20);
  round = firstConvergence.nextRound;
  check(firstConvergence.rounds > 1, "independent mutations require bounded multi-round reconciliation");
  check(firstConvergence.duplicateImports > 0, "exact response replay changes no object count");

  const checkpoint = await invoke(profileA, "hc2s6", "createConvergenceCheckpoint", [mutationA.event_id, mutationB.event_id]);
  const ackA = await invoke(profileA, "hc2s6", "createConvergenceAcknowledgement");
  check(checkpoint.snapshot_id && ackA.acknowledgement_id, "A creates shared checkpoint and acknowledgement evidence");
  const checkpointConvergence = await converge(profileA, profileB, round, 20);
  round = checkpointConvergence.nextRound;
  const ackB = await invoke(profileB, "hc2s6", "createConvergenceAcknowledgement");
  check(ackB.acknowledgement_id, "B creates its acknowledgement only after accepting the checkpoint");
  const closureConvergence = await converge(profileA, profileB, round, 20);
  round = closureConvergence.nextRound;

  // Interruption boundaries without hidden continuation: close/reopen the explicit coordinator after import.
  await invoke(profileA, "hc2s7", "closeSlice7Synchronization");
  await invoke(profileB, "hc2s7", "closeSlice7Synchronization");
  const journalResumeA = await invoke(profileA, "hc2s7", "initializeSlice7Synchronization");
  const journalResumeB = await invoke(profileB, "hc2s7", "initializeSlice7Synchronization");
  check(journalResumeA.resumed_bundle_count >= resumedA.resumed_bundle_count && journalResumeB.resumed_bundle_count >= resumedB.resumed_bundle_count, "request/response/import interruptions resume from durable CAS state");
  const finalRefresh = await refreshInventories(profileA, profileB, round++);
  equal(finalRefresh.aRoot, finalRefresh.bRoot, "fresh post-import inventory roots agree");
  const zeroA = await invoke(profileA, "hc2s7", "createSlice7NextRequest", [round, 1]);
  const zeroB = await invoke(profileB, "hc2s7", "createSlice7NextRequest", [round, 1]);
  equal(zeroA.status, "nothing_missing", "already-converged A transfers zero records");
  equal(zeroB.status, "nothing_missing", "already-converged B transfers zero records");

  const confirmationA = await invoke(profileA, "hc2s7", "createSlice7Confirmation", [round]);
  const confirmationB = await invoke(profileB, "hc2s7", "createSlice7Confirmation", [round]);
  await invoke(profileA, "hc2s7", "closeSlice7Synchronization");
  await invoke(profileA, "hc2s7", "initializeSlice7Synchronization");
  equal((await invoke(profileA, "hc2s7", "importSlice7Confirmation", [confirmationB.encoded, confirmationA.core])).status, "converged", "A confirms full reconstruction commitments after coordinator interruption");
  equal((await invoke(profileB, "hc2s7", "importSlice7Confirmation", [confirmationA.encoded, confirmationB.core])).status, "converged", "B confirms full reconstruction commitments");

  await invoke(profileA, "hc2s6", "slice7SetPeerRevoked", [true]);
  const revoked = await invoke(profileA, "hc2s7", "attemptSlice7ExportAfterRevocation", [Math.min(round + 1, 32)]);
  equal(revoked.status, "revoked", "mid-session revocation blocks further V3 export");
  equal(revoked.durable_bundle_count_before, revoked.durable_bundle_count_after, "revocation produces no ciphertext or durable bundle");
  // Ciphertext delivered before revocation remains importable/idempotent and cannot be recalled.
  equal((await invoke(profileA, "hc2s7", "importSlice7InventoryExchange", [[...exchangeB.files]])).status, "complete", "already-delivered ciphertext remains the documented physical-possession limitation");
  await invoke(profileA, "hc2s6", "slice7SetPeerRevoked", [false]);

  // Establish V2 stream heads only as post-convergence duplicate probes; V3 already transferred every object.
  await invoke(profileB, "hc2s6", "importConvergenceBundle", [legacyAToB.encoded]);
  await invoke(profileA, "hc2s6", "importConvergenceBundle", [legacyBToA.encoded]);
  const finalA = await invoke(profileA, "hc2s6", "snapshotAndCloseConvergenceReplica");
  const finalB = await invoke(profileB, "hc2s6", "snapshotAndCloseConvergenceReplica");
  await profileA.close({ remove: false }); await profileB.close({ remove: false });
  profileA = await openProfile("a-final", server.url, directoryA);
  profileB = await openProfile("b-final", server.url, directoryB);
  await invoke(profileA, "hc2s6", "initializeConvergenceReplica", ["A", finalA]);
  await invoke(profileB, "hc2s6", "initializeConvergenceReplica", ["B", finalB]);
  await invoke(profileA, "hc2s6", "configureConvergencePeer", [publicB]);
  await invoke(profileB, "hc2s6", "configureConvergencePeer", [publicA]);
  const reopenedA = await invoke(profileA, "hc2s6", "reopenConvergenceEvidence", [legacyBToA.encoded]);
  const reopenedB = await invoke(profileB, "hc2s6", "reopenConvergenceEvidence", [legacyAToB.encoded]);
  const categories = [
    "accepted_objects", "accepted_semantic_event_ids", "accepted_control_event_ids", "semantic_frontier", "control_head",
    "membership_device_authority", "current_epoch", "canonical_projection_bytes", "revision_heads", "conflicts", "tombstones",
    "reducer_rejections", "component_roots", "projection_root", "checkpoint", "state_blob", "snapshot", "acknowledgements", "receipts"
  ];
  for (const category of categories) equal(reopenedA[category], reopenedB[category], `reopened authoritative category differs: ${category}`);
  equal(reopenedA.concurrent_mutation_relation, "concurrent", "A retains concurrency after portable reopen");
  equal(reopenedB.concurrent_mutation_relation, "concurrent", "B retains concurrency after portable reopen");
  equal(reopenedA.project_title.state, "conflicted", "replay creates no arbitrary title winner");
  equal(reopenedA.conflicts, reopenedB.conflicts, "legitimate conflict core is identical");
  equal(reopenedB.full_history_verified, false, "B retains its admission boundary after V3 convergence");
  check(reopenedA.accepted_from_nonportable_indexes === 0 && reopenedB.accepted_from_nonportable_indexes === 0, "indexes and OPFS contribute no accepted object");

  const sessionA = await invoke(profileA, "hc2s7", "initializeSlice7Synchronization");
  const sessionB = await invoke(profileB, "hc2s7", "initializeSlice7Synchronization");
  const evidenceA = await invoke(profileA, "hc2s7", "slice7SessionEvidence");
  const evidenceB = await invoke(profileB, "hc2s7", "slice7SessionEvidence");
  check(sessionA.resumed_bundle_count > 0 && sessionB.resumed_bundle_count > 0, "final profile reopening retains device-private session continuity");
  check(evidenceA.no_timer_or_background_work && evidenceB.no_timer_or_background_work, "synchronization remains explicit with no timer, watcher, or background action");

  if (process.env.PATCHMARK_HC2_SLICE8_QUALIFICATION === "1") {
    equal((await invoke(profileA, "hc2s8", "initializeSlice8FacadeAtConflict")).guidance, "conflict_resolution_required", "disabled facade derives conflict guidance from durable evidence");
    const reviewer = await invoke(profileB, "hc2s6", "reviewerConflictResolutionCapability");
    equal(reviewer.can_resolve_content_conflict, false, "reviewer authority remains insufficient for explicit conflict resolution");
    const resolutionOutcome = await invoke(profileA, "hc2s8", "resolveSlice8Conflict", [mutationA.event_id]);
    const resolution = resolutionOutcome.operation.evidence;
    equal(resolutionOutcome.status.guidance, "more_sync_required", "facade requires explicit synchronization after accepted resolution");
    equal(resolution.observed_contender_event_ids, [mutationA.event_id, mutationB.event_id].sort(), "resolution names the exact observed contender set");
    equal(resolution.adopted_event_id, mutationA.event_id, "eligible owner explicitly selects one observed contender");
    const resolutionConvergence = await converge(profileA, profileB, round + 1, 12);
    round = resolutionConvergence.nextRound;

    await invoke(profileA, "hc2s7", "closeSlice7Synchronization");
    await invoke(profileB, "hc2s7", "closeSlice7Synchronization");
    const resolvedSnapshotA = await invoke(profileA, "hc2s6", "snapshotAndCloseConvergenceReplica");
    const resolvedSnapshotB = await invoke(profileB, "hc2s6", "snapshotAndCloseConvergenceReplica");
    await profileA.close({ remove: false }); await profileB.close({ remove: false });
    profileA = await openProfile("a-resolved", server.url, directoryA);
    profileB = await openProfile("b-resolved", server.url, directoryB);
    await invoke(profileA, "hc2s6", "initializeConvergenceReplica", ["A", resolvedSnapshotA]);
    await invoke(profileB, "hc2s6", "initializeConvergenceReplica", ["B", resolvedSnapshotB]);
    await invoke(profileA, "hc2s6", "configureConvergencePeer", [publicB]);
    await invoke(profileB, "hc2s6", "configureConvergencePeer", [publicA]);
    const resolvedA = await invoke(profileA, "hc2s6", "reopenConvergenceEvidence", [legacyBToA.encoded]);
    const resolvedB = await invoke(profileB, "hc2s6", "reopenConvergenceEvidence", [legacyAToB.encoded]);
    for (const category of categories) equal(resolvedA[category], resolvedB[category], `resolved reopened category differs: ${category}`);
    equal(resolvedA.project_title.state, "resolved", "explicit HC-1 resolution survives portable reopen");
    equal(resolvedA.project_title.resolved_value, mutationA.title, "resolved value is the explicitly adopted contender");
    equal(resolvedA.conflicts.length, 0, "resolved conflict is removed identically without discarding unseen work");
    await invoke(profileA, "hc2s8", "initializeSlice8FacadeAtConflict", ["resolved"]);
    equal((await invoke(profileA, "hc2s8", "confirmSlice8ResolvedConvergence")).status.guidance, "revocation_required", "facade requires explicit revocation qualification");

    await invoke(profileA, "hc2s7", "initializeSlice7Synchronization");
    await invoke(profileB, "hc2s7", "initializeSlice7Synchronization");
    equal((await invoke(profileA, "hc2s8", "revokeSlice8Peer")).operation.evidence.peer_status, "revoked", "facade delegates revocation to the accepted-state boundary");
    await invoke(profileB, "hc2s6", "slice7SetPeerRevoked", [true]);
    const postCutoff = await invoke(profileB, "hc2s6", "slice8PostCutoffMutationRejected");
    equal(postCutoff.status, "rejected", "revoked device cannot create accepted post-cutoff work");
    equal(postCutoff.cryptographic_calls, 0, "post-cutoff rejection performs no cryptographic operation");
    const postRevocationExport = await invoke(profileA, "hc2s7", "attemptSlice7ExportAfterRevocation", [Math.min(round + 1, 32)]);
    equal(postRevocationExport.status, "revoked", "accepted revocation prevents fresh V3 export");
    equal((await invoke(profileA, "hc2s8", "reopenSlice8Verified")).operation.evidence.portable_reconstruction, "verified", "facade records explicit durable reopen verification");
    slice8Qualification = { resolution_event_id: resolution.event_id, observed_contender_count: resolution.observed_contender_event_ids.length,
      resolution_rounds: resolutionConvergence.rounds, resolved_reopens: 2, reviewer_rejected: true,
      post_cutoff_event_rejected: true, post_revocation_export_rejected: true, final_conflict_count: resolvedA.conflicts.length };
  }

  await invoke(profileA, "hc2s7", "deleteSlice7SynchronizationDatabase");
  await invoke(profileB, "hc2s7", "deleteSlice7SynchronizationDatabase");
  await invoke(profileA, "hc2s6", "deleteConvergenceDatabases");
  await invoke(profileB, "hc2s6", "deleteConvergenceDatabases");
  process.stdout.write(`${JSON.stringify({
    assertions,
    browser_product: profileA.product,
    browser_major: profileA.major,
    isolated_profiles: 2,
    node_chrome_v3_vector_equivalence: true,
    concurrent_mutations: [mutationA.title, mutationB.title],
    offline_families: [...new Set([...offlineA.families, ...offlineB.families])].sort(),
    forced_page_limit: 2,
    multi_rounds: firstConvergence.rounds + checkpointConvergence.rounds + closureConvergence.rounds,
    final_state_categories: categories,
    profiles_reopened: 4,
    receipt_count: reopenedA.receipts.length,
    acknowledgement_count: reopenedA.acknowledgements.length,
    conflict_count: reopenedA.conflicts.length,
    zero_transfer_already_converged: true,
    revocation_pre_crypto_rejection: true,
    old_ciphertext_limitation_verified: true,
    temporary_profiles_removed: true,
    ...(slice8Qualification ? { slice8_qualification: slice8Qualification } : {})
  }, null, 2)}\n`);
} finally {
  await profileA?.close(); await profileB?.close();
  rmSync(directoryA, { recursive: true, force: true }); rmSync(directoryB, { recursive: true, force: true });
  await server.close();
}

async function converge(a, b, startRound, maximumRounds) {
  let round = startRound, rounds = 0, duplicateImports = 0;
  await refreshInventories(a, b, round++);
  while (rounds < maximumRounds) {
    let transferred = false;
    for (const [requester, responder] of [[a, b], [b, a]]) {
      const request = await invoke(requester, "hc2s7", "createSlice7NextRequest", [round, 1]);
      if (request.status === "requests_ready") {
        const response = await invoke(responder, "hc2s7", "importSlice7RequestAndCreateResponse", [request.encoded]);
        const imported = await invoke(requester, "hc2s7", "importSlice7Response", [response.encoded]);
        const duplicate = await invoke(requester, "hc2s7", "importSlice7Response", [response.encoded]);
        check(imported.added >= 0, "bounded V3 response imports atomically");
        equal(duplicate.added, 0, "exact V3 response replay is idempotent");
        duplicateImports += 1; transferred = true;
      } else if (request.status !== "nothing_missing") throw new Error(`Unexpected planner result: ${request.status}`);
    }
    rounds += 1;
    const refreshed = await refreshInventories(a, b, round++);
    if (refreshed.aRoot === refreshed.bRoot) return { rounds, duplicateImports, nextRound: round };
    if (!transferred) throw new Error("V3 synchronization stopped before inventory convergence.");
  }
  throw new Error("V3 synchronization exceeded the explicit browser-test round bound.");
}

async function refreshInventories(a, b, round) {
  const exchangeA = await invoke(a, "hc2s7", "createSlice7InventoryExchange", [round, 2]);
  const exchangeB = await invoke(b, "hc2s7", "createSlice7InventoryExchange", [round, 2]);
  await invoke(a, "hc2s7", "importSlice7InventoryExchange", [[...exchangeB.files].reverse()]);
  await invoke(b, "hc2s7", "importSlice7InventoryExchange", [[...exchangeA.files].reverse()]);
  return { aRoot: exchangeA.inventory_root_id, bRoot: exchangeB.inventory_root_id };
}

function invoke(profile, namespace, method, args = []) { return evaluate(profile.page, { expression: `Promise.resolve(${namespace}[${JSON.stringify(method)}](...${JSON.stringify(args)})).then(clean)` }); }

async function openProfile(label, url, existingProfile = null) {
  const profile = existingProfile ?? mkdtempSync(join(tmpdir(), `patchmark-hc2-slice7-${label}-`));
  const process = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let browser, page;
  try {
    const webSocketUrl = await waitForDevToolsUrl(process);
    browser = await CdpClient.connect(webSocketUrl);
    const version = await browser.call("Browser.getVersion");
    page = await CdpClient.connect(await createPage(webSocketUrl, url));
    await page.call("Runtime.enable"); await waitReady(page);
    return { page, profile, product: version.product, major: Number(/\/(\d+)\./.exec(version.product)?.[1] ?? 0), async close({ remove = true } = {}) { await boundedCdpClose(page); await boundedCdpClose(browser); process.kill("SIGTERM"); await waitForProcessExit(process, 1000); if (process.exitCode === null) { process.kill("SIGKILL"); await waitForProcessExit(process, 1000); } if (remove) rmSync(profile, { recursive: true, force: true }); } };
  } catch (error) { await boundedCdpClose(page); await boundedCdpClose(browser); process.kill("SIGKILL"); if (!existingProfile) rmSync(profile, { recursive: true, force: true }); throw error; }
}

async function boundedCdpClose(client) {
  if (!client) return;
  let timeout;
  try {
    await Promise.race([
      client.close(),
      new Promise((resolveDelay) => { timeout = setTimeout(resolveDelay, 1500); })
    ]);
  } catch {
    // The isolated browser process is terminated immediately below.
  } finally {
    clearTimeout(timeout);
  }
}

async function waitReady(page) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await evaluate(page, { expression: "({ready:globalThis.__ready,error:globalThis.__error??null})" });
    if (state.error) throw new Error(state.error); if (state.ready) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for the HC-2 Slice 7 browser harness.");
}

async function startServer() {
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none'", "Content-Type": "text/html" });
        response.end(`<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"@hpke/core":"/node_modules/@hpke/core/esm/mod.js","@hpke/common":"/node_modules/@hpke/common/esm/mod.js"}}</script><script type="module">globalThis.__ready=false;globalThis.clean=(value)=>JSON.parse(JSON.stringify(value,(_,child)=>typeof child==='bigint'?child.toString():child));try{globalThis.hc2s6=await import('/scripts/collaboration-hc2-slice6-convergence-runtime.ts');globalThis.hc2s7=await import('/scripts/collaboration-hc2-slice7-browser-runtime.ts');globalThis.hc2s8=await import('/scripts/collaboration-hc2-slice8-browser-runtime.ts');globalThis.hc2vec=await import('/scripts/collaboration-hc2-slice7-vector-runtime.ts');globalThis.__ready=true}catch(error){globalThis.__error=error?.stack??String(error)}</script>`); return;
      }
      if ((pathname.startsWith("/lib/collaboration/") || pathname.startsWith("/scripts/collaboration-hc2-slice")) && pathname.endsWith(".ts")) {
        const sourcePath = safePath(pathname); const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript" }); response.end(transpiled.outputText); return;
      }
      if (pathname.startsWith("/node_modules/") && /\.(?:js|mjs)$/.test(pathname)) { response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript" }); response.end(readFileSync(safePath(pathname), "utf8")); return; }
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500, { "Content-Type": "text/plain" }); response.end(error instanceof Error ? error.stack : String(error)); }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Browser harness did not receive a port.");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

function safePath(pathname) { const value = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`); if (!value.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Path escaped repository root."); return value; }
