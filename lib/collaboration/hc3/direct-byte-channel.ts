import type { Sha256Provider } from "../sha256.ts";
import { Hc3DirectTransferAssembler, type Hc3DirectPreparedTransfer } from "./direct-framing.ts";
import {
  HC3_DIRECT_CHANNEL_LABEL,
  HC3_DIRECT_CHANNEL_PROTOCOL,
  hc3DirectLimits
} from "./direct-versions.ts";

export type Hc3DirectEvent = Readonly<{ type: string }>;
export type Hc3DirectMessageEvent = Hc3DirectEvent & Readonly<{ data: unknown }>;

export interface Hc3DirectDataChannelPort {
  readonly label: string;
  readonly protocol: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer): void;
  close(): void;
  addEventListener(type: string, listener: (event: Hc3DirectEvent | Hc3DirectMessageEvent) => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: string, listener: (event: Hc3DirectEvent | Hc3DirectMessageEvent) => void): void;
}

export type Hc3DirectCancellation = Readonly<{
  readonly cancelled: boolean;
  readonly reason: string | null;
  addCancellationListener(listener: () => void): void;
  removeCancellationListener(listener: () => void): void;
}>;

export type Hc3ReceivedDirectTransfer = Readonly<{
  transfer_id: Uint8Array;
  exact_bytes: Uint8Array;
  sha256: Uint8Array;
}>;

export class Hc3ReliableDirectByteChannel {
  readonly #channel: Hc3DirectDataChannelPort;
  readonly #attemptId: Uint8Array;
  readonly #sha256Provider: Sha256Provider;
  readonly #messageListener: (event: Hc3DirectEvent | Hc3DirectMessageEvent) => void;
  readonly #closeListener: (event: Hc3DirectEvent | Hc3DirectMessageEvent) => void;
  #assembler: Hc3DirectTransferAssembler | null = null;
  #incomingChain: Promise<void> = Promise.resolve();
  #received: Hc3ReceivedDirectTransfer[] = [];
  #waiters: Array<Readonly<{ resolve(value: Hc3ReceivedDirectTransfer): void; reject(reason: Error): void }>> = [];
  #closed = false;
  #backpressureWaits = 0;

  constructor(input: Readonly<{
    channel: Hc3DirectDataChannelPort;
    connection_attempt_id: Uint8Array;
    sha256_provider: Sha256Provider;
  }>) {
    if (input.channel.label !== HC3_DIRECT_CHANNEL_LABEL || input.channel.protocol !== HC3_DIRECT_CHANNEL_PROTOCOL ||
        input.channel.ordered !== true || input.channel.maxRetransmits !== null || input.channel.maxPacketLifeTime !== null) {
      throw new Error("HC-3 direct channel must use the fixed ordered reliable binary profile.");
    }
    if (!(input.connection_attempt_id instanceof Uint8Array) || input.connection_attempt_id.length !== hc3DirectLimits.connection_attempt_id_bytes) {
      throw new Error("HC-3 direct channel requires an exact connection-attempt identity.");
    }
    this.#channel = input.channel;
    this.#attemptId = Uint8Array.from(input.connection_attempt_id);
    this.#sha256Provider = input.sha256_provider;
    this.#channel.binaryType = "arraybuffer";
    this.#channel.bufferedAmountLowThreshold = hc3DirectLimits.buffered_amount_low_water;
    this.#messageListener = (event) => this.#enqueueMessage(event);
    this.#closeListener = () => this.#terminate(new Error("HC-3 direct channel closed."), false);
    this.#channel.addEventListener("message", this.#messageListener);
    this.#channel.addEventListener("close", this.#closeListener);
  }

  get backpressureWaitCount(): number { return this.#backpressureWaits; }
  get bufferedAmount(): number { return this.#channel.bufferedAmount; }

  async sendPreparedTransfer(transfer: Hc3DirectPreparedTransfer, cancellation?: Hc3DirectCancellation): Promise<Readonly<{
    status: "sent";
    exact_byte_length: number;
    frame_count: number;
    backpressure_wait_count: number;
  }>> {
    this.#assertOpen();
    for (const encoded of transfer.frames) {
      this.#throwIfCancelled(cancellation);
      await this.#waitForWritable(cancellation);
      this.#throwIfCancelled(cancellation);
      this.#assertOpen();
      const exact = Uint8Array.from(encoded);
      this.#channel.send(exact.buffer as ArrayBuffer);
    }
    return Object.freeze({
      status: "sent",
      exact_byte_length: transfer.transfer_length,
      frame_count: transfer.frame_count,
      backpressure_wait_count: this.#backpressureWaits
    });
  }

  receiveTransfer(): Promise<Hc3ReceivedDirectTransfer> {
    this.#assertOpen();
    const available = this.#received.shift();
    if (available) return Promise.resolve(copyTransfer(available));
    return new Promise((resolve, reject) => this.#waiters.push(Object.freeze({ resolve, reject })));
  }

  cancel(reason = "cancelled"): void {
    this.#terminate(new Error(`HC-3 direct transfer ${reason}.`), true);
  }

  close(): void {
    this.#terminate(new Error("HC-3 direct channel closed explicitly."), true);
  }

  #enqueueMessage(event: Hc3DirectEvent | Hc3DirectMessageEvent): void {
    this.#incomingChain = this.#incomingChain.then(async () => {
      if (this.#closed) return;
      if (!("data" in event) || !(event.data instanceof ArrayBuffer)) {
        throw new Error("HC-3 direct channel rejected a non-binary message.");
      }
      if (!this.#assembler) this.#assembler = new Hc3DirectTransferAssembler({ connection_attempt_id: this.#attemptId, sha256_provider: this.#sha256Provider });
      const accepted = this.#assembler.accept(new Uint8Array(event.data.slice(0)));
      if (!accepted.complete) return;
      const complete = await this.#assembler.finish();
      this.#assembler = null;
      this.#deliver(Object.freeze({ transfer_id: complete.transfer_id, exact_bytes: complete.exact_bytes, sha256: complete.sha256 }));
    }).catch((error) => this.#terminate(error instanceof Error ? error : new Error("HC-3 direct receive failed."), true));
  }

  #deliver(value: Hc3ReceivedDirectTransfer): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(copyTransfer(value));
    else this.#received.push(copyTransfer(value));
  }

  async #waitForWritable(cancellation?: Hc3DirectCancellation): Promise<void> {
    if (this.#channel.bufferedAmount <= hc3DirectLimits.buffered_amount_high_water) return;
    this.#backpressureWaits += 1;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.#channel.removeEventListener("bufferedamountlow", onLow);
        cancellation?.removeCancellationListener(onCancelled);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const onLow = () => {
        if (this.#channel.bufferedAmount <= hc3DirectLimits.buffered_amount_low_water) finish();
      };
      const onCancelled = () => finish(new Error(`HC-3 direct transfer ${cancellation?.reason ?? "cancelled"}.`));
      this.#channel.addEventListener("bufferedamountlow", onLow);
      cancellation?.addCancellationListener(onCancelled);
      if (cancellation?.cancelled) onCancelled();
      else if (this.#channel.readyState !== "open") finish(new Error("HC-3 direct channel closed while applying backpressure."));
      else onLow();
    });
  }

  #throwIfCancelled(cancellation?: Hc3DirectCancellation): void {
    if (cancellation?.cancelled) throw new Error(`HC-3 direct transfer ${cancellation.reason ?? "cancelled"}.`);
  }

  #assertOpen(): void {
    if (this.#closed || this.#channel.readyState !== "open") throw new Error("HC-3 direct channel is not open.");
  }

  #terminate(error: Error, closePort: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#assembler?.cancel();
    this.#assembler = null;
    this.#channel.removeEventListener("message", this.#messageListener);
    this.#channel.removeEventListener("close", this.#closeListener);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    this.#received = [];
    if (closePort && this.#channel.readyState !== "closed") this.#channel.close();
  }
}

function copyTransfer(value: Hc3ReceivedDirectTransfer): Hc3ReceivedDirectTransfer {
  return Object.freeze({ transfer_id: Uint8Array.from(value.transfer_id), exact_bytes: Uint8Array.from(value.exact_bytes), sha256: Uint8Array.from(value.sha256) });
}
