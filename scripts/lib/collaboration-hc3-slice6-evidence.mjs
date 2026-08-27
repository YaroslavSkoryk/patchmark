import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export const slice6EvidenceStatuses = Object.freeze(["pass", "conditional", "blocked", "not_exercised"]);
export const slice6EvidenceModes = Object.freeze(["automated", "manual"]);

const externalEvidenceKeys = Object.freeze([
  "schema_version", "record_kind", "authority", "evidence_session_id", "source_commit",
  "readiness_manifest_sha256", "synthetic_project", "fixture_hashes", "environment", "capabilities",
  "permissions", "artifacts", "assertions", "authority_equality", "policy", "cleanup",
  "test_timestamp"
]);
const environmentKeys = Object.freeze([
  "browser_name", "browser_version", "engine", "os_name", "os_version", "device_model",
  "execution_mode", "user_agent"
]);
const capabilityKeys = Object.freeze(["id", "browser_reported", "exercise_status", "detail_code"]);
const permissionKeys = Object.freeze(["id", "outcome", "evidence_mode", "status", "detail_code"]);
const artifactKeys = Object.freeze(["kind", "byte_length", "sha256"]);
const assertionKeys = Object.freeze(["id", "evidence_mode", "status", "detail_code"]);
const authorityKeys = Object.freeze(["status", "commitments", "reopen_equal"]);
const policyKeys = Object.freeze(["csp", "trusted_types", "violation_count"]);
const cleanupKeys = Object.freeze([
  "synthetic_project_removed", "profiles_removed", "camera_tracks_stopped", "peer_connections_closed",
  "channels_closed", "workers_stopped", "object_urls_revoked", "downloads_removed", "confirmed"
]);
const readinessRowKeys = Object.freeze([
  "id", "requirement", "evidence_source", "evidence_hash", "browser", "engine", "os", "device",
  "evidence_mode", "status", "residual_risk", "blocking", "required_approver",
  "expires_or_invalidates_on"
]);

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function createEvidenceSessionId(randomSource = randomBytes) {
  const bytes = randomSource(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    throw new Error("Evidence session randomness must provide exactly 16 bytes.");
  }
  return `hc3q_${Buffer.from(bytes).toString("hex")}`;
}

export function validateExternalQualificationEvidence(value) {
  const record = object(value, "external qualification evidence");
  exactKeys(record, externalEvidenceKeys, "external qualification evidence");
  equal(record.schema_version, 1, "Unsupported external evidence schema version.");
  equal(record.record_kind, "hc3_slice6_external_qualification_evidence", "Unexpected external evidence kind.");
  equal(record.authority, "none", "External qualification evidence never has project authority.");
  string(record.evidence_session_id, "evidence_session_id", 5, 96, /^hc3q_[a-z0-9_-]+$/);
  string(record.source_commit, "source_commit", 40, 64, /^[a-f0-9]+$/);
  string(record.readiness_manifest_sha256, "readiness_manifest_sha256", 64, 64, /^[a-f0-9]+$/);
  equal(record.synthetic_project, true, "External qualification must use a synthetic project.");
  array(record.fixture_hashes, "fixture_hashes", 1, 128).forEach((entry, index) => {
    const row = object(entry, `fixture_hashes[${index}]`);
    exactKeys(row, ["path", "sha256"], `fixture_hashes[${index}]`);
    string(row.path, `fixture_hashes[${index}].path`, 1, 256, /^scripts\/fixtures\/[A-Za-z0-9._-]+\.json$/);
    string(row.sha256, `fixture_hashes[${index}].sha256`, 64, 64, /^[a-f0-9]+$/);
  });

  const environment = object(record.environment, "environment");
  exactKeys(environment, environmentKeys, "environment");
  for (const key of environmentKeys) string(environment[key], `environment.${key}`, 1, key === "user_agent" ? 512 : 160);

  array(record.capabilities, "capabilities", 0, 64).forEach((entry, index) => {
    const row = object(entry, `capabilities[${index}]`);
    exactKeys(row, capabilityKeys, `capabilities[${index}]`);
    string(row.id, `capabilities[${index}].id`, 1, 96, /^[a-z0-9_]+$/);
    boolean(row.browser_reported, `capabilities[${index}].browser_reported`);
    status(row.exercise_status, `capabilities[${index}].exercise_status`);
    string(row.detail_code, `capabilities[${index}].detail_code`, 1, 160, /^[a-z0-9_.-]+$/);
  });

  array(record.permissions, "permissions", 0, 64).forEach((entry, index) => {
    const row = object(entry, `permissions[${index}]`);
    exactKeys(row, permissionKeys, `permissions[${index}]`);
    string(row.id, `permissions[${index}].id`, 1, 96, /^[a-z0-9_]+$/);
    string(row.outcome, `permissions[${index}].outcome`, 1, 96, /^[a-z0-9_]+$/);
    mode(row.evidence_mode, `permissions[${index}].evidence_mode`);
    status(row.status, `permissions[${index}].status`);
    string(row.detail_code, `permissions[${index}].detail_code`, 1, 160, /^[a-z0-9_.-]+$/);
  });

  array(record.artifacts, "artifacts", 0, 128).forEach((entry, index) => {
    const row = object(entry, `artifacts[${index}]`);
    exactKeys(row, artifactKeys, `artifacts[${index}]`);
    string(row.kind, `artifacts[${index}].kind`, 1, 96, /^[a-z0-9_]+$/);
    safeInteger(row.byte_length, `artifacts[${index}].byte_length`, 0, 64 * 1024 * 1024);
    string(row.sha256, `artifacts[${index}].sha256`, 64, 64, /^[a-f0-9]+$/);
  });

  array(record.assertions, "assertions", 0, 256).forEach((entry, index) => {
    const row = object(entry, `assertions[${index}]`);
    exactKeys(row, assertionKeys, `assertions[${index}]`);
    string(row.id, `assertions[${index}].id`, 1, 128, /^[a-z0-9_]+$/);
    mode(row.evidence_mode, `assertions[${index}].evidence_mode`);
    status(row.status, `assertions[${index}].status`);
    string(row.detail_code, `assertions[${index}].detail_code`, 1, 160, /^[a-z0-9_.-]+$/);
  });

  const authority = object(record.authority_equality, "authority_equality");
  exactKeys(authority, authorityKeys, "authority_equality");
  status(authority.status, "authority_equality.status");
  const commitments = object(authority.commitments, "authority_equality.commitments");
  if (Object.keys(commitments).length > 64) throw new Error("Too many authority commitments.");
  for (const [key, digest] of Object.entries(commitments)) {
    string(key, "authority commitment name", 1, 96, /^[a-z0-9_]+$/);
    string(digest, `authority_equality.commitments.${key}`, 64, 64, /^[a-f0-9]+$/);
  }
  boolean(authority.reopen_equal, "authority_equality.reopen_equal");

  const policy = object(record.policy, "policy");
  exactKeys(policy, policyKeys, "policy");
  status(policy.csp, "policy.csp");
  status(policy.trusted_types, "policy.trusted_types");
  safeInteger(policy.violation_count, "policy.violation_count", 0, 10_000);

  const cleanup = object(record.cleanup, "cleanup");
  exactKeys(cleanup, cleanupKeys, "cleanup");
  for (const key of cleanupKeys) boolean(cleanup[key], `cleanup.${key}`);
  string(record.test_timestamp, "test_timestamp", 20, 40);
  if (!Number.isFinite(Date.parse(record.test_timestamp))) throw new Error("test_timestamp must be ISO-8601 compatible.");

  const serialized = JSON.stringify(record);
  if (serialized.length > 512 * 1024) throw new Error("External evidence exceeds the 512 KiB record limit.");
  rejectSensitiveEvidence(serialized);
  return Object.freeze(structuredClone(record));
}

export function summarizeExternalQualificationEvidence(value) {
  const record = validateExternalQualificationEvidence(value);
  const totals = Object.fromEntries(slice6EvidenceStatuses.map((entry) => [entry, 0]));
  for (const row of [
    ...record.capabilities.map((entry) => ({ status: entry.exercise_status })),
    ...record.permissions,
    ...record.assertions,
    { status: record.authority_equality.status },
    { status: record.policy.csp },
    { status: record.policy.trusted_types }
  ]) {
    totals[row.status] += 1;
  }
  return Object.freeze({
    evidence_session_id: record.evidence_session_id,
    authority: "none",
    environment: `${record.environment.browser_name} ${record.environment.browser_version} / ${record.environment.os_name} ${record.environment.os_version}`,
    totals: Object.freeze(totals),
    cleanup_confirmed: record.cleanup.confirmed,
    authority_equality: record.authority_equality.status
  });
}

export function validateSlice6ReadinessMatrix(value) {
  const matrix = object(value, "Slice 6 readiness matrix");
  exactKeys(matrix, ["schema_version", "record_kind", "baseline_commit", "production_enabled", "classification", "browser_floor", "items"], "Slice 6 readiness matrix");
  equal(matrix.schema_version, 2, "Unsupported Slice 6 readiness schema.");
  equal(matrix.record_kind, "hc3_slice6_readiness_matrix", "Unexpected Slice 6 readiness kind.");
  string(matrix.baseline_commit, "baseline_commit", 40, 64, /^[a-f0-9]+$/);
  equal(matrix.production_enabled, false, "Slice 6 must not enable production collaboration.");
  if (!["ready_for_enablement_design", "conditional", "blocked"].includes(matrix.classification)) throw new Error("Invalid Slice 6 classification.");
  string(matrix.browser_floor, "browser_floor", 1, 256);
  const ids = new Set();
  array(matrix.items, "items", 1, 256).forEach((entry, index) => {
    const row = object(entry, `items[${index}]`);
    exactKeys(row, readinessRowKeys, `items[${index}]`);
    string(row.id, `items[${index}].id`, 4, 96, /^HC3-S6-[A-Z0-9-]+$/);
    if (ids.has(row.id)) throw new Error(`Duplicate readiness ID: ${row.id}`);
    ids.add(row.id);
    for (const key of ["requirement", "evidence_source", "browser", "engine", "os", "device", "residual_risk", "required_approver"]) {
      string(row[key], `items[${index}].${key}`, 1, 512);
    }
    if (row.evidence_hash !== null) string(row.evidence_hash, `items[${index}].evidence_hash`, 64, 64, /^[a-f0-9]+$/);
    if (!slice6EvidenceModes.includes(row.evidence_mode) && row.evidence_mode !== "mixed") throw new Error(`Invalid evidence mode in ${row.id}.`);
    status(row.status, `items[${index}].status`);
    boolean(row.blocking, `items[${index}].blocking`);
    array(row.expires_or_invalidates_on, `items[${index}].expires_or_invalidates_on`, 1, 32)
      .forEach((condition, conditionIndex) => string(condition, `items[${index}].expires_or_invalidates_on[${conditionIndex}]`, 1, 256));
    if ((row.status === "blocked" || row.status === "not_exercised") && row.evidence_hash !== null) {
      throw new Error(`${row.id} must not attach a pass-like evidence hash to missing or blocked evidence.`);
    }
  });
  return Object.freeze(structuredClone(matrix));
}

export function validateReviewManifest(value) {
  const manifest = object(value, "review manifest");
  exactKeys(manifest, ["schema_version", "record_kind", "baseline_commit", "production_enabled", "browser_floor", "covered_files", "invalidation_categories"], "review manifest");
  equal(manifest.schema_version, 1, "Unsupported review manifest schema.");
  equal(manifest.record_kind, "hc3_slice6_security_review_manifest", "Unexpected review manifest kind.");
  string(manifest.baseline_commit, "baseline_commit", 40, 64, /^[a-f0-9]+$/);
  equal(manifest.production_enabled, false, "Review manifest cannot enable production collaboration.");
  string(manifest.browser_floor, "browser_floor", 1, 256);
  const paths = new Set();
  array(manifest.covered_files, "covered_files", 1, 2_000).forEach((entry, index) => {
    const row = object(entry, `covered_files[${index}]`);
    exactKeys(row, ["path", "sha256", "category"], `covered_files[${index}]`);
    string(row.path, `covered_files[${index}].path`, 1, 512);
    if (row.path.startsWith("/") || row.path.includes("..") || row.path.includes("\\")) throw new Error("Manifest paths must be repository-relative.");
    if (paths.has(row.path)) throw new Error(`Duplicate manifest path: ${row.path}`);
    paths.add(row.path);
    string(row.sha256, `covered_files[${index}].sha256`, 64, 64, /^[a-f0-9]+$/);
    string(row.category, `covered_files[${index}].category`, 1, 96, /^[a-z0-9_]+$/);
  });
  const categories = array(manifest.invalidation_categories, "invalidation_categories", 1, 64);
  for (const required of ["covered_source", "dependency_version", "frozen_fixture", "browser_floor", "security_policy", "product_authority_driver", "protocol_version"]) {
    if (!categories.includes(required)) throw new Error(`Review manifest is missing invalidation category ${required}.`);
  }
  return Object.freeze(structuredClone(manifest));
}

export function evaluateReviewManifestCurrency(value, repositoryRoot, expectedBrowserFloor) {
  const manifest = validateReviewManifest(value);
  const stale = [];
  if (manifest.browser_floor !== expectedBrowserFloor) stale.push(Object.freeze({ kind: "browser_floor", path: null }));
  for (const entry of manifest.covered_files) {
    const absolutePath = resolve(repositoryRoot, entry.path);
    if (!absolutePath.startsWith(`${resolve(repositoryRoot)}${sep}`)) throw new Error("Manifest path escaped repository root.");
    let actual = null;
    try { actual = sha256File(absolutePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (actual !== entry.sha256) stale.push(Object.freeze({ kind: entry.category, path: entry.path }));
  }
  return Object.freeze({ current: stale.length === 0, stale: Object.freeze(stale) });
}

export function externalQualificationBootstrapSource(input) {
  const sessionId = string(input.evidence_session_id, "evidence_session_id", 5, 96, /^hc3q_[a-z0-9_-]+$/);
  const sourceCommit = string(input.source_commit, "source_commit", 40, 64, /^[a-f0-9]+$/);
  const manifestSha256 = string(input.readiness_manifest_sha256, "readiness_manifest_sha256", 64, 64, /^[a-f0-9]+$/);
  const fixtureHashes = array(input.fixture_hashes, "fixture_hashes", 1, 128).map((entry, index) => {
    const row = object(entry, `fixture_hashes[${index}]`);
    exactKeys(row, ["path", "sha256"], `fixture_hashes[${index}]`);
    string(row.path, `fixture_hashes[${index}].path`, 1, 256, /^scripts\/fixtures\/[A-Za-z0-9._-]+\.json$/);
    string(row.sha256, `fixture_hashes[${index}].sha256`, 64, 64, /^[a-f0-9]+$/);
    return Object.freeze({ path: row.path, sha256: row.sha256 });
  });
  return `(() => {
    const capabilityDefinitions = ${JSON.stringify([
      ["indexeddb", "indexedDB"], ["webcrypto", "crypto.subtle"], ["web_locks", "navigator.locks.request"],
      ["opfs", "navigator.storage.getDirectory"], ["file_open", "showOpenFilePicker"], ["file_save", "showSaveFilePicker"],
      ["clipboard_write", "navigator.clipboard.writeText"], ["text_share", "navigator.share"], ["file_share", "navigator.canShare"],
      ["native_qr", "BarcodeDetector"], ["camera", "navigator.mediaDevices.getUserMedia"], ["webrtc", "RTCPeerConnection"],
      ["trusted_types", "trustedTypes"]
    ])};
    const lookup = (path) => path.split('.').reduce((value, key) => value?.[key], globalThis);
    const capabilities = capabilityDefinitions.map(([id, path]) => Object.freeze({
      id, browser_reported: Boolean(lookup(path)), exercise_status: 'not_exercised',
      detail_code: Boolean(lookup(path)) ? 'browser_reports_available' : 'browser_reports_unavailable'
    }));
    const cleanup = {
      synthetic_project_removed: false, profiles_removed: false, camera_tracks_stopped: false,
      peer_connections_closed: false, channels_closed: false, workers_stopped: false,
      object_urls_revoked: false, downloads_removed: false, confirmed: false
    };
    const record = {
      schema_version: 1, record_kind: 'hc3_slice6_external_qualification_evidence', authority: 'none',
      evidence_session_id: ${JSON.stringify(sessionId)}, source_commit: ${JSON.stringify(sourceCommit)},
      readiness_manifest_sha256: ${JSON.stringify(manifestSha256)}, synthetic_project: true,
      fixture_hashes: ${JSON.stringify(fixtureHashes)},
      environment: {
        browser_name: 'browser_reported', browser_version: navigator.userAgent,
        engine: 'reviewer_must_classify', os_name: navigator.platform || 'browser_reported',
        os_version: navigator.userAgent, device_model: navigator.userAgentData?.model || 'not_reported',
        execution_mode: matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
        user_agent: navigator.userAgent
      },
      capabilities, permissions: [], artifacts: [], assertions: [],
      authority_equality: { status: 'not_exercised', commitments: {}, reopen_equal: false },
      policy: { csp: 'not_exercised', trusted_types: globalThis.trustedTypes ? 'conditional' : 'not_exercised', violation_count: 0 },
      cleanup, test_timestamp: new Date().toISOString()
    };
    const api = Object.freeze({
      snapshot: () => structuredClone(record),
      recordAssertion(entry) { record.assertions.push(Object.freeze(structuredClone(entry))); },
      recordPermission(entry) { record.permissions.push(Object.freeze(structuredClone(entry))); },
      recordArtifact(entry) { record.artifacts.push(Object.freeze(structuredClone(entry))); },
      recordAuthorityEquality(entry) { record.authority_equality = Object.freeze(structuredClone(entry)); },
      recordPolicy(entry) { record.policy = Object.freeze(structuredClone(entry)); },
      confirmCleanup(entry) { Object.assign(cleanup, structuredClone(entry)); cleanup.confirmed = Object.entries(cleanup).filter(([key]) => key !== 'confirmed').every(([, value]) => value === true); },
      download() {
        const blob = new Blob([JSON.stringify(record, null, 2) + '\\n'], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
        anchor.href = url; anchor.download = record.evidence_session_id + '.json'; anchor.click(); URL.revokeObjectURL(url);
      }
    });
    Object.defineProperty(window, '__patchmarkHc3Slice6Evidence', { value: api, configurable: false });
    addEventListener('DOMContentLoaded', () => {
      const panel = document.createElement('section'); panel.id = 'hc3-slice6-evidence-panel'; panel.setAttribute('aria-labelledby', 'hc3-slice6-evidence-title');
      const title = document.createElement('h1'); title.id = 'hc3-slice6-evidence-title'; title.textContent = 'HC-3 external qualification';
      const session = document.createElement('p'); session.dataset.testid = 'hc3-slice6-evidence-session'; session.textContent = 'Evidence session: ' + record.evidence_session_id;
      const notice = document.createElement('p'); notice.textContent = 'Synthetic qualification project only. Evidence has no project authority and is never uploaded.';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Download authority-free evidence'; button.addEventListener('click', () => api.download());
      panel.append(title, session, notice, button); document.body.prepend(panel);
    }, { once: true });
  })();`;
}

function rejectSensitiveEvidence(serialized) {
  if (/pmhc3\.|-----BEGIN|private[_ -]?key|recovery[_ -]?(?:material|secret|bytes)|file:\/\/|\/(?:Users|home)\//i.test(serialized)) {
    throw new Error("Qualification evidence contains forbidden secret, artifact, or absolute-path material.");
  }
  if (/[A-Za-z0-9+/]{512,}={0,2}/.test(serialized)) throw new Error("Qualification evidence contains an oversized encoded value.");
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}
function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has unexpected or missing fields.`);
}
function array(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} has an invalid item count.`);
  return value;
}
function string(value, label, minimum, maximum, pattern = null) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || (pattern && !pattern.test(value))) throw new Error(`${label} is invalid.`);
  return value;
}
function boolean(value, label) { if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`); }
function safeInteger(value, label, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid.`); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message); }
function status(value, label) { if (!slice6EvidenceStatuses.includes(value)) throw new Error(`${label} has an invalid evidence status.`); }
function mode(value, label) { if (!slice6EvidenceModes.includes(value)) throw new Error(`${label} has an invalid evidence mode.`); }
