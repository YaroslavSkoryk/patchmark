import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };

const surface = runBrowserQualification("scripts/collaboration-hc3-slice2-surface-browser.test.mjs");
check(surface.assertions >= 25, "test-only workflow surface exercised its accessibility and confirmation boundaries");
equal(surface.keyboard_operable, true, "workflow surface is keyboard operable");
equal(surface.predictable_focus, true, "workflow feedback receives predictable focus");
equal(surface.clipboard_exact_text, true, "HC-3 Invitation copy uses exact canonical text");
equal(surface.qr_capability_exercised, false, "headless Chrome does not falsely claim a QR capability");
equal(surface.qr_unsupported_fallback, true, "QR unavailability exposes copy fallback");
equal(surface.os_share_capability_exercised, false, "headless Chrome does not falsely claim an OS share sheet");
equal(surface.share_cancellation_fallback, true, "share cancellation preserves fallback guidance");
equal(surface.selection_without_import, true, "file selection performs no automatic import");

const enrollment = runBrowserQualification("scripts/collaboration-hc2-slice5-browser.test.mjs");
check(enrollment.assertions > 10, "real HC-2 Invitation, enrollment, possession, and epoch-delivery ceremony ran");
equal(enrollment.separate_user_data_directories, true, "owner and candidate enrollment use isolated profiles");
equal(enrollment.indexeddb_profile_isolation, true, "profiles share no IndexedDB authority");
equal(enrollment.webcrypto_ed25519_x25519_nonextractable_reopen, true, "candidate possession uses reopened non-extractable browser keys");
equal(enrollment.owner_two_tab_cas, true, "competing invitation consumption still has one accepted HC-2 CAS result");
equal(enrollment.candidate_epoch_install_and_reopen, true, "candidate installs the epoch only after authenticated possession proof");

const admissionAndExchange = runBrowserQualification("scripts/collaboration-hc2-slice6-browser.test.mjs");
const convergenceV2 = admissionAndExchange.convergence;
equal(convergenceV2.isolated_profiles, 2, "V2 admission and explicit replication use two isolated profiles");
equal(convergenceV2.admission_status, "imported", "candidate explicitly imports the encrypted V2 admission file");
equal(convergenceV2.device_b_full_history_verified, false, "candidate retains the bounded admission-history marker");
equal(convergenceV2.synchronization_planner_calls, 0, "explicit Slice 6 file selections do not invoke future synchronization planning");
equal(convergenceV2.profiles_closed_and_reopened, 2, "both V2 replicas close and reopen from portable and IndexedDB continuity state");
equal(convergenceV2.final_state_categories.length, 19, "V2 exchange compares authoritative and projected state, not file commitments alone");
check(convergenceV2.concurrent_mutations.length === 2, "both profiles create genuinely independent accepted work");
equal(convergenceV2.conflict_count, 1, "legitimate concurrent conflict is retained identically");

const synchronization = runBrowserQualification("scripts/collaboration-hc2-slice7-browser.test.mjs");
equal(synchronization.isolated_profiles, 2, "V3 bounded synchronization uses the same two-profile security boundary");
equal(synchronization.node_chrome_v3_vector_equivalence, true, "Chrome V3 bytes match frozen Node/Python evidence");
check(synchronization.multi_rounds > 1, "manual V3 exchange repeats through a bounded number of explicit rounds");
equal(synchronization.zero_transfer_already_converged, true, "final explicit exchange contains zero object records");
equal(synchronization.final_state_categories.length, 19, "reopened V3 replicas match across the complete authoritative/projected matrix");
check(synchronization.receipt_count > 0 && synchronization.acknowledgement_count > 0, "return exchange closes receipt and acknowledgement evidence");
check(synchronization.profiles_reopened >= 4, "synchronization survives interruption and final portable reopen");
equal(synchronization.temporary_profiles_removed, true, "V3 temporary Chrome profiles are removed");

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  record_kind: "hc3_slice2_manual_browser_qualification",
  authority: "none",
  assertions,
  browser_product: synchronization.browser_product,
  isolated_profiles: 2,
  real_hc2_phases: ["invitation", "enrollment", "possession_proof", "authorization", "admission_v2", "receipt", "synchronization_v3", "convergence", "portable_reopen"],
  hc3_carriers: ["Invitation", "Response", "Encrypted update"],
  exact_hc3_copy_port: true,
  explicit_v2_selection_and_confirmation: true,
  explicit_v3_selection_and_confirmation: true,
  admission_full_history_verified: convergenceV2.device_b_full_history_verified,
  bounded_manual_rounds: synchronization.multi_rounds,
  duplicate_files_are_noops: true,
  final_zero_object_exchange: synchronization.zero_transfer_already_converged,
  final_state_categories: synchronization.final_state_categories,
  total_profile_reopens: convergenceV2.profiles_closed_and_reopened + synchronization.profiles_reopened,
  qr_platform_result: "unsupported_with_copy_fallback",
  share_platform_result: "unsupported_or_cancelled_with_copy_fallback",
  networking_added: false,
  production_enabled: false,
  temporary_profiles_removed: enrollment.temporary_profiles_removed && admissionAndExchange.temporary_profiles_removed && synchronization.temporary_profiles_removed
}, null, 2)}\n`);

function runBrowserQualification(script) {
  const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8", timeout: 480_000, env: process.env });
  if (result.status !== 0) throw new Error(`${script} failed\n${result.stdout}\n${result.stderr}`);
  const start = result.stdout.lastIndexOf("\n{");
  const json = (start === -1 ? result.stdout : result.stdout.slice(start + 1)).trim();
  try { return JSON.parse(json); }
  catch (error) { throw new Error(`${script} did not emit a final JSON report: ${error}\n${result.stdout}`); }
}
