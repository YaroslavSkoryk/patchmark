"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent
} from "react";
import {
  detectHc3ProductCapabilities,
  hc3ProductCapabilityNames,
  readInjectedHc3ProductQualificationDriver,
  safeHc3DiagnosticMessage,
  safeHc3DisplayLabel,
  unavailableHc3ProductSnapshot,
  validateHc3ProductActionInput,
  type Hc3ProductAction,
  type Hc3ProductCapabilityMatrix,
  type Hc3ProductQualificationDriver,
  type Hc3ProductSnapshot,
} from "@/lib/collaboration/hc3/index.ts";
import {
  decodeHc3QrImage,
  renderHc3QrMatrix,
  type Hc3QrArtifactKind,
  type Hc3QrMatrix
} from "@/lib/collaboration/hc3/qr-provider.ts";
import { Hc3ExplicitQrScanner } from "@/lib/collaboration/hc3/qr-scanner.ts";
import styles from "./collaboration-qualification-workspace.module.css";

export type CollaborationQualificationWorkspaceProps = Readonly<{
  sourceProjectId: string;
  sourceProjectTitle: string;
  onClose(): void;
}>;

const sectionLabels = Object.freeze([
  "Set up collaboration",
  "Recovery kit",
  "Invite collaborator",
  "Complete invitation",
  "Collaborators and devices",
  "Synchronize changes",
  "Conflicts",
  "Privacy and safety",
  "Recovery and blocked states"
]);

const actionLabels: Readonly<Record<Hc3ProductAction, string>> = Object.freeze({
  create_collaboration_copy: "Create collaboration copy",
  verify_recovery_kit: "Verify recovery kit",
  create_invitation: "Invite collaborator",
  cancel_invitation: "Cancel invitation",
  preview_received_artifact: "Preview received item",
  continue_invitation: "Continue invitation",
  create_response: "Create Response",
  authorize_admission: "Approve collaborator",
  save_encrypted_file: "Save encrypted file",
  select_encrypted_file: "Choose encrypted file",
  preview_encrypted_file: "Preview encrypted file",
  import_encrypted_file: "Import encrypted file",
  create_direct_offer: "Create connection request",
  open_direct_offer: "Open connection request",
  create_direct_answer: "Create connection response",
  open_direct_answer: "Open connection response",
  sync_directly: "Sync now",
  use_encrypted_file: "Send encrypted update",
  change_role: "Change role",
  revoke_device: "Revoke device",
  revoke_membership: "Remove collaborator",
  resolve_conflict: "Resolve conflict",
  reopen_and_verify: "Reopen and verify"
});

export function CollaborationQualificationWorkspace({
  sourceProjectId,
  sourceProjectTitle,
  onClose
}: CollaborationQualificationWorkspaceProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scannerRef = useRef<Hc3ExplicitQrScanner | null>(null);
  const requestRef = useRef(0);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const driverRef = useRef<Hc3ProductQualificationDriver | null>(null);
  const busyRef = useRef(false);
  const [snapshot, setSnapshot] = useState<Hc3ProductSnapshot>(() =>
    unavailableHc3ProductSnapshot({ project_id: sourceProjectId, project_title: sourceProjectTitle })
  );
  const [capabilities, setCapabilities] = useState<Hc3ProductCapabilityMatrix | null>(null);
  const [activeSection, setActiveSection] = useState(sectionLabels[0]);
  const [busy, setBusy] = useState(false);
  const [artifactInput, setArtifactInput] = useState("");
  const [role, setRole] = useState<"editor" | "reviewer">("editor");
  const [qr, setQr] = useState<Hc3QrMatrix | null>(null);
  const [statusMessage, setStatusMessage] = useState("Opening collaboration guidance…");
  const [error, setError] = useState<string | null>(null);
  const [scanCapability, setScanCapability] = useState<string | null>(null);
  const selectedContenders = useMemo(
    () => snapshot.conflicts.flatMap((conflict) => conflict.contenders.map((contender) => contender.contender_id)),
    [snapshot.conflicts]
  );

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    const driver = readInjectedHc3ProductQualificationDriver(window, sourceProjectId);
    driverRef.current = driver;
    let active = true;
    const request = ++requestRef.current;
    void Promise.all([
      driver?.inspect({ project_id: sourceProjectId }) ?? Promise.resolve(snapshot),
      detectHc3ProductCapabilities({
        isSecureContext,
        navigator,
        document,
        indexedDB,
        crypto,
        CryptoKey,
        RTCPeerConnection: window.RTCPeerConnection,
        BarcodeDetector: barcodeDetectorConstructor(),
        createImageBitmap,
        showOpenFilePicker: filePickerWindow().showOpenFilePicker,
        showSaveFilePicker: filePickerWindow().showSaveFilePicker
      })
    ]).then(([next, matrix]) => {
      if (!active || request !== requestRef.current) return;
      setSnapshot(next as Hc3ProductSnapshot);
      setCapabilities(matrix);
      setStatusMessage((next as Hc3ProductSnapshot).explanation);
    }).catch((reason) => {
      if (!active) return;
      setError(safeError(reason));
      setStatusMessage("Collaboration guidance could not be reconstructed safely.");
    });
    return () => {
      active = false;
      requestRef.current += 1;
      scannerRef.current?.cancel();
      scannerRef.current = null;
      driverRef.current?.closeOperationalWork?.();
      driverRef.current = null;
      setQr(null);
      restoreFocusRef.current?.focus();
    };
    // Initial reconstruction is intentionally one explicit workspace-open boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceProjectId]);

  useEffect(() => {
    if (!qr || !canvasRef.current) return;
    drawQr(canvasRef.current, qr);
  }, [qr]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function closeWorkspace() {
    scannerRef.current?.cancel();
    scannerRef.current = null;
    setQr(null);
    setArtifactInput("");
    onClose();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      closeWorkspace();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableWithin(dialogRef.current);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function invoke(action: Hc3ProductAction, selectedId?: string) {
    const driver = driverRef.current;
    if (!driver || busyRef.current || !snapshot.available_actions.includes(action)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setQr(null);
    const request = ++requestRef.current;
    try {
      const next = await driver.invoke(validateHc3ProductActionInput({
        action,
        expected_revision: snapshot.revision,
        project_id: sourceProjectId,
        ...(action === "create_invitation" ? { role } : {}),
        ...(requiresArtifactText(action) ? { artifact_text: artifactInput } : {}),
        ...(selectedId ? { selected_id: selectedId } : {}),
        ...(action === "resolve_conflict" ? { contender_ids: selectedContenders } : {})
      }));
      if (request !== requestRef.current) return;
      setSnapshot(next as Hc3ProductSnapshot);
      setStatusMessage((next as Hc3ProductSnapshot).explanation);
      if ((next as Hc3ProductSnapshot).artifact?.text !== snapshot.artifact?.text) setArtifactInput("");
    } catch (reason) {
      if (request !== requestRef.current) return;
      setError(safeError(reason));
      setStatusMessage("The action stopped without changing displayed authority. Recheck current project state before retrying.");
    } finally {
      busyRef.current = false;
      if (request === requestRef.current) setBusy(false);
    }
  }

  async function copyArtifact() {
    const text = snapshot.artifact?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage("Copied the exact prepared item.");
    } catch {
      setError("Clipboard access was denied. Select and copy the prepared item manually.");
    }
  }

  async function shareArtifact() {
    const artifact = snapshot.artifact;
    if (!artifact || !navigator.share) return;
    try {
      if (artifact.text) await navigator.share({ title: labelArtifact(artifact.kind), text: artifact.text });
      else if (artifact.exact_bytes && artifact.filename) {
        const file = new File([artifact.exact_bytes.slice().buffer as ArrayBuffer], artifact.filename, { type: "application/vnd.patchmark.collaboration-bundle" });
        if (!navigator.canShare?.({ files: [file] })) throw new Error("File sharing is unavailable.");
        await navigator.share({ title: "Encrypted update", files: [file] });
      }
      setStatusMessage("The prepared item was handed to the system share sheet.");
    } catch (reason) {
      setError(isAbort(reason) ? "Sharing was cancelled. The prepared item is still available." : "Sharing failed. The prepared item is still available for copy or save.");
    }
  }

  function showQr() {
    const artifact = snapshot.artifact;
    if (!artifact?.text || !artifact.eligible_for_qr) return;
    try {
      setQr(renderHc3QrMatrix({ artifact_kind: qrKind(artifact.kind), text: artifact.text }));
      setStatusMessage("QR ready. It carries the exact prepared text but grants no access by itself.");
    } catch (reason) {
      setError(safeError(reason));
    }
  }

  async function scanQr() {
    const Detector = barcodeDetectorConstructor();
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setError("Camera QR scanning is unavailable. Choose a QR image or paste the exact text.");
      return;
    }
    setError(null);
    const scanner = new Hc3ExplicitQrScanner({
      document,
      navigator,
      request_animation_frame: requestAnimationFrame,
      cancel_animation_frame: cancelAnimationFrame,
      create_detector: () => new Detector({ formats: ["qr_code"] }),
      create_video: () => document.createElement("video")
    });
    scannerRef.current = scanner;
    try {
      const text = await scanner.scan({ artifact_kind: expectedInputKind(snapshot), on_capability: setScanCapability });
      setArtifactInput(text);
      setStatusMessage("QR decoded. Preview it before any collaboration action.");
    } catch (reason) {
      if (!String(reason).includes("cancelled")) setError("QR scanning stopped. No decoded item was retained.");
    } finally {
      scanner.cancel();
      scannerRef.current = null;
    }
  }

  async function readQrImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      setError("The selected QR image is too large.");
      return;
    }
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 16_777_216) throw new Error("QR image dimensions are too large.");
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Image decoding canvas is unavailable.");
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const text = decodeHc3QrImage({ artifact_kind: expectedInputKind(snapshot), width: image.width, height: image.height, rgba: image.data });
      setArtifactInput(text);
      setStatusMessage("QR image decoded locally. Preview it before continuing.");
    } catch (reason) {
      setError(safeError(reason));
    } finally {
      bitmap?.close();
    }
  }

  function savePreparedFile() {
    const artifact = snapshot.artifact;
    if (!artifact?.exact_bytes || !artifact.filename) return;
    const blob = new Blob([artifact.exact_bytes.slice().buffer as ArrayBuffer], { type: "application/vnd.patchmark.collaboration-bundle" });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      anchor.rel = "noopener";
      anchor.click();
      anchor.remove();
      setStatusMessage("Encrypted file prepared for saving. The same exact bytes remain available if saving fails.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const artifact = snapshot.artifact;
  return (
    <div className={styles.backdrop} data-testid="collaboration-qualification-backdrop">
      <section
        ref={dialogRef}
        className={styles.workspace}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-workspace-title"
        aria-describedby="collaboration-workspace-boundary"
        aria-busy={busy || undefined}
        data-testid="collaboration-qualification-workspace"
        data-project-id={sourceProjectId}
        onKeyDown={handleDialogKeyDown}
      >
        <header className={styles.header}>
          <div>
            <span>Development qualification</span>
            <h2 id="collaboration-workspace-title" ref={headingRef} tabIndex={-1}>Collaboration</h2>
            <p id="collaboration-workspace-boundary">Every handoff and synchronization step is explicit. No account or cloud service is used.</p>
          </div>
          <button type="button" onClick={closeWorkspace} disabled={busy}>Close</button>
        </header>

        <div className={styles.layout}>
          <nav className={styles.sections} aria-label="Collaboration steps">
            {sectionLabels.map((section) => (
              <button key={section} type="button" aria-current={activeSection === section ? "step" : undefined} onClick={() => setActiveSection(section)}>
                {section}
              </button>
            ))}
          </nav>

          <main className={styles.content}>
            <section className={styles.statusCard} aria-live="polite" aria-atomic="true" tabIndex={-1}>
              <span>Next recommended action</span>
              <h3>{snapshot.title}</h3>
              <p>{statusMessage}</p>
              {snapshot.recommended_action ? (
                <button className={styles.primary} type="button" disabled={busy} onClick={() => void invoke(snapshot.recommended_action!)}>
                  {busy ? "Working…" : actionLabels[snapshot.recommended_action]}
                </button>
              ) : null}
            </section>

            {error ? <p ref={errorRef} className={styles.error} role="alert" tabIndex={-1}>{error}</p> : null}

            {activeSection === "Set up collaboration" ? (
              <section className={styles.panel} aria-labelledby="collaboration-setup-heading">
                <h3 id="collaboration-setup-heading">Create a separate collaboration copy</h3>
                <p>The original project stays unchanged. The new destination contains current shared content, never paths, bookmarks, editor state, review overrides, or recovery data.</p>
                <strong>{safeHc3DisplayLabel(sourceProjectTitle)}</strong>
                <p className={styles.note}>Project files remain readable on this device and in ordinary backups unless the folder or device is protected separately.</p>
                {actionButton("create_collaboration_copy", snapshot, busy, invoke)}
              </section>
            ) : null}

            {activeSection === "Recovery kit" ? (
              <section className={styles.panel}>
                <h3>Recovery kit</h3>
                <p>Save, reopen, and complete the recovery challenge before inviting anyone.</p>
                <p className={styles.state}>{snapshot.recovery_kit_verified ? "Verified on this device" : "Verification required"}</p>
                {actionButton("verify_recovery_kit", snapshot, busy, invoke)}
              </section>
            ) : null}

            {activeSection === "Invite collaborator" ? (
              <section className={styles.panel}>
                <h3>Invite collaborator</h3>
                <label>Role<select value={role} onChange={(event) => setRole(event.target.value as "editor" | "reviewer")}><option value="editor">Editor</option><option value="reviewer">Reviewer</option></select></label>
                <p>This role applies across the collaboration project. Opening an Invitation does not grant access.</p>
                {actionButton("create_invitation", snapshot, busy, invoke)}
                {actionButton("cancel_invitation", snapshot, busy, invoke)}
              </section>
            ) : null}

            {activeSection === "Complete invitation" ? (
              <section className={styles.panel}>
                <h3>Complete invitation</h3>
                <label htmlFor="collaboration-artifact-input">Invitation, Response, or connection item</label>
                <textarea id="collaboration-artifact-input" rows={5} value={artifactInput} onChange={(event) => setArtifactInput(event.target.value)} autoComplete="off" spellCheck={false} />
                <div className={styles.actions}>
                  <button type="button" onClick={() => void scanQr()}>Scan QR</button>
                  <label className={styles.fileButton}>Choose QR image<input type="file" accept="image/*" onChange={(event) => void readQrImage(event)} /></label>
                  {snapshot.available_actions.filter(requiresArtifactText).map((action) => (
                    <button key={action} type="button" disabled={busy || !artifactInput} onClick={() => void invoke(action)}>{actionLabels[action]}</button>
                  ))}
                </div>
                {scanCapability ? <p className={styles.note}>Using: {scanCapability}</p> : null}
              </section>
            ) : null}

            {activeSection === "Collaborators and devices" ? (
              <section className={styles.panel}>
                <h3>Collaborators and devices</h3>
                <p>{snapshot.pending_invitation_count} pending invitation{snapshot.pending_invitation_count === 1 ? "" : "s"}</p>
                {snapshot.collaborators.length ? snapshot.collaborators.map((person) => (
                  <article key={person.person_id} className={styles.person}>
                    <h4>{safeHc3DisplayLabel(person.display_name)}</h4><p>{capitalize(person.role)} · {person.membership_state}</p>
                    <ul>{person.devices.map((device) => <li key={device.device_id}>{safeHc3DisplayLabel(device.display_name)} — {device.state}{device.current ? " · This device" : ""}</li>)}</ul>
                    <div className={styles.actions}>{actionButton("change_role", snapshot, busy, invoke, person.person_id)}{actionButton("revoke_membership", snapshot, busy, invoke, person.person_id)}{person.devices.map((device) => actionButton("revoke_device", snapshot, busy, invoke, device.device_id))}</div>
                  </article>
                )) : <p>No accepted collaborators are visible yet.</p>}
              </section>
            ) : null}

            {activeSection === "Synchronize changes" ? (
              <section className={styles.panel}>
                <h3>Synchronize changes</h3>
                <ol><li><strong>Connect directly</strong> — exchange a request and response manually, then choose Sync.</li><li><strong>Send encrypted update</strong> — save and carry an opaque file.</li></ol>
                <p>Direct connection can reveal network metadata to the intended peer and may not work across the internet without STUN or TURN. Patchmark uses neither; encrypted-file fallback remains available.</p>
                <div className={styles.actions}>
                  {["create_direct_offer", "open_direct_offer", "create_direct_answer", "open_direct_answer", "sync_directly", "use_encrypted_file", "select_encrypted_file", "preview_encrypted_file", "import_encrypted_file", "reopen_and_verify"].map((name) => actionButton(name as Hc3ProductAction, snapshot, busy, invoke))}
                </div>
                <p className={styles.state}>Direct connection: {snapshot.direct_connection_state.replaceAll("_", " ")}</p>
              </section>
            ) : null}

            {activeSection === "Conflicts" ? (
              <section className={styles.panel}>
                <h3>Conflicts</h3>
                {snapshot.conflicts.length ? snapshot.conflicts.map((conflict) => (
                  <article key={conflict.conflict_id} className={styles.conflict}>
                    <h4>{safeHc3DisplayLabel(conflict.subject)}</h4><ul>{conflict.contenders.map((contender) => <li key={contender.contender_id}>{safeHc3DisplayLabel(contender.summary)}</li>)}</ul>
                    <button type="button" disabled={busy || !conflict.can_resolve || !snapshot.available_actions.includes("resolve_conflict")} onClick={() => void invoke("resolve_conflict", conflict.conflict_id)}>Resolve selected outcome</button>
                    {!conflict.can_resolve ? <p>Current role can review but cannot resolve this conflict.</p> : null}
                  </article>
                )) : <p>No unresolved conflicts.</p>}
              </section>
            ) : null}

            {activeSection === "Privacy and safety" ? (
              <section className={styles.panel} aria-labelledby="collaboration-privacy-heading">
                <h3 id="collaboration-privacy-heading">Before you share</h3>
                <ul>
                  <li>Collaboration creates a separate project copy. It never converts the source project in place.</li>
                  <li>Invitations, Responses, connection text, and their QR codes are not confidential. They reveal limited project and device metadata, but opening one does not grant access.</li>
                  <li>Clipboard history, messengers, file providers, and the operating system may retain anything you copy, share, scan, or save.</li>
                  <li>Admission and synchronization files are encrypted in transit, but their approximate size and timing remain visible. This does not encrypt the local project folder.</li>
                  <li>A direct connection can reveal network metadata to the intended peer and may not work across the internet. The encrypted-file fallback remains available.</li>
                  <li>Revocation blocks future accepted work; it cannot erase project data or artifacts already delivered to another person.</li>
                  <li>A newly admitted device verifies current state, not necessarily all earlier history. Keep recovery material separate and safe.</li>
                  <li>If this browser loses its non-extractable device keys, use recovery or re-admission. Patchmark will not silently replace that identity.</li>
                </ul>
                <details>
                  <summary>Technical privacy details</summary>
                  <p>Direct WebRTC uses no public STUN, TURN, rendezvous, or relay service. Intended peers can still learn connection addresses, fingerprints, timing, and transfer sizes. Local project contents can remain plaintext in the selected folder and may be exposed by backups, indexing, malware, shared operating-system accounts, cloud-synced folders, or a lost unlocked device.</p>
                </details>
              </section>
            ) : null}

            {activeSection === "Recovery and blocked states" ? (
              <section className={styles.panel}>
                <h3>Recovery and blocked states</h3>
                <p>Reloading reconstructs this guidance from durable collaboration evidence. Closing this workspace never rolls back accepted changes.</p>
                <p>History on this device: {snapshot.full_history_verified === false ? "Current state verified; earlier collaboration history was not fully traversed at admission." : snapshot.full_history_verified ? "Complete history verified." : "Not established."}</p>
                {actionButton("reopen_and_verify", snapshot, busy, invoke)}
              </section>
            ) : null}

            {artifact ? (
              <section className={styles.artifact} aria-labelledby="prepared-artifact-heading">
                <h3 id="prepared-artifact-heading">Prepared {labelArtifact(artifact.kind)}</h3>
                <p>The item remains available if copy, sharing, or saving is cancelled.</p>
                <div className={styles.actions}>
                  {artifact.text ? <button type="button" onClick={() => void copyArtifact()}>Copy</button> : null}
                  {artifact.text && typeof shareNavigator().share === "function" ? <button type="button" onClick={() => void shareArtifact()}>Share</button> : null}
                  {artifact.text && artifact.eligible_for_qr ? <button type="button" onClick={showQr}>Show QR</button> : null}
                  {artifact.exact_bytes ? <button type="button" onClick={savePreparedFile}>Save encrypted file</button> : null}
                </div>
                {artifact.text ? <details><summary>Manual copy fallback</summary><textarea readOnly value={artifact.text} rows={4} aria-label="Exact prepared artifact text" /></details> : null}
                {qr ? <div className={styles.qr}><canvas ref={canvasRef} role="img" aria-label={`${labelArtifact(artifact.kind)} QR code`} /><p>QR is a visual carrier only. Use Copy if scanning is unavailable.</p></div> : null}
              </section>
            ) : null}

            <details className={styles.technical}>
              <summary>Technical details</summary>
              <dl><div><dt>Project</dt><dd>{snapshot.project_id}</dd></div><div><dt>Evidence revision</dt><dd>{snapshot.revision.toString()}</dd></div><div><dt>Current epoch</dt><dd>{snapshot.current_epoch_id ?? "Not established"}</dd></div><div><dt>Diagnostic</dt><dd>{snapshot.technical_diagnostic_code ?? "None"}</dd></div></dl>
              <h4>Capability fallbacks</h4>
              {capabilities ? <ul>{capabilities.capabilities.map((entry) => <li key={entry.name}><strong>{capabilityLabel(entry.name)}</strong>: {entry.state}{entry.fallback ? ` — ${entry.fallback}` : ""}</li>)}</ul> : <p>Checking capabilities after explicit entry…</p>}
            </details>
          </main>
        </div>
      </section>
    </div>
  );
}

function actionButton(action: Hc3ProductAction, snapshot: Hc3ProductSnapshot, busy: boolean, invoke: (action: Hc3ProductAction, id?: string) => Promise<void>, selectedId?: string) {
  if (!snapshot.available_actions.includes(action)) return null;
  return <button key={`${action}:${selectedId ?? ""}`} type="button" disabled={busy} onClick={() => void invoke(action, selectedId)}>{actionLabels[action]}</button>;
}

function requiresArtifactText(action: Hc3ProductAction): boolean { return ["preview_received_artifact", "open_direct_offer", "open_direct_answer"].includes(action); }
function qrKind(kind: NonNullable<Hc3ProductSnapshot["artifact"]>["kind"]): Hc3QrArtifactKind { return kind === "direct_offer" || kind === "direct_answer" ? "direct" : "handoff"; }
function expectedInputKind(snapshot: Hc3ProductSnapshot): Hc3QrArtifactKind { return snapshot.available_actions.includes("open_direct_offer") || snapshot.available_actions.includes("open_direct_answer") ? "direct" : "handoff"; }
function labelArtifact(kind: NonNullable<Hc3ProductSnapshot["artifact"]>["kind"]): string { return ({ invitation: "Invitation", response: "Response", direct_offer: "connection request", direct_answer: "connection response", encrypted_file: "encrypted update", receipt: "receipt" })[kind]; }
function capitalize(value: string): string { return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`; }
function safeError(value: unknown): string { return safeHc3DiagnosticMessage(value); }
function isAbort(value: unknown): boolean { return value instanceof DOMException && value.name === "AbortError"; }
function focusableWithin(root: HTMLElement | null): HTMLElement[] { return Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? []).filter((node) => node.getClientRects().length > 0); }
function capabilityLabel(name: (typeof hc3ProductCapabilityNames)[number]): string { return name.replaceAll("_", " "); }
function barcodeDetectorConstructor() { return (window as unknown as { BarcodeDetector?: new (input?: { formats?: readonly string[] }) => { detect(source: ImageBitmapSource): Promise<readonly { rawValue?: string }[]> } }).BarcodeDetector; }
function filePickerWindow() { return window as unknown as { showOpenFilePicker?: unknown; showSaveFilePicker?: unknown }; }
function shareNavigator() { return navigator as Navigator & { share?: (data?: ShareData) => Promise<void> }; }
function drawQr(canvas: HTMLCanvasElement, qr: Hc3QrMatrix) { const scale = Math.max(2, Math.floor(320 / qr.module_count)); canvas.width = qr.module_count * scale; canvas.height = qr.module_count * scale; const context = canvas.getContext("2d"); if (!context) throw new Error("QR canvas is unavailable."); context.imageSmoothingEnabled = false; context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "#000"; qr.cells.forEach((row, y) => row.forEach((cell, x) => { if (cell) context.fillRect(x * scale, y * scale, scale, scale); })); }
