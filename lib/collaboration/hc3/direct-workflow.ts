import type { DeviceId, ProjectId } from "../identities.ts";
import type { SyncSessionIdV3 } from "../hc2/sync-v3-identities.ts";
import type { UInt64 } from "../validation.ts";
import { parseHc3DirectAuthText, type Hc3DirectAuthText } from "./direct-auth.ts";
import type {
  Hc3DirectAnswerResult,
  Hc3DirectConnectionHandle,
  Hc3DirectOfferResult,
  Hc3ManualDirectConnectionAdapter
} from "./direct-webrtc-adapter.ts";
import { assessHc3DirectPresentation } from "./direct-presentation.ts";

export const hc3DirectWorkflowCommands = Object.freeze([
  "create_connection_link",
  "copy_connection_request",
  "present_connection_request_as_qr",
  "open_connection_request",
  "create_connection_response",
  "copy_connection_response",
  "present_connection_response_as_qr",
  "open_connection_response",
  "connect_directly",
  "synchronize_directly",
  "cancel_direct_connection",
  "restart_direct_connection",
  "use_encrypted_file"
] as const);

export type Hc3DirectWorkflowCommand = (typeof hc3DirectWorkflowCommands)[number];

export const hc3DirectWorkflowStateKinds = Object.freeze([
  "ready",
  "connection_link_ready",
  "waiting_for_response",
  "request_opened",
  "response_ready",
  "response_opened",
  "connecting",
  "connected",
  "synchronizing",
  "sync_complete",
  "direct_unavailable",
  "direct_interrupted",
  "simultaneous_offer_conflict",
  "blocked",
  "cancelled"
] as const);

export type Hc3DirectWorkflowStateKind = (typeof hc3DirectWorkflowStateKinds)[number];

export type Hc3DirectWorkflowStatus = Readonly<{
  authority: "none";
  state: Hc3DirectWorkflowStateKind;
  title: string;
  explanation: string;
  available_actions: readonly Hc3DirectWorkflowCommand[];
  direct_artifact: Hc3DirectAuthText | null;
  encrypted_file_fallback_available: true;
  technical_diagnostic_code: string | null;
}>;

export type Hc3DirectWorkflowPorts = Readonly<{
  copyText(input: Readonly<{ exact_text: string }>): Promise<Readonly<{ status: "success" | "cancelled" | "unavailable" | "failed" }>>;
  presentQr(input: Readonly<{ exact_text: string }>): Promise<Readonly<{ status: "success" | "cancelled" | "unavailable" | "failed"; presented_text?: string }>>;
}>;

export class Hc3DisabledDirectWorkflow {
  readonly #adapter: Hc3ManualDirectConnectionAdapter;
  readonly #ports: Hc3DirectWorkflowPorts;
  #offer: Hc3DirectOfferResult | null = null;
  #receivedOfferText: Hc3DirectAuthText | null = null;
  #answer: Hc3DirectAnswerResult | null = null;
  #receivedAnswerText: Hc3DirectAuthText | null = null;
  #connection: Hc3DirectConnectionHandle | null = null;
  #status: Hc3DirectWorkflowStatus = status("ready");

  constructor(input: Readonly<{ adapter: Hc3ManualDirectConnectionAdapter; ports: Hc3DirectWorkflowPorts }>) {
    if (!input?.adapter || !input.ports) throw new Error("HC-3 direct workflow requires injected connection and presentation ports.");
    this.#adapter = input.adapter;
    this.#ports = input.ports;
  }

  get currentStatus(): Hc3DirectWorkflowStatus { return this.#status; }
  get connection(): Hc3DirectConnectionHandle | null { return this.#connection; }

  async createConnectionLink(input: Readonly<{
    project_id: ProjectId;
    local_device_id: DeviceId;
    peer_device_id: DeviceId;
    session_id: SyncSessionIdV3;
    session_generation: UInt64;
    connection_attempt_id: Uint8Array;
  }>): Promise<Hc3DirectWorkflowStatus> {
    this.#disposeAttempt();
    this.#offer = await this.#adapter.createOffer(input);
    const presentation = assessHc3DirectPresentation(this.#offer.offer_text);
    this.#status = status("connection_link_ready", {
      explanation: presentation.single_qr_available
        ? "Connection link ready. Copy or show it, then wait for the other person’s response."
        : "Connection text ready. It exceeds the one-code limit, so copy the exact text.",
      actions: presentation.single_qr_available
        ? ["copy_connection_request", "present_connection_request_as_qr", "cancel_direct_connection", "use_encrypted_file"]
        : ["copy_connection_request", "cancel_direct_connection", "use_encrypted_file"],
      artifact: this.#offer.offer_text
    });
    return this.#status;
  }

  async copyConnectionRequest(): Promise<Hc3DirectWorkflowStatus> {
    const text = required(this.#offer?.offer_text, "connection_request_not_ready");
    return this.#present("copy_connection_request", text, false);
  }

  async presentConnectionRequestAsQr(): Promise<Hc3DirectWorkflowStatus> {
    const text = required(this.#offer?.offer_text, "connection_request_not_ready");
    return this.#present("present_connection_request_as_qr", text, true);
  }

  openConnectionRequest(text: string): Hc3DirectWorkflowStatus {
    const parsed = parseHc3DirectAuthText(text);
    if (parsed.record.artifact_kind !== "connection_offer") throw new Error("Open request requires an authenticated connection offer.");
    this.#receivedOfferText = parsed.text;
    this.#status = status("request_opened", {
      explanation: "Connection request opened. Create a response explicitly; no connection has started.",
      actions: ["create_connection_response", "cancel_direct_connection", "use_encrypted_file"], artifact: parsed.text
    });
    return this.#status;
  }

  async createConnectionResponse(localDeviceId: DeviceId): Promise<Hc3DirectWorkflowStatus> {
    const text = required(this.#receivedOfferText, "connection_request_not_opened");
    this.#answer = await this.#adapter.acceptOffer({ offer_text: text, local_device_id: localDeviceId });
    const presentation = assessHc3DirectPresentation(this.#answer.answer_text);
    this.#status = status("response_ready", {
      explanation: "Connection response ready. Return it manually, then keep this window open while connecting.",
      actions: presentation.single_qr_available
        ? ["copy_connection_response", "present_connection_response_as_qr", "cancel_direct_connection", "use_encrypted_file"]
        : ["copy_connection_response", "cancel_direct_connection", "use_encrypted_file"],
      artifact: this.#answer.answer_text
    });
    return this.#status;
  }

  async copyConnectionResponse(): Promise<Hc3DirectWorkflowStatus> {
    const text = required(this.#answer?.answer_text, "connection_response_not_ready");
    return this.#present("copy_connection_response", text, false);
  }

  async presentConnectionResponseAsQr(): Promise<Hc3DirectWorkflowStatus> {
    const text = required(this.#answer?.answer_text, "connection_response_not_ready");
    return this.#present("present_connection_response_as_qr", text, true);
  }

  openConnectionResponse(text: string): Hc3DirectWorkflowStatus {
    const parsed = parseHc3DirectAuthText(text);
    if (parsed.record.artifact_kind !== "connection_answer") throw new Error("Open response requires an authenticated connection answer.");
    this.#receivedAnswerText = parsed.text;
    this.#status = status("response_opened", {
      explanation: "Connection response opened. Connect explicitly after current authority is revalidated.",
      actions: ["connect_directly", "cancel_direct_connection", "use_encrypted_file"], artifact: parsed.text
    });
    return this.#status;
  }

  async connectDirectly(localDeviceId: DeviceId): Promise<Hc3DirectWorkflowStatus> {
    const offer = required(this.#offer, "local_connection_request_missing");
    const answer = required(this.#receivedAnswerText, "connection_response_not_opened");
    this.#status = status("connecting", { actions: ["cancel_direct_connection", "use_encrypted_file"] });
    try {
      this.#connection = await this.#adapter.acceptAnswer({ offer, answer_text: answer, local_device_id: localDeviceId });
      this.#status = status("connected", { actions: ["synchronize_directly", "cancel_direct_connection", "use_encrypted_file"] });
    } catch (error) {
      this.#status = status("direct_interrupted", {
        explanation: "Direct connection was interrupted. Start a fresh connection attempt or use an encrypted file.",
        actions: ["restart_direct_connection", "use_encrypted_file"], diagnostic: errorCode(error)
      });
    }
    return this.#status;
  }

  async connectAsResponder(): Promise<Hc3DirectWorkflowStatus> {
    const answer = required(this.#answer, "connection_response_not_ready");
    this.#status = status("connecting", { actions: ["cancel_direct_connection", "use_encrypted_file"] });
    try {
      this.#connection = await this.#adapter.completeAcceptedOffer({ answer });
      this.#status = status("connected", { actions: ["synchronize_directly", "cancel_direct_connection", "use_encrypted_file"] });
    } catch (error) {
      this.#status = status("direct_interrupted", { actions: ["restart_direct_connection", "use_encrypted_file"], diagnostic: errorCode(error) });
    }
    return this.#status;
  }

  markSynchronizing(): Hc3DirectWorkflowStatus {
    if (!this.#connection) throw new Error("HC-3 direct synchronization requires a connected channel.");
    this.#status = status("synchronizing", { actions: ["cancel_direct_connection", "use_encrypted_file"] });
    return this.#status;
  }

  markSyncComplete(): Hc3DirectWorkflowStatus {
    this.#status = status("sync_complete", { actions: ["use_encrypted_file"] });
    return this.#status;
  }

  directUnavailable(): Hc3DirectWorkflowStatus {
    this.#disposeAttempt();
    this.#status = status("direct_unavailable", { actions: ["use_encrypted_file"] });
    return this.#status;
  }

  simultaneousOfferConflict(): Hc3DirectWorkflowStatus {
    this.#disposeAttempt();
    this.#status = status("simultaneous_offer_conflict", {
      actions: ["restart_direct_connection", "use_encrypted_file"], diagnostic: "simultaneous_offer"
    });
    return this.#status;
  }

  cancel(): Hc3DirectWorkflowStatus {
    this.#disposeAttempt();
    this.#status = status("cancelled", { actions: ["restart_direct_connection", "use_encrypted_file"] });
    return this.#status;
  }

  #disposeAttempt(): void {
    try { this.#connection?.peer.close(); } catch { /* best-effort explicit cleanup */ }
    try { this.#offer?.peer.close(); } catch { /* best-effort explicit cleanup */ }
    try { this.#answer?.peer.close(); } catch { /* best-effort explicit cleanup */ }
    this.#offer = null; this.#answer = null; this.#connection = null;
    this.#receivedOfferText = null; this.#receivedAnswerText = null;
  }

  async #present(command: Hc3DirectWorkflowCommand, text: Hc3DirectAuthText, qr: boolean): Promise<Hc3DirectWorkflowStatus> {
    const result: Readonly<{ status: "success" | "cancelled" | "unavailable" | "failed"; presented_text?: string }> = qr
      ? await this.#ports.presentQr({ exact_text: text })
      : await this.#ports.copyText({ exact_text: text });
    if (result.status === "success" && (!qr || result.presented_text === text)) {
      this.#status = status("waiting_for_response", {
        explanation: "Waiting for response. No background signaling or synchronization is running.",
        actions: ["open_connection_response", "cancel_direct_connection", "use_encrypted_file"], artifact: text
      });
    } else {
      this.#status = status(result.status === "unavailable" ? "direct_unavailable" : result.status === "cancelled" ? "cancelled" : "blocked", {
        explanation: "The connection artifact was not handed off. Copy the exact text or use an encrypted file.",
        actions: [command.includes("request") ? "copy_connection_request" : "copy_connection_response", "use_encrypted_file"],
        artifact: text,
        diagnostic: qr && result.status === "success" ? "qr_payload_mutated" : `presentation_${result.status}`
      });
    }
    return this.#status;
  }
}

function status(state: Hc3DirectWorkflowStateKind, input: Readonly<{
  explanation?: string;
  actions?: readonly Hc3DirectWorkflowCommand[];
  artifact?: Hc3DirectAuthText;
  diagnostic?: string;
}> = {}): Hc3DirectWorkflowStatus {
  const defaults: Record<Hc3DirectWorkflowStateKind, readonly [string, string]> = {
    ready: ["Direct connection ready", "Create a connection link or use an encrypted file."],
    connection_link_ready: ["Connection link ready", "Share the exact connection artifact manually."],
    waiting_for_response: ["Waiting for response", "No background activity is running."],
    request_opened: ["Open request", "Review the connection request and create a response explicitly."],
    response_ready: ["Create response", "Return the exact response manually."],
    response_opened: ["Open response", "Connect explicitly when ready."],
    connecting: ["Connecting", "Patchmark is establishing the manually signaled local peer channel."],
    connected: ["Connected", "Start one explicit synchronization action."],
    synchronizing: ["Synchronizing", "Exact encrypted V3 bundles are moving over the direct channel."],
    sync_complete: ["Sync complete", "Both replicas report converged authoritative state."],
    direct_unavailable: ["Direct unavailable", "Use the encrypted-file workflow without regenerating committed V3 bytes."],
    direct_interrupted: ["Direct interrupted", "Start a fresh connection attempt; durable V3 journals remain reusable."],
    simultaneous_offer_conflict: ["Both people created requests", "Cancel one attempt explicitly; arrival order does not choose a winner."],
    blocked: ["Cannot continue safely", "Validation failed closed. Use an encrypted file or start a fresh attempt."],
    cancelled: ["Cancelled", "No background connection or retry remains active."]
  };
  return Object.freeze({
    authority: "none", state, title: defaults[state][0], explanation: input.explanation ?? defaults[state][1],
    available_actions: Object.freeze([...(input.actions ?? [])]), direct_artifact: input.artifact ?? null,
    encrypted_file_fallback_available: true, technical_diagnostic_code: input.diagnostic ?? null
  });
}

function required<T>(value: T | null | undefined, code: string): T {
  if (value === null || value === undefined) throw Object.assign(new Error(code), { code });
  return value;
}

function errorCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : "direct_connection_failed";
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "direct_connection_failed";
}
