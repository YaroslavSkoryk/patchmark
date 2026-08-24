import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  CdpClient,
  createPage,
  evaluate,
  findChromeExecutable,
  waitForDevToolsUrl,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const fixture = JSON.parse(readFileSync(join(scriptDirectory, "fixtures", "collaboration-hc2-slice6-v2.json"), "utf8"));
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found. Set PATCHMARK_CHROME_PATH to run HC-2 Slice 6 browser tests.");
const server = await startServer();
const owner = await openProfile("owner", server.url);
const recipient = await openProfile("recipient", server.url);
let assertions = 0;
try {
  const ownerVector = await evaluate(owner.page, { expression: `hc2s6.createSlice6VectorActual(${JSON.stringify(fixture.inputs)}).then(clean)` });
  assertions += 1; assert.deepEqual(ownerVector, fixture.expected, "owner Chrome profile differs from frozen v2 vector");
  const outbound = await evaluate(owner.page, { expression: `hc2s6.createSlice6PortableTransfer(${JSON.stringify(fixture.inputs)}).then(clean)` });
  const recipientImport = await evaluate(recipient.page, { expression: `hc2s6.importSlice6PortableTransfer(${JSON.stringify(fixture.inputs)},${JSON.stringify(outbound)}).then(clean)` });
  assertions += 1; assert.equal(recipientImport.status, "imported");
  assertions += 1; assert.equal(recipientImport.private_key_extractable, false);
  assertions += 1; assert.deepEqual(recipientImport.imported_ids, [fixture.expected.markdown_blob_id]);
  const reverse = await evaluate(recipient.page, { expression: `hc2s6.createSlice6PortableTransfer(${JSON.stringify(fixture.inputs)}).then(clean)` });
  const ownerImport = await evaluate(owner.page, { expression: `hc2s6.importSlice6PortableTransfer(${JSON.stringify(fixture.inputs)},${JSON.stringify(reverse)}).then(clean)` });
  assertions += 1; assert.equal(ownerImport.status, "imported");
  assertions += 1; assert.equal(ownerImport.private_key_extractable, false);
  assertions += 1; assert.deepEqual(ownerImport.imported_sha256, recipientImport.imported_sha256);
  const ownerCore = await evaluate(owner.page, { expression: "hc2core.runSlice6CoreEvidence().then(clean)" });
  const recipientCore = await evaluate(recipient.page, { expression: "hc2core.runSlice6CoreEvidence().then(clean)" });
  for (const evidence of [ownerCore, recipientCore]) {
    assertions += 1; assert.equal(evidence.imported_status, "imported");
    assertions += 1; assert.equal(evidence.duplicate_status, "duplicate");
    assertions += 1; assert.equal(evidence.tamper_reason, "authentication_failed");
    assertions += 1; assert.equal(evidence.public_privacy, true);
    assertions += 1; assert.equal(evidence.v1_rejects_v2 && evidence.v2_rejects_v1, true);
  }
  const durable = await evaluate(recipient.page, { expression: `hc2core.runIndexedDbTransportEvidence(${JSON.stringify(`patchmark-hc2-slice6-${Date.now()}`)}).then(clean)` });
  assertions += 1; assert.equal(durable.reserved, "reserved");
  assertions += 1; assert.equal(durable.competing_reservation, "conflict");
  assertions += 1; assert.equal(durable.completed, "completed");
  assertions += 1; assert.equal(durable.reopened_status, "completed");
  assertions += 1; assert.equal(durable.reopened_exact_bytes, "010203");
  assertions += 1; assert.equal(durable.inbound_after_reopen, "duplicate");
  assertions += 1; assert.equal(durable.database_deleted, true);
  const convergence = await runConvergenceScenario(server.url);
  assertions += convergence.assertions;
  process.stdout.write(`${JSON.stringify({
    assertions,
    browser_product: owner.product,
    browser_major: owner.major,
    separate_profiles: 2,
    forward_import: recipientImport.status,
    reverse_import: ownerImport.status,
    node_chrome_vector_equivalence: true,
    private_keys_non_extractable: true,
    indexeddb_transport_journal_reopened: true,
    convergence,
    temporary_profiles_removed: true
  }, null, 2)}\n`);
} finally {
  await owner.close();
  await recipient.close();
  await server.close();
}

async function openProfile(label, url, existingProfile = null) {
  const profile = existingProfile ?? mkdtempSync(join(tmpdir(), `patchmark-hc2-slice6-${label}-`));
  const process = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let browser;
  let page;
  try {
    const webSocketUrl = await waitForDevToolsUrl(process);
    browser = await CdpClient.connect(webSocketUrl);
    const version = await browser.call("Browser.getVersion");
    page = await CdpClient.connect(await createPage(webSocketUrl, url));
    await page.call("Runtime.enable");
    await waitReady(page);
    const major = Number(/\/(\d+)\./.exec(version.product)?.[1] ?? 0);
    return {
      page,
      profile,
      product: version.product,
      major,
      async close({ remove = true } = {}) {
        await page?.close(); await browser?.close(); process.kill("SIGTERM"); await waitForProcessExit(process, 1000);
        if (process.exitCode === null) { process.kill("SIGKILL"); await waitForProcessExit(process, 1000); }
        if (remove) rmSync(profile, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await page?.close(); await browser?.close(); process.kill("SIGKILL"); rmSync(profile, { recursive: true, force: true }); throw error;
  }
}

async function waitReady(page) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await evaluate(page, { expression: "({ready:globalThis.__ready,error:globalThis.__error??null})" });
    if (state.error) throw new Error(state.error);
    if (state.ready) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for the HC-2 Slice 6 browser harness.");
}

async function startServer() {
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none'", "Content-Type": "text/html" });
        response.end(`<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"@hpke/core":"/node_modules/@hpke/core/esm/mod.js","@hpke/common":"/node_modules/@hpke/common/esm/mod.js"}}</script><script type="module">globalThis.__ready=false;globalThis.clean=(value)=>JSON.parse(JSON.stringify(value,(_,child)=>typeof child==='bigint'?child.toString():child));try{globalThis.hc2s6=await import('/scripts/collaboration-hc2-slice6-vector-runtime.ts');globalThis.hc2core=await import('/scripts/collaboration-hc2-slice6-runtime.ts');globalThis.hc2conv=await import('/scripts/collaboration-hc2-slice6-convergence-runtime.ts');globalThis.__ready=true}catch(error){globalThis.__error=error?.stack??String(error)}</script>`);
        return;
      }
      if ((pathname.startsWith("/lib/collaboration/") || pathname.startsWith("/scripts/collaboration-hc2-slice6")) && pathname.endsWith(".ts")) {
        const sourcePath = safePath(pathname);
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript" }); response.end(transpiled.outputText); return;
      }
      if (pathname.startsWith("/node_modules/") && /\.(?:js|mjs)$/.test(pathname)) {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript" }); response.end(readFileSync(safePath(pathname), "utf8")); return;
      }
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500, { "Content-Type": "text/plain" }); response.end(error instanceof Error ? error.stack : String(error)); }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser harness did not receive a port.");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

function safePath(pathname) { const value = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`); if (!value.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Path escaped repository root."); return value; }

async function runConvergenceScenario(url) {
  let profileA = await openProfile("convergence-a", url);
  let profileB = await openProfile("convergence-b", url);
  const directoryA = profileA.profile;
  const directoryB = profileB.profile;
  let count = 0;
  try {
    const publicA = await invoke(profileA, "initializeConvergenceReplica", ["A"]);
    const publicB = await invoke(profileB, "initializeConvergenceReplica", ["B"]);
    count += 1; assert.equal(publicA.private_keys_non_extractable && publicB.private_keys_non_extractable, true,
      "both isolated profiles must create non-extractable native keys");
    await invoke(profileA, "configureConvergencePeer", [publicB]);
    await invoke(profileB, "configureConvergencePeer", [publicA]);
    const genesis = await invoke(profileA, "createConvergenceGenesis");
    const admission = await invoke(profileA, "prepareConvergenceAdmission");
    const admitted = await invoke(profileB, "importConvergenceBundle", [admission.encoded]);
    count += 1; assert.equal(admitted.status, "imported", "B must import A's encrypted v2 admission bundle");
    count += 1; assert.equal(admitted.full_history_verified, false, "admission must preserve the partial-history boundary");
    count += 1; assert.equal(admission.export_status, "completed");
    count += 1; assert.equal(admission.export_retry_status, "resumed_completed");

    const mutationA = await invoke(profileA, "createConvergenceMutation", ["Concurrent title from Device A"]);
    const mutationB = await invoke(profileB, "createConvergenceMutation", ["Concurrent title from Device B"]);
    count += 1; assert.equal(mutationA.accepted && mutationB.accepted, true,
      "both mutations must be independently accepted before either profile observes the other mutation");
    count += 1; assert.deepEqual(mutationA.observed_parent_ids, [genesis.genesis_event_id]);
    count += 1; assert.deepEqual(mutationB.observed_parent_ids, [genesis.genesis_event_id]);
    count += 1; assert(!mutationA.observed_parent_ids.includes(mutationB.event_id) && !mutationB.observed_parent_ids.includes(mutationA.event_id),
      "neither concurrent mutation may observe the other");

    const aToB = await invoke(profileA, "prepareConvergenceReplication", ["B", [{ kind: "semantic-event", id: mutationA.event_id }], 0, null]);
    const bToA = await invoke(profileB, "prepareConvergenceReplication", ["A", [{ kind: "semantic-event", id: mutationB.event_id }], 0, null]);
    const aSelf = await invoke(profileA, "prepareConvergenceReplication", ["A", [{ kind: "semantic-event", id: mutationA.event_id }], 0, null]);
    count += 1; assert(aToB.closure.some((entry) => entry.id === mutationA.event_id) && bToA.closure.some((entry) => entry.id === mutationB.event_id));
    count += 1; assert(aToB.closure.some((entry) => entry.id === genesis.control_event_id) && bToA.closure.some((entry) => entry.id === genesis.control_event_id),
      "both explicit selections must be dependency-closed through the accepted control head");
    count += 1; assert.equal((await invoke(profileB, "importConvergenceBundle", [aToB.encoded])).status, "imported");
    count += 1; assert.equal((await invoke(profileA, "importConvergenceBundle", [bToA.encoded])).status, "imported");

    count += 1; assert.equal((await invoke(profileA, "importConvergenceBundle", [aSelf.encoded, "arrival_ab"])).status, "imported");
    count += 1; assert.equal((await invoke(profileA, "importConvergenceBundle", [bToA.encoded, "arrival_ab"])).status, "imported");
    count += 1; assert.equal((await invoke(profileA, "importConvergenceBundle", [bToA.encoded, "arrival_ba"])).status, "imported");
    count += 1; assert.equal((await invoke(profileA, "importConvergenceBundle", [aSelf.encoded, "arrival_ba"])).status, "imported");
    const arrival = await invoke(profileA, "compareScratchArrivalOrders", ["arrival_ab", "arrival_ba", mutationA.event_id, mutationB.event_id]);
    count += 1; assert.deepEqual(arrival.first, arrival.second, "reversing bundle arrival must reconstruct the exact same projection");
    count += 1; assert.equal(arrival.first_causality, "concurrent");
    count += 1; assert.equal(arrival.second_causality, "concurrent");
    count += 1; assert.equal(arrival.first.project_title.state, "conflicted", "concurrent titles must retain an explicit conflict");
    count += 1; assert.equal(arrival.first.project_title.resolved_value, null, "replay order must not invent a winner");

    const checkpoint = await invoke(profileA, "createConvergenceCheckpoint", [mutationA.event_id, mutationB.event_id]);
    const checkpointBundle = await invoke(profileA, "prepareConvergenceReplication", ["B", [{ kind: "snapshot", id: checkpoint.snapshot_id }], 1, aToB.manifest_id]);
    count += 1; assert.equal((await invoke(profileB, "importConvergenceBundle", [checkpointBundle.encoded])).status, "imported");
    const ackA = await invoke(profileA, "createConvergenceAcknowledgement");
    const ackB = await invoke(profileB, "createConvergenceAcknowledgement");
    const receipt = await invoke(profileB, "createConvergenceReceipt");
    const closureA = await invoke(profileA, "prepareConvergenceReplication", ["B", [{ kind: "acknowledgement", id: ackA.acknowledgement_id }], 2, checkpointBundle.manifest_id]);
    const closureB = await invoke(profileB, "prepareConvergenceReplication", ["A", [{ kind: "acknowledgement", id: ackB.acknowledgement_id }], 1, bToA.manifest_id, true]);
    count += 1; assert.equal((await invoke(profileB, "importConvergenceBundle", [closureA.encoded])).status, "imported");
    count += 1; assert.equal((await invoke(profileA, "importConvergenceBundle", [closureB.encoded])).status, "imported");
    count += 1; assert(closureA.closure.some((entry) => entry.id === ackA.acknowledgement_id));
    count += 1; assert(closureB.closure.some((entry) => entry.id === ackB.acknowledgement_id));

    const snapshotA = await invoke(profileA, "snapshotAndCloseConvergenceReplica");
    const snapshotB = await invoke(profileB, "snapshotAndCloseConvergenceReplica");
    await profileA.close({ remove: false });
    await profileB.close({ remove: false });
    profileA = await openProfile("convergence-a-reopen", url, directoryA);
    profileB = await openProfile("convergence-b-reopen", url, directoryB);
    await invoke(profileA, "initializeConvergenceReplica", ["A", snapshotA]);
    await invoke(profileB, "initializeConvergenceReplica", ["B", snapshotB]);
    const reopenedA = await invoke(profileA, "reopenConvergenceEvidence", [closureB.encoded]);
    const reopenedB = await invoke(profileB, "reopenConvergenceEvidence", [closureA.encoded]);
    const exactCategories = [
      "accepted_objects", "accepted_semantic_event_ids", "accepted_control_event_ids", "semantic_frontier", "control_head",
      "membership_device_authority", "current_epoch", "canonical_projection_bytes", "revision_heads", "conflicts", "tombstones",
      "reducer_rejections", "component_roots", "projection_root", "checkpoint", "state_blob", "snapshot", "acknowledgements", "receipts"
    ];
    for (const category of exactCategories) {
      count += 1; assert.deepEqual(reopenedA[category], reopenedB[category], `reopened authoritative category differs: ${category}`);
    }
    count += 1; assert.equal(reopenedA.project_title.state, "conflicted");
    count += 1; assert.equal(reopenedA.concurrent_mutation_relation, "concurrent");
    count += 1; assert.equal(reopenedB.concurrent_mutation_relation, "concurrent");
    count += 1; assert.deepEqual(reopenedA.project_title, reopenedB.project_title);
    count += 1; assert.equal(reopenedA.conflicts.length, 1, "the legitimate conflict must be identical and retained");
    count += 1; assert.equal(reopenedA.state_blob.verification, "verified");
    count += 1; assert.equal(reopenedB.snapshot.verification, "verified");
    count += 1; assert.deepEqual(reopenedA.acknowledgements.sort(), [ackA.acknowledgement_id, ackB.acknowledgement_id].sort());
    count += 1; assert.deepEqual(reopenedA.receipts, [receipt.receipt_id]);
    count += 1; assert.equal(reopenedA.duplicate_import, "duplicate");
    count += 1; assert.equal(reopenedB.duplicate_import, "duplicate");
    count += 1; assert.equal(reopenedA.portable_object_count_before_duplicate, reopenedA.portable_object_count_after_duplicate);
    count += 1; assert.equal(reopenedB.portable_object_count_before_duplicate, reopenedB.portable_object_count_after_duplicate);
    count += 1; assert.equal(reopenedA.private_keys_non_extractable && reopenedB.private_keys_non_extractable, true);
    count += 1; assert.equal(reopenedB.full_history_verified, false);
    count += 1; assert(reopenedA.explicit_object_selections > 0 && reopenedB.explicit_object_selections > 0);
    count += 1; assert.equal(reopenedA.synchronization_planner_calls + reopenedB.synchronization_planner_calls, 0);
    count += 1; assert.equal(reopenedA.opfs_used || reopenedB.opfs_used, false);
    count += 1; assert.equal(reopenedA.accepted_from_nonportable_indexes + reopenedB.accepted_from_nonportable_indexes, 0);
    count += 1; assert.equal(reopenedA.acknowledgement_invalid.length + reopenedB.acknowledgement_invalid.length, 0);
    await invoke(profileA, "deleteConvergenceDatabases");
    await invoke(profileB, "deleteConvergenceDatabases");
    return {
      assertions: count,
      isolated_profiles: 2,
      admission_status: admitted.status,
      concurrent_mutations: [mutationA.title, mutationB.title],
      arrival_orders: [[mutationA.event_id, mutationB.event_id], [mutationB.event_id, mutationA.event_id]],
      final_state_categories: exactCategories,
      conflict_count: reopenedA.conflicts.length,
      acknowledgement_count: reopenedA.acknowledgements.length,
      receipt_count: reopenedA.receipts.length,
      profiles_closed_and_reopened: 2,
      portable_only_reconstruction: true,
      indexeddb_key_and_stream_continuity: true,
      device_b_full_history_verified: reopenedB.full_history_verified,
      synchronization_planner_calls: 0
    };
  } finally {
    await profileA?.close();
    await profileB?.close();
    rmSync(directoryA, { recursive: true, force: true });
    rmSync(directoryB, { recursive: true, force: true });
  }
}

function invoke(profile, method, args = []) {
  return evaluate(profile.page, { expression: `Promise.resolve(hc2conv[${JSON.stringify(method)}](...${JSON.stringify(args)})).then(clean)` });
}
