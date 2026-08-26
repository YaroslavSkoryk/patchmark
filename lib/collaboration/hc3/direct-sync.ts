import type { DeviceId, ProjectId } from "../identities.ts";
import type { Sha256Provider } from "../sha256.ts";
import type { Hc3AuthenticatedConnectionRecord, Hc3DirectAuthorityPort } from "./direct-auth.ts";
import { Hc3ReliableDirectByteChannel, type Hc3DirectCancellation, type Hc3DirectDataChannelPort } from "./direct-byte-channel.ts";
import { prepareHc3DirectTransfer, type Hc3DirectPreparedTransfer } from "./direct-framing.ts";
import { hc3DirectLimits } from "./direct-versions.ts";

export type Hc3V3PreparedDirectBundle = Readonly<{
  status: "prepared";
  exact_v3_bundle_bytes: Uint8Array;
  transfer_id: Uint8Array;
  journal_commitment: string;
}>;

export interface Hc3DirectV3SynchronizationPort {
  prepareNextBundle(input: Readonly<{ round_number: number }>): Promise<
    Hc3V3PreparedDirectBundle |
    Readonly<{ status: "nothing_missing"; journal_commitment: string }>
  >;
  importExactBundle(input: Readonly<{
    exact_v3_bundle_bytes: Uint8Array;
    transfer_id: Uint8Array;
    round_number: number;
  }>): Promise<Readonly<{
    status: "imported" | "duplicate" | "retryable_gap" | "stream_fork" | "rejected";
    journal_commitment: string;
  }>>;
  inspectConvergence(): Promise<Readonly<{
    status: "converged" | "more_required" | "stream_fork" | "rejected";
    local_inventory_root: string;
    peer_inventory_root: string | null;
  }>>;
}

export type Hc3DirectRoundPreparation = Readonly<{
  status: "prepared";
  round_number: number;
  v3_journal_commitment: string;
  transfer: Hc3DirectPreparedTransfer;
  exact_v3_bundle_bytes: Uint8Array;
}> | Readonly<{
  status: "nothing_missing";
  round_number: number;
  v3_journal_commitment: string;
}>;

export class Hc3DirectSyncCoordinator {
  readonly #projectId: ProjectId;
  readonly #localDeviceId: DeviceId;
  readonly #peerDeviceId: DeviceId;
  readonly #attemptId: Uint8Array;
  readonly #acceptedControlHeadId: string;
  readonly #currentEpochId: string;
  readonly #currentEpochCommitmentId: string;
  readonly #authority: Hc3DirectAuthorityPort;
  readonly #operations: Hc3DirectV3SynchronizationPort;
  readonly #byteChannel: Hc3ReliableDirectByteChannel;
  #closed = false;

  constructor(input: Readonly<{
    authenticated_connection: Hc3AuthenticatedConnectionRecord;
    local_device_id: DeviceId;
    channel: Hc3DirectDataChannelPort;
    authority: Hc3DirectAuthorityPort;
    v3: Hc3DirectV3SynchronizationPort;
    sha256_provider: Sha256Provider;
  }>) {
    const connection = input.authenticated_connection;
    const localIsInitiator = input.local_device_id === connection.initiating_device_id;
    const localIsResponder = input.local_device_id === connection.responding_device_id;
    if (!localIsInitiator && !localIsResponder) throw new Error("HC-3 direct coordinator local device is outside the authenticated connection.");
    this.#projectId = connection.project_id;
    this.#localDeviceId = input.local_device_id;
    this.#peerDeviceId = localIsInitiator ? connection.responding_device_id : connection.initiating_device_id;
    this.#attemptId = Uint8Array.from(connection.connection_attempt_id);
    this.#acceptedControlHeadId = connection.accepted_control_head_id;
    this.#currentEpochId = connection.current_epoch_id;
    this.#currentEpochCommitmentId = connection.current_epoch_commitment_id;
    this.#authority = input.authority;
    this.#operations = input.v3;
    this.#byteChannel = new Hc3ReliableDirectByteChannel({ channel: input.channel, connection_attempt_id: this.#attemptId, sha256_provider: input.sha256_provider });
  }

  get backpressureWaitCount(): number { return this.#byteChannel.backpressureWaitCount; }

  async prepareRound(roundNumber: number, sha256Provider: Sha256Provider): Promise<Hc3DirectRoundPreparation> {
    this.#assertRound(roundNumber);
    await this.#revalidate("before_v3_prepare");
    const prepared = await this.#operations.prepareNextBundle({ round_number: roundNumber });
    if (prepared.status === "nothing_missing") return Object.freeze({ status: "nothing_missing", round_number: roundNumber, v3_journal_commitment: prepared.journal_commitment });
    const exact = exactV3Bytes(prepared.exact_v3_bundle_bytes);
    const transfer = await prepareHc3DirectTransfer({
      connection_attempt_id: this.#attemptId,
      transfer_id: prepared.transfer_id,
      exact_bytes: exact,
      sha256_provider: sha256Provider
    });
    return Object.freeze({
      status: "prepared", round_number: roundNumber, v3_journal_commitment: prepared.journal_commitment,
      transfer, exact_v3_bundle_bytes: Uint8Array.from(exact)
    });
  }

  async sendPreparedRound(prepared: Hc3DirectRoundPreparation, cancellation?: Hc3DirectCancellation): Promise<Readonly<{
    status: "sent" | "nothing_missing";
    round_number: number;
    exact_byte_length: number;
    frame_count: number;
  }>> {
    this.#assertRound(prepared.round_number);
    if (prepared.status === "nothing_missing") return Object.freeze({ status: "nothing_missing", round_number: prepared.round_number, exact_byte_length: 0, frame_count: 0 });
    await this.#revalidate("before_v3_send");
    const sent = await this.#byteChannel.sendPreparedTransfer(prepared.transfer, cancellation);
    return Object.freeze({ status: "sent", round_number: prepared.round_number, exact_byte_length: sent.exact_byte_length, frame_count: sent.frame_count });
  }

  async receiveAndImportRound(roundNumber: number): Promise<Readonly<{
    status: "imported" | "duplicate" | "retryable_gap" | "stream_fork" | "rejected";
    round_number: number;
    exact_byte_length: number;
    journal_commitment: string;
  }>> {
    this.#assertRound(roundNumber);
    const received = await this.#byteChannel.receiveTransfer();
    await this.#revalidate("before_v3_import");
    const result = await this.#operations.importExactBundle({
      exact_v3_bundle_bytes: Uint8Array.from(received.exact_bytes),
      transfer_id: Uint8Array.from(received.transfer_id),
      round_number: roundNumber
    });
    return Object.freeze({ ...result, round_number: roundNumber, exact_byte_length: received.exact_bytes.length });
  }

  async inspectConvergence(): ReturnType<Hc3DirectV3SynchronizationPort["inspectConvergence"]> {
    if (this.#closed) throw new Error("HC-3 direct coordinator is closed.");
    return this.#operations.inspectConvergence();
  }

  cancel(reason = "cancelled"): void {
    this.#closed = true;
    this.#byteChannel.cancel(reason);
  }

  close(): void {
    this.#closed = true;
    this.#byteChannel.close();
  }

  async #revalidate(boundary: Parameters<Hc3DirectAuthorityPort["revalidate"]>[0]["boundary"]): Promise<void> {
    if (this.#closed) throw new Error("HC-3 direct coordinator is closed.");
    const result = await this.#authority.revalidate({
      project_id: this.#projectId, local_device_id: this.#localDeviceId, peer_device_id: this.#peerDeviceId, boundary
    });
    if (result.status !== "current") throw new Error(`HC-3 direct synchronization stopped at ${boundary}: ${result.reason}.`);
    if (result.accepted_control_head_id !== this.#acceptedControlHeadId || result.current_epoch_id !== this.#currentEpochId ||
        result.current_epoch_commitment_id !== this.#currentEpochCommitmentId) {
      throw new Error(`HC-3 direct synchronization stopped at ${boundary}: authenticated authority changed.`);
    }
  }

  #assertRound(value: number): void {
    if (this.#closed) throw new Error("HC-3 direct coordinator is closed.");
    if (!Number.isSafeInteger(value) || value < 1 || value > hc3DirectLimits.maximum_sync_rounds) throw new Error("HC-3 direct synchronization round exceeds its explicit bound.");
  }
}

export async function exchangeHc3DirectRound(input: Readonly<{
  round_number: number;
  left: Hc3DirectSyncCoordinator;
  right: Hc3DirectSyncCoordinator;
  sha256_provider: Sha256Provider;
}>): Promise<Readonly<{
  round_number: number;
  left_sent: number;
  right_sent: number;
  left_import: string | null;
  right_import: string | null;
}>> {
  const [leftPrepared, rightPrepared] = await Promise.all([
    input.left.prepareRound(input.round_number, input.sha256_provider),
    input.right.prepareRound(input.round_number, input.sha256_provider)
  ]);
  const receiveLeft = rightPrepared.status === "prepared" ? input.left.receiveAndImportRound(input.round_number) : Promise.resolve(null);
  const receiveRight = leftPrepared.status === "prepared" ? input.right.receiveAndImportRound(input.round_number) : Promise.resolve(null);
  const [leftSent, rightSent, leftImported, rightImported] = await Promise.all([
    input.left.sendPreparedRound(leftPrepared), input.right.sendPreparedRound(rightPrepared), receiveLeft, receiveRight
  ]);
  return Object.freeze({
    round_number: input.round_number,
    left_sent: leftSent.exact_byte_length,
    right_sent: rightSent.exact_byte_length,
    left_import: leftImported?.status ?? null,
    right_import: rightImported?.status ?? null
  });
}

function exactV3Bytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > hc3DirectLimits.maximum_transfer_bytes) throw new Error("HC-3 direct V3 bundle bytes are empty or oversized.");
  return Uint8Array.from(value);
}
