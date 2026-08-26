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
const vectorFixture = JSON.parse(readFileSync(join(scriptDirectory, "fixtures", "collaboration-hc3-slice3-v1.json"), "utf8"));
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-3 Slice 3 qualification.");
const server = await startServer();
let profileA = await openProfile("a", server.url);
let profileB = await openProfile("b", server.url);
const directoryA = profileA.profile;
const directoryB = profileB.profile;
let assertions = 0;
let directTransfers = 0;
let interruptedTransfer = null;
let freshAttempts = 0;
let duplicateImports = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };

try {
  progress("profiles-ready");
  equal(await invoke(profileA, "hc3d", "createSlice3VectorActual", [vectorFixture.inputs]), vectorFixture.expected, "Chrome description and frame bytes equal frozen Node/Python vectors");
  const publicA = await invoke(profileA, "hc2s6", "initializeConvergenceReplica", ["A"]);
  const publicB = await invoke(profileB, "hc2s6", "initializeConvergenceReplica", ["B"]);
  check(publicA.private_keys_non_extractable && publicB.private_keys_non_extractable, "both profiles use persisted non-extractable custody keys");
  await invoke(profileA, "hc2s6", "configureConvergencePeer", [publicB]);
  await invoke(profileB, "hc2s6", "configureConvergencePeer", [publicA]);
  const genesis = await invoke(profileA, "hc2s6", "createConvergenceGenesis");
  const admission = await invoke(profileA, "hc2s6", "prepareConvergenceAdmission");
  const admitted = await invoke(profileB, "hc2s6", "importConvergenceBundle", [admission.encoded]);
  progress("admission-complete");
  equal(admitted.status, "imported", "Device B is admitted through the existing encrypted V2 admission path");
  equal(admitted.full_history_verified, false, "Device B keeps its admission-boundary history status");

  const mutationA = await invoke(profileA, "hc2s6", "createConvergenceMutation", ["Concurrent direct title from A"]);
  const mutationB = await invoke(profileB, "hc2s6", "createConvergenceMutation", ["Concurrent direct title from B"]);
  equal(mutationA.observed_parent_ids, [genesis.genesis_event_id], "A direct-test mutation observes only genesis");
  equal(mutationB.observed_parent_ids, [genesis.genesis_event_id], "B direct-test mutation observes only genesis");
  check(!mutationA.observed_parent_ids.includes(mutationB.event_id) && !mutationB.observed_parent_ids.includes(mutationA.event_id), "mutations are genuinely concurrent before direct synchronization");
  await invoke(profileA, "hc2s6", "createSlice8RepresentativeOfflineWork");
  await invoke(profileB, "hc2s6", "createSlice8RepresentativeOfflineWork");
  await invoke(profileB, "hc2s6", "createConvergenceReceipt");

  const legacyAToB = await invoke(profileA, "hc2s6", "prepareConvergenceReplication", ["B", [{ kind: "semantic-event", id: mutationA.event_id }], 0, null]);
  const legacyBToA = await invoke(profileB, "hc2s6", "prepareConvergenceReplication", ["A", [{ kind: "semantic-event", id: mutationB.event_id }], 0, null]);

  const syncA = await invoke(profileA, "hc2s7", "initializeSlice7Synchronization");
  const syncB = await invoke(profileB, "hc2s7", "initializeSlice7Synchronization");
  equal(syncA.session_id, syncB.session_id, "both profiles reuse the exact V3 session identity");
  const directA = await invoke(profileA, "hc3d", "initializeDirectTransport", [syncA.session_id]);
  const directB = await invoke(profileB, "hc3d", "initializeDirectTransport", [syncB.session_id]);
  progress("direct-runtime-initialized");
  const surfaceReady = await invoke(profileA, "hc3d", "initializeDirectQualificationSurface");
  equal([surfaceReady.state, surfaceReady.live_region, surfaceReady.labelled_textarea, surfaceReady.encrypted_file_fallback], ["ready", "polite", true, true], "disabled direct surface is labelled, announced, and retains file fallback");
  check(surfaceReady.buttons.some((button) => button.name === "Create connection link" && button.describedby === "hc3-direct-status"), "direct surface exposes an accessible explicit create action");
  const surfaceLink = await invoke(profileA, "hc3d", "invokeDirectQualificationSurface", ["create_connection_link"]);
  equal(surfaceLink.state, "connection_link_ready", "explicit surface action reaches ordinary Connection link ready state");
  const surfaceOpen = await invoke(profileA, "hc3d", "invokeDirectQualificationSurface", ["open_connection_response", "pmhc3d.test"]);
  equal(surfaceOpen.state, "response_opened", "explicit pasted response reaches ordinary Open response state without auto-connect");
  check(directA.private_signing_key_non_extractable && directB.private_signing_key_non_extractable, "direct authentication reuses real non-extractable device keys");
  equal(directA.direct_state_persisted, false, "connection state is explicitly ephemeral");

  const rejectedOffer = await invoke(profileA, "hc3d", "createDirectOffer", [attemptHex(1)]);
  const corrupted = `${rejectedOffer.text.slice(0, -1)}${rejectedOffer.text.endsWith("a") ? "b" : "a"}`;
  equal((await outcome(profileB, "hc3d", "acceptDirectOffer", [corrupted])).status, "rejected", "corrupted manual offer rejects before peer creation");
  await invoke(profileB, "hc2s6", "slice7SetPeerRevoked", [true]);
  const revoked = await outcome(profileB, "hc3d", "acceptDirectOffer", [rejectedOffer.text]);
  equal(revoked.status, "rejected", "revoked device rejects before peer creation");
  check(revoked.message.includes("revoked_device"), "revocation diagnostic is explicit");
  equal((await invoke(profileB, "hc3d", "directConnectionEvidence")).configurations.length, 0, "rejected offers created no peer object");
  await invoke(profileB, "hc2s6", "slice7SetPeerRevoked", [false]);
  progress("negative-offer-cases-complete");

  const firstConnection = await connectDirect(profileA, profileB, 2);
  progress("first-direct-connection-open");
  check(firstConnection.offer.description_bytes <= 1536 && firstConnection.answer.description_bytes <= 1536, "measured non-trickle Chrome descriptions fit the frozen Slice 1 limit");
  check(firstConnection.offer.sdp_utf8_bytes > 0 && firstConnection.answer.sdp_utf8_bytes > 0, "actual Chrome SDP UTF-8 sizes are measured");
  check(firstConnection.offer.presentation.copy_available && firstConnection.answer.presentation.copy_available, "manual copy fallback is available for both authenticated artifacts");
  freshAttempts += 1;

  let round = 1;
  await refreshInventoriesDirect(profileA, profileB, round++);
  let interrupted = false;
  let convergence = await convergeDirect(profileA, profileB, round, 20, async ({ responder, requester, response }) => {
    if (interrupted || decodedLength(response.encoded) <= 4096) return false;
    interrupted = true;
    interruptedTransfer = await invoke(responder, "hc3d", "interruptDirectV3", [response.encoded]);
    const receiverOutcome = await invoke(requester, "hc3d", "expectInterruptedReceive");
    equal(receiverOutcome.status, "interrupted", "partial direct transfer stops without import");
    check(interruptedTransfer.sent_frames < interruptedTransfer.total_frames, "interruption occurs before the dense frame set is complete");
    await connectDirect(profileA, profileB, 3);
    freshAttempts += 1;
    const exact = await transferDirect(responder, requester, response.encoded);
    equal(exact, response.encoded, "fresh connection resends the exact journaled V3 bytes");
    const imported = await invoke(requester, "hc2s7", "importSlice7Response", [exact]);
    check(imported.added >= 0, "resumed exact response imports atomically through existing V3 logic");
    return true;
  });
  progress("first-convergence-complete");
  round = convergence.nextRound;
  check(interrupted, "a real multi-frame V3 response was interrupted and resumed");
  check(convergence.rounds > 0, "bounded direct rounds drive V3 planning to convergence");

  const checkpoint = await invoke(profileA, "hc2s6", "createConvergenceCheckpoint", [mutationA.event_id, mutationB.event_id]);
  const ackA = await invoke(profileA, "hc2s6", "createConvergenceAcknowledgement");
  check(checkpoint.snapshot_id && ackA.acknowledgement_id, "deterministic conflict resolution creates checkpoint and acknowledgement evidence");
  convergence = await convergeDirect(profileA, profileB, round, 20); round = convergence.nextRound;
  progress("checkpoint-convergence-complete");
  const ackB = await invoke(profileB, "hc2s6", "createConvergenceAcknowledgement");
  check(ackB.acknowledgement_id, "B acknowledges only after accepting the shared checkpoint");
  convergence = await convergeDirect(profileA, profileB, round, 20); round = convergence.nextRound;
  progress("closure-convergence-complete");

  await refreshInventoriesDirect(profileA, profileB, round++);
  const zeroA = await invoke(profileA, "hc2s7", "createSlice7NextRequest", [round, 1]);
  const zeroB = await invoke(profileB, "hc2s7", "createSlice7NextRequest", [round, 1]);
  equal(zeroA.status, "nothing_missing", "converged A sends zero objects");
  equal(zeroB.status, "nothing_missing", "converged B sends zero objects");
  const confirmationA = await invoke(profileA, "hc2s7", "createSlice7Confirmation", [round]);
  const confirmationB = await invoke(profileB, "hc2s7", "createSlice7Confirmation", [round]);
  const receivedConfirmationB = await transferDirect(profileB, profileA, confirmationB.encoded);
  const receivedConfirmationA = await transferDirect(profileA, profileB, confirmationA.encoded);
  equal((await invoke(profileA, "hc2s7", "importSlice7Confirmation", [receivedConfirmationB, confirmationA.core])).status, "converged", "A accepts peer reconstruction commitments over direct transport");
  equal((await invoke(profileB, "hc2s7", "importSlice7Confirmation", [receivedConfirmationA, confirmationB.core])).status, "converged", "B accepts peer reconstruction commitments over direct transport");
  progress("confirmations-complete");

  const directEvidenceA = await invoke(profileA, "hc3d", "directConnectionEvidence");
  const directEvidenceB = await invoke(profileB, "hc3d", "directConnectionEvidence");
  for (const evidence of [directEvidenceA, directEvidenceB]) {
    equal(evidence.configurations.every((entry) => Object.keys(entry).length === 1 && entry.iceServers.length === 0), true, "every peer object uses only an empty server list");
    equal([evidence.label, evidence.protocol, evidence.ordered, evidence.max_retransmits, evidence.max_packet_lifetime, evidence.binary_type], ["patchmark-hc3-v3", "patchmark/hc3/direct-v3/v1", true, null, null, "arraybuffer"], "real channel uses the fixed reliable ordered binary profile");
    check(evidence.backpressure_wait_count > 0, "real Chrome send path observed bufferedAmount backpressure");
    check(evidence.sent.some((entry) => entry.frame_count > 1), "real encrypted V3 bytes cross multiple frames");
    check(evidence.authority_boundaries.filter((entry) => entry === "before_peer_connection").length >= 1, "current authority is checked before peer construction");
  }

  const closedA = await invoke(profileA, "hc3d", "closeDirectTransport");
  const closedB = await invoke(profileB, "hc3d", "closeDirectTransport");
  equal(closedA.direct_state_persisted && closedB.direct_state_persisted, false, "peer connection state is never persisted");
  const snapshotA = await invoke(profileA, "hc2s6", "snapshotAndCloseConvergenceReplica");
  const snapshotB = await invoke(profileB, "hc2s6", "snapshotAndCloseConvergenceReplica");
  await profileA.close({ remove: false }); await profileB.close({ remove: false });
  profileA = await openProfile("a-reopen", server.url, directoryA);
  profileB = await openProfile("b-reopen", server.url, directoryB);
  await invoke(profileA, "hc2s6", "initializeConvergenceReplica", ["A", snapshotA]);
  await invoke(profileB, "hc2s6", "initializeConvergenceReplica", ["B", snapshotB]);
  await invoke(profileA, "hc2s6", "configureConvergencePeer", [publicB]);
  await invoke(profileB, "hc2s6", "configureConvergencePeer", [publicA]);
  const reopenedA = await invoke(profileA, "hc2s6", "reopenConvergenceEvidence", [legacyBToA.encoded]);
  const reopenedB = await invoke(profileB, "hc2s6", "reopenConvergenceEvidence", [legacyAToB.encoded]);
  progress("profiles-reopened");
  equal(reopenedA.authoritative, reopenedB.authoritative, "reopened authoritative object identities and exact bytes agree");
  equal(reopenedA.projection, reopenedB.projection, "reopened projection, revisions, conflicts, tombstones, rejections, roots, and checkpoint agree");
  equal(reopenedA.authority, reopenedB.authority, "reopened membership, devices, control head, and epoch agree");
  equal(reopenedA.evidence, reopenedB.evidence, "reopened acknowledgement, receipt, state-blob, and snapshot evidence agree");
  equal(reopenedB.full_history_verified, false, "Device B retains its admission boundary after direct synchronization and reopen");

  process.stdout.write(`${JSON.stringify({
    assertions,
    chrome: profileA.product,
    isolated_profiles: 2,
    no_server_configuration: true,
    manual_non_trickle_offer_answer: true,
    fresh_connection_attempts: freshAttempts,
    direct_v3_transfers: directTransfers,
    duplicate_imports: duplicateImports,
    measured_connection_artifacts: {
      offers: directEvidenceA.offers,
      answers: directEvidenceB.answers
    },
    measured_transfers: {
      minimum_exact_v3_bytes: Math.min(...directEvidenceA.sent.concat(directEvidenceB.sent).map((entry) => entry.exact_bytes)),
      maximum_exact_v3_bytes: Math.max(...directEvidenceA.sent.concat(directEvidenceB.sent).map((entry) => entry.exact_bytes)),
      minimum_encoded_frame_bytes: Math.min(...directEvidenceA.sent.concat(directEvidenceB.sent).map((entry) => entry.minimum_encoded_frame_bytes)),
      maximum_encoded_frame_bytes: Math.max(...directEvidenceA.sent.concat(directEvidenceB.sent).map((entry) => entry.maximum_encoded_frame_bytes)),
      frame_payload_limit: directEvidenceA.frame_payload_limit
    },
    backpressure_waits: {
      device_a: directEvidenceA.backpressure_wait_count,
      device_b: directEvidenceB.backpressure_wait_count
    },
    interrupted_transfer: interruptedTransfer,
    concurrent_mutations: [mutationA.event_id, mutationB.event_id],
    final_zero_object_requests: true,
    reopened_authoritative_equality: true,
    device_b_full_history_verified: false,
    temporary_profiles_removed: true,
    server_closed: true,
    status: "ok"
  }, null, 2)}\n`);
} finally {
  await profileA?.close(); await profileB?.close();
  rmSync(directoryA, { recursive: true, force: true }); rmSync(directoryB, { recursive: true, force: true });
  await server.close();
}

async function connectDirect(a, b, attempt) {
  const offer = await invoke(a, "hc3d", "createDirectOffer", [attemptHex(attempt)]);
  progress(`attempt-${attempt}-offer-ready`);
  const answer = await invoke(b, "hc3d", "acceptDirectOffer", [offer.text]);
  progress(`attempt-${attempt}-answer-ready`);
  const connectedA = await invoke(a, "hc3d", "acceptDirectAnswer", [answer.text]);
  progress(`attempt-${attempt}-answer-accepted`);
  const connectedB = await invoke(b, "hc3d", "completeAcceptedDirectOffer");
  progress(`attempt-${attempt}-responder-connected`);
  check(connectedA.connected, "initiator opens only after manually receiving the exact response");
  check(connectedB.connected, "responder opens only after the initiator applies its exact response");
  return { offer, answer, connectedA, connectedB };
}

async function transferDirect(sender, receiver, encoded) {
  const sent = await invoke(sender, "hc3d", "sendDirectV3", [encoded]);
  const received = await invoke(receiver, "hc3d", "receiveDirectV3");
  equal(received.encoded, encoded, "direct transport preserves exact encrypted V3 bundle bytes");
  equal(received.sha256, sent.sha256, "sender and receiver agree on exact V3 SHA-256");
  directTransfers += 1;
  return received.encoded;
}

async function transferFiles(sender, receiver, files) {
  const received = [];
  for (const encoded of files) received.push(await transferDirect(sender, receiver, encoded));
  return received;
}

async function refreshInventoriesDirect(a, b, round) {
  const exchangeA = await invoke(a, "hc2s7", "createSlice7InventoryExchange", [round, 2]);
  const exchangeB = await invoke(b, "hc2s7", "createSlice7InventoryExchange", [round, 2]);
  const receivedByA = await transferFiles(b, a, [...exchangeB.files].reverse());
  const receivedByB = await transferFiles(a, b, [...exchangeA.files].reverse());
  equal((await invoke(a, "hc2s7", "importSlice7InventoryExchange", [receivedByA])).status, "complete", "A imports explicit direct inventory closure");
  equal((await invoke(b, "hc2s7", "importSlice7InventoryExchange", [receivedByB])).status, "complete", "B imports explicit direct inventory closure");
  return { aRoot: exchangeA.inventory_root_id, bRoot: exchangeB.inventory_root_id };
}

async function convergeDirect(a, b, startRound, maximumRounds, interruptionHook = null) {
  let round = startRound;
  let rounds = 0;
  await refreshInventoriesDirect(a, b, round++);
  while (rounds < maximumRounds) {
    let transferred = false;
    for (const [requester, responder] of [[a, b], [b, a]]) {
      const request = await invoke(requester, "hc2s7", "createSlice7NextRequest", [round, 1]);
      if (request.status === "requests_ready") {
        const exactRequest = await transferDirect(requester, responder, request.encoded);
        const response = await invoke(responder, "hc2s7", "importSlice7RequestAndCreateResponse", [exactRequest]);
        const handled = interruptionHook ? await interruptionHook({ requester, responder, request, response }) : false;
        if (!handled) {
          const exactResponse = await transferDirect(responder, requester, response.encoded);
          const imported = await invoke(requester, "hc2s7", "importSlice7Response", [exactResponse]);
          check(imported.added >= 0, "existing V3 importer accepts exact direct response atomically");
        }
        const duplicateResponse = await transferDirect(responder, requester, response.encoded);
        const duplicate = await invoke(requester, "hc2s7", "importSlice7Response", [duplicateResponse]);
        equal(duplicate.added, 0, "re-exporting an already-imported exact bundle is idempotent");
        duplicateImports += 1;
        transferred = true;
      } else if (request.status !== "nothing_missing") throw new Error(`Unexpected V3 planner status ${request.status}`);
    }
    rounds += 1;
    const refreshed = await refreshInventoriesDirect(a, b, round++);
    if (refreshed.aRoot === refreshed.bRoot) return { rounds, nextRound: round };
    if (!transferred) throw new Error("Direct V3 synchronization stopped before convergence.");
  }
  throw new Error("Direct V3 synchronization exceeded its explicit round bound.");
}

function decodedLength(value) { return Math.floor(value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0); }
function progress(value) { process.stderr.write(`[hc3-slice3] ${value}\n`); }
function attemptHex(value) { return value.toString(16).padStart(2, "0").repeat(16); }
function invoke(profile, namespace, method, args = []) { return evaluate(profile.page, { expression: `Promise.resolve(${namespace}[${JSON.stringify(method)}](...${JSON.stringify(args)})).then(clean)` }); }
function outcome(profile, namespace, method, args = []) { return evaluate(profile.page, { expression: `Promise.resolve().then(()=>${namespace}[${JSON.stringify(method)}](...${JSON.stringify(args)})).then(value=>({status:'accepted',value:clean(value)}),error=>({status:'rejected',message:error?.message??String(error)}))` }); }

async function openProfile(label, url, existingProfile = null) {
  const profile = existingProfile ?? mkdtempSync(join(tmpdir(), `patchmark-hc3-slice3-${label}-`));
  const process = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let browser, page;
  try {
    const webSocketUrl = await waitForDevToolsUrl(process);
    browser = await CdpClient.connect(webSocketUrl);
    const version = await browser.call("Browser.getVersion");
    page = await CdpClient.connect(await createPage(webSocketUrl, url));
    await page.call("Runtime.enable"); await waitReady(page);
    return { page, profile, product: version.product, async close({ remove = true } = {}) { await page?.close(); await browser?.close(); process.kill("SIGTERM"); await waitForProcessExit(process, 1200); if (process.exitCode === null) { process.kill("SIGKILL"); await waitForProcessExit(process, 1200); } if (remove) rmSync(profile, { recursive: true, force: true }); } };
  } catch (error) { await page?.close(); await browser?.close(); process.kill("SIGKILL"); if (!existingProfile) rmSync(profile, { recursive: true, force: true }); throw error; }
}

async function waitReady(page) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = await evaluate(page, { expression: "({ready:globalThis.__ready,error:globalThis.__error??null})" });
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for HC-3 Slice 3 browser runtime.");
}

async function startServer() {
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none'", "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><meta charset="utf-8"><main></main><script type="importmap">{"imports":{"@hpke/core":"/node_modules/@hpke/core/esm/mod.js","@hpke/common":"/node_modules/@hpke/common/esm/mod.js"}}</script><script type="module">globalThis.__ready=false;globalThis.clean=(value)=>JSON.parse(JSON.stringify(value,(_,child)=>typeof child==='bigint'?child.toString():child));try{globalThis.hc2s6=await import('/scripts/collaboration-hc2-slice6-convergence-runtime.ts');globalThis.hc2s7=await import('/scripts/collaboration-hc2-slice7-browser-runtime.ts');globalThis.hc3d=await import('/scripts/collaboration-hc3-slice3-browser-runtime.ts');globalThis.__ready=true}catch(error){globalThis.__error=error?.stack??String(error)}</script>`);
        return;
      }
      if ((pathname.startsWith("/lib/collaboration/") || pathname.startsWith("/scripts/collaboration-hc2-slice") || pathname.startsWith("/scripts/collaboration-hc3-slice3-")) && pathname.endsWith(".ts")) {
        const sourcePath = safePath(pathname);
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" }); response.end(transpiled.outputText); return;
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
