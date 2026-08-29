import type {
  AgentExchangeAvailability,
  AgentExchangeConnector,
  AgentExchangeConnectorResponse,
  AgentExchangeConnectorSubmission,
  AgentExchangeOperationBinding,
  AgentExchangeResponseBinding
} from "../../lib/agent-exchange/contracts.ts";

type QualificationMode = "delayed" | "immediate" | "throw";

export class QualificationAgentExchangeConnector
  implements AgentExchangeConnector
{
  readonly descriptor: Readonly<{ id: string; version: string }>;
  #availability: AgentExchangeAvailability = Object.freeze({
    status: "available"
  });
  #closed = 0;
  #delayed: Deferred<AgentExchangeConnectorResponse> | null = null;
  #mode: QualificationMode = "immediate";
  #respectCancellation = true;
  #responseBytes = new Uint8Array();
  #responseBindingTransform: (
    binding: AgentExchangeResponseBinding
  ) => AgentExchangeResponseBinding = (binding) => binding;
  #submissions: Array<{
    binding: AgentExchangeOperationBinding;
    request_bytes: Uint8Array;
    signal: AbortSignal;
  }> = [];
  #submissionObserved = createDeferred<void>();

  constructor(
    descriptor: Readonly<{ id?: string; version?: string }> = {}
  ) {
    this.descriptor = Object.freeze({
      id: descriptor.id ?? "qualification.deterministic",
      version: descriptor.version ?? "1"
    });
  }

  checkAvailability(): Promise<AgentExchangeAvailability> {
    return Promise.resolve(this.#availability);
  }

  close(): void {
    this.#closed += 1;
  }

  closedCount(): number {
    return this.#closed;
  }

  configure(input: Readonly<{
    availability?: AgentExchangeAvailability;
    mode?: QualificationMode;
    respectCancellation?: boolean;
    responseBindingTransform?: (
      binding: AgentExchangeResponseBinding
    ) => AgentExchangeResponseBinding;
    responseBytes?: Uint8Array;
  }>): void {
    if (input.availability) this.#availability = input.availability;
    if (input.mode) this.#mode = input.mode;
    if (input.respectCancellation !== undefined) {
      this.#respectCancellation = input.respectCancellation;
    }
    if (input.responseBindingTransform) {
      this.#responseBindingTransform = input.responseBindingTransform;
    }
    if (input.responseBytes) {
      this.#responseBytes = Uint8Array.from(input.responseBytes);
    }
  }

  copySubmittedRequest(index = this.#submissions.length - 1): Uint8Array {
    const submission = this.#submissions[index];
    if (!submission) throw new Error("No qualification request was submitted.");
    return Uint8Array.from(submission.request_bytes);
  }

  mutateOwnedSubmittedRequest(
    mutate: (requestBytes: Uint8Array) => void,
    index = this.#submissions.length - 1
  ): void {
    const submission = this.#submissions[index];
    if (!submission) throw new Error("No qualification request was submitted.");
    mutate(submission.request_bytes);
  }

  submissionCount(): number {
    return this.#submissions.length;
  }

  waitForSubmission(): Promise<void> {
    return this.#submissions.length > 0
      ? Promise.resolve()
      : this.#submissionObserved.promise;
  }

  submit(
    input: AgentExchangeConnectorSubmission
  ): Promise<AgentExchangeConnectorResponse> {
    const submission = {
      binding: input.binding,
      request_bytes: Uint8Array.from(input.request_bytes),
      signal: input.signal
    };
    this.#submissions.push(submission);
    this.#submissionObserved.resolve(undefined);
    if (this.#mode === "throw") {
      throw new Error("Injected qualification interruption.");
    }

    const response = () =>
      copyResponse(
        createBoundResponse(
          submission.binding,
          this.#responseBytes,
          this.#responseBindingTransform
        )
      );
    if (this.#mode === "immediate") {
      return Promise.resolve(response());
    }

    const delayed = createDeferred<AgentExchangeConnectorResponse>();
    this.#delayed = delayed;
    if (this.#respectCancellation) {
      if (input.signal.aborted) {
        delayed.reject(createAbortError());
      } else {
        input.signal.addEventListener(
          "abort",
          () => delayed.reject(createAbortError()),
          { once: true }
        );
      }
    }
    delayed.defaultResponse = response;
    return delayed.promise.then(copyResponse);
  }

  resolveDelayed(
    response?: AgentExchangeConnectorResponse
  ): void {
    const delayed = this.#takeDelayed();
    delayed.resolve(
      copyResponse(response ?? delayed.defaultResponse?.() ?? missingResponse())
    );
  }

  rejectDelayed(): void {
    this.#takeDelayed().reject(
      new Error("Injected qualification interruption.")
    );
  }

  #takeDelayed(): Deferred<AgentExchangeConnectorResponse> {
    const delayed = this.#delayed;
    if (!delayed) throw new Error("No delayed qualification response is pending.");
    this.#delayed = null;
    return delayed;
  }
}

type Deferred<T> = {
  defaultResponse?: () => T;
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createBoundResponse(
  binding: AgentExchangeOperationBinding,
  bytes: Uint8Array,
  transform: (
    binding: AgentExchangeResponseBinding
  ) => AgentExchangeResponseBinding
): AgentExchangeConnectorResponse {
  const responseBytes = Uint8Array.from(bytes);
  return {
    binding: transform({
      ...binding,
      response_byte_length: responseBytes.byteLength,
      response_protocol: binding.expected_response_protocol,
      response_protocol_version: binding.expected_response_protocol_version
    }),
    response_bytes: responseBytes
  };
}

function copyResponse(
  response: AgentExchangeConnectorResponse
): AgentExchangeConnectorResponse {
  return {
    binding: Object.freeze({ ...response.binding }),
    response_bytes: Uint8Array.from(response.response_bytes)
  };
}

function missingResponse(): never {
  throw new Error("The delayed qualification response is missing.");
}

function createAbortError(): DOMException {
  return new DOMException("The qualification exchange was aborted.", "AbortError");
}
