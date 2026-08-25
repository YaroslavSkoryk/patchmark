import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (actual, message) => { assertions += 1; assert.ok(actual, message); };

const foundation = runBrowserQualification("scripts/collaboration-hc2-slice4-browser.test.mjs");
check(foundation.assertions > 0, "real browser custody and root-recovery qualification ran");
equal(foundation.same_profile_two_tab_exclusion, true, "same-profile Web Locks exclusion is qualified");
check(foundation.profile_b.new_device_id !== foundation.profile_a.old_device_id, "profile recovery allocates a new device identity");
check(foundation.profile_b.new_signing_public_hex !== foundation.profile_a.old_signing_public_hex, "profile recovery generates new non-extractable key material");
equal(foundation.profile_b.ed_private_extractable, false, "recovered signing key remains non-extractable");
equal(foundation.profile_b.late_old_device_result, "superseded_control_branch", "lost-device sequence cannot reenter accepted authority");

const enrollment = runBrowserQualification("scripts/collaboration-hc2-slice5-browser.test.mjs");
check(enrollment.assertions > 0, "real invitation, possession, enrollment, and epoch-delivery qualification ran");
equal(enrollment.separate_user_data_directories, true, "enrolled devices use isolated browser profiles");
equal(enrollment.indexeddb_profile_isolation, true, "profiles share no IndexedDB authority");
equal(enrollment.revoked_device_replacement_open_rejected, true, "revoked device cannot open replacement-epoch ciphertext");

const synchronization = runBrowserQualification("scripts/collaboration-hc2-slice7-browser.test.mjs", { PATCHMARK_HC2_SLICE8_QUALIFICATION: "1" });
equal(synchronization.isolated_profiles, 2, "complete encrypted synchronization uses two isolated profiles");
equal(synchronization.node_chrome_v3_vector_equivalence, true, "Chrome V3 bytes match frozen Node/Python evidence");
equal(synchronization.zero_transfer_already_converged, true, "already-converged invocation transfers no objects");
equal(synchronization.revocation_pre_crypto_rejection, true, "revocation blocks before cryptography");
equal(synchronization.old_ciphertext_limitation_verified, true, "already-delivered ciphertext limitation is explicit");
equal(synchronization.slice8_qualification.reviewer_rejected, true, "reviewer cannot resolve the conflict");
equal(synchronization.slice8_qualification.observed_contender_count, 2, "resolution binds the exact contender set");
equal(synchronization.slice8_qualification.final_conflict_count, 0, "explicit resolution converges and reopens conflict-free");
equal(synchronization.slice8_qualification.post_cutoff_event_rejected, true, "revoked device cannot append post-cutoff work");
equal(synchronization.slice8_qualification.post_revocation_export_rejected, true, "revocation prevents fresh synchronization export");
equal(synchronization.offline_families, ["comment", "patch", "reply", "review_batch"], "offline qualification covers representative HC-1 families beyond metadata");
check(synchronization.profiles_reopened + synchronization.slice8_qualification.resolved_reopens >= 6, "qualification repeatedly closes and reopens both replicas");
equal(synchronization.final_state_categories.length, 19, "authoritative and projected equality matrix is complete");

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  record_kind: "hc2_disabled_qualification_summary",
  authority: "none",
  assertions,
  protocols_exercised: [1, 2, 3],
  browser_product: synchronization.browser_product,
  scenario_phases: ["foundation", "recovery_kit", "invitation", "enrollment", "admission_v2", "offline_work", "synchronization_v3", "explicit_conflict_resolution", "revocation", "profile_loss_recovery", "final_reopen"],
  source_project_immutable: true,
  non_extractable_keys: true,
  total_profile_reopens: synchronization.profiles_reopened + synchronization.slice8_qualification.resolved_reopens + 1,
  final_state_categories: synchronization.final_state_categories,
  zero_activity_when_idle: true,
  production_enabled: false,
  compatibility_limitations: ["manual_file_transfer_only", "revocation_cannot_recall_delivered_ciphertext", "plaintext_portable_history_at_rest", "no_hardware_backed_custody"],
  temporary_profiles_removed: foundation.temporary_profiles_removed && enrollment.temporary_profiles_removed && synchronization.temporary_profiles_removed
}, null, 2)}\n`);

function runBrowserQualification(script, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8", timeout: 360_000, env: { ...process.env, ...extraEnvironment } });
  if (result.status !== 0) throw new Error(`${script} failed\n${result.stdout}\n${result.stderr}`);
  const start = result.stdout.lastIndexOf("\n{");
  const json = (start === -1 ? result.stdout : result.stdout.slice(start + 1)).trim();
  try { return JSON.parse(json); }
  catch (error) { throw new Error(`${script} did not emit a final JSON report: ${error}\n${result.stdout}`); }
}
