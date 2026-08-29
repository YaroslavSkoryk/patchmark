import {
  AGENT_EXCHANGE_RESPONSE_PROTOCOL,
  AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION,
  type AgentExchangeConnector,
  type AgentExchangeConnectorResponse,
  type AgentExchangeOperationBinding,
  type AgentExchangeOperationPhase,
  type AgentExchangeResponseImporter,
  type PreparedAgentExchange
} from "./contracts.ts";

export type AgentExchangeOperationErrorCode =
  | "connector_unavailable"
  | "connector_failed"
  | "connector_instance_reused"
  | "duplicate_operation_id"
  | "invalid_connector_identity"
  | "invalid_operation_id"
  | "operation_cancelled"
  | "operation_invalidated"
  | "response_binding_mismatch"
  | "response_length_mismatch"
  | "response_oversized";

export class AgentExchangeOperationError extends Error {
  readonly code: AgentExchangeOperationErrorCode;

  constructor(code: AgentExchangeOperationErrorCode, message: string) {
    super(message);
    this.name = "AgentExchangeOperationError";
    this.code = code;
  }
}

export type AgentExchangeOperation<TResult> = Readonly<{
  binding: AgentExchangeOperationBinding;
  cancel(): void;
  copy_manual_fallback_bytes(): Uint8Array;
  execute(): Promise<TResult>;
  phase(): AgentExchangeOperationPhase;
  subscribe(
    listener: (phase: AgentExchangeOperationPhase) => void
  ): () => void;
}>;

type InvalidatedReason = "project_changed" | "scope_changed" | "superseded";

export class AgentExchangeOperationController {
  #active: InternalAgentExchangeOperation<unknown> | null = null;
  #connectorInstances = new WeakSet<AgentExchangeConnector>();
  #operationIds = new Set<string>();

  begin<TResult>({
    connector,
    createOperationId,
    importResponse,
    prepared
  }: {
    connector: AgentExchangeConnector;
    createOperationId: () => string;
    importResponse: AgentExchangeResponseImporter<TResult>;
    prepared: PreparedAgentExchange;
  }): AgentExchangeOperation<TResult> {
    const operationId = createOperationId();
    if (!isSafeIdentity(operationId)) {
      throw new AgentExchangeOperationError(
        "invalid_operation_id",
        "The injected Agent Exchange operation ID is invalid."
      );
    }
    if (this.#operationIds.has(operationId)) {
      throw new AgentExchangeOperationError(
        "duplicate_operation_id",
        "The injected Agent Exchange operation ID was already used."
      );
    }
    const descriptor = connector.descriptor;
    if (!isSafeIdentity(descriptor.id) || !isSafeIdentity(descriptor.version)) {
      throw new AgentExchangeOperationError(
        "invalid_connector_identity",
        "The Agent Exchange connector identity is invalid."
      );
    }
    if (this.#connectorInstances.has(connector)) {
      throw new AgentExchangeOperationError(
        "connector_instance_reused",
        "The Agent Exchange connector instance was already bound to an operation."
      );
    }

    this.#active?.invalidate("superseded");
    this.#connectorInstances.add(connector);
    this.#operationIds.add(operationId);
    const operation = new InternalAgentExchangeOperation({
      connector,
      descriptor: Object.freeze({
        id: descriptor.id,
        version: descriptor.version
      }),
      importResponse,
      isOwned: (candidate) => this.#active === candidate,
      onSettled: (candidate) => {
        if (this.#active === candidate) this.#active = null;
      },
      operationId,
      prepared
    });
    this.#active = operation as InternalAgentExchangeOperation<unknown>;
    return operation;
  }

  invalidateForProjectChange(projectId: string): void {
    if (this.#active?.binding.project_id !== projectId) {
      this.#active?.invalidate("project_changed");
    }
  }

  invalidateForScopeChange(input: Readonly<{
    document_id: string;
    project_id: string;
  }>): void {
    if (
      this.#active &&
      (this.#active.binding.project_id !== input.project_id ||
        this.#active.binding.document_id !== input.document_id)
    ) {
      this.#active.invalidate("scope_changed");
    }
  }

  invalidateCurrent(): void {
    this.#active?.invalidate("project_changed");
  }
}

class InternalAgentExchangeOperation<TResult>
  implements AgentExchangeOperation<TResult>
{
  readonly binding: AgentExchangeOperationBinding;
  #abortController = new AbortController();
  #connector: AgentExchangeConnector;
  #execution: Promise<TResult> | null = null;
  #importResponse: AgentExchangeResponseImporter<TResult>;
  #invalidatedReason: InvalidatedReason | null = null;
  #isOwned: (candidate: InternalAgentExchangeOperation<TResult>) => boolean;
  #listeners = new Set<(phase: AgentExchangeOperationPhase) => void>();
  #onSettled: (candidate: InternalAgentExchangeOperation<TResult>) => void;
  #phase: AgentExchangeOperationPhase = "prepared";
  #prepared: PreparedAgentExchange;

  constructor({
    connector,
    descriptor,
    importResponse,
    isOwned,
    onSettled,
    operationId,
    prepared
  }: {
    connector: AgentExchangeConnector;
    descriptor: Readonly<{ id: string; version: string }>;
    importResponse: AgentExchangeResponseImporter<TResult>;
    isOwned: (candidate: InternalAgentExchangeOperation<TResult>) => boolean;
    onSettled: (candidate: InternalAgentExchangeOperation<TResult>) => void;
    operationId: string;
    prepared: PreparedAgentExchange;
  }) {
    this.#connector = connector;
    this.#importResponse = importResponse;
    this.#isOwned = isOwned;
    this.#onSettled = onSettled;
    this.#prepared = prepared;
    this.binding = Object.freeze({
      authority: "none",
      connector_id: descriptor.id,
      connector_version: descriptor.version,
      document_id: prepared.scope.document_id,
      expected_response_protocol: prepared.expected_response_protocol,
      expected_response_protocol_version:
        prepared.expected_response_protocol_version,
      export_scope: prepared.scope,
      max_response_bytes: prepared.max_response_bytes,
      operation_id: operationId,
      project_id: prepared.project_id,
      request_byte_length: prepared.request_byte_length,
      request_sha256: prepared.request_sha256,
      review_batch_id: prepared.review_batch_id
    });
  }

  cancel(): void {
    if (isTerminal(this.#phase)) return;
    this.#setPhase("cancelled");
    this.#abortController.abort();
  }

  copy_manual_fallback_bytes(): Uint8Array {
    return this.#prepared.copy_request_bytes();
  }

  execute(): Promise<TResult> {
    this.#execution ??= this.#run();
    return this.#execution;
  }

  invalidate(reason: InvalidatedReason): void {
    if (isTerminal(this.#phase)) return;
    this.#invalidatedReason = reason;
    this.#setPhase("invalidated");
    this.#abortController.abort();
  }

  phase(): AgentExchangeOperationPhase {
    return this.#phase;
  }

  subscribe(
    listener: (phase: AgentExchangeOperationPhase) => void
  ): () => void {
    this.#listeners.add(listener);
    listener(this.#phase);
    return () => this.#listeners.delete(listener);
  }

  async #run(): Promise<TResult> {
    try {
      this.#assertEligible();
      this.#setPhase("checking_availability");
      let availability;
      try {
        availability = await this.#connector.checkAvailability({
          signal: this.#abortController.signal
        });
      } catch {
        this.#assertEligible();
        throw new AgentExchangeOperationError(
          "connector_failed",
          "The Agent Exchange connector failed during its availability check."
        );
      }
      this.#assertEligible();
      if (availability.status !== "available") {
        this.#setPhase("unavailable");
        throw new AgentExchangeOperationError(
          "connector_unavailable",
          "The Agent Exchange connector is unavailable."
        );
      }

      this.#setPhase("submitting");
      let response: AgentExchangeConnectorResponse;
      try {
        const responsePromise = this.#connector.submit({
          binding: this.binding,
          request_bytes: this.#prepared.copy_request_bytes(),
          signal: this.#abortController.signal
        });
        this.#setPhase("waiting");
        response = await responsePromise;
      } catch {
        this.#assertEligible();
        throw new AgentExchangeOperationError(
          "connector_failed",
          "The Agent Exchange connector failed while delivering the prepared request."
        );
      }
      this.#assertEligible();
      const responseBytes = Uint8Array.from(response.response_bytes);
      validateResponseBinding(this.binding, response, responseBytes);
      this.#assertEligible();

      this.#setPhase("importing");
      const imported = await this.#importResponse({
        binding: this.binding,
        response_bytes: Uint8Array.from(responseBytes),
        validate_before_commit: () => this.#assertEligible()
      });
      this.#assertEligible();
      this.#setPhase("completed");
      return imported;
    } catch (error) {
      if (!isTerminal(this.#phase)) this.#setPhase("failed");
      throw error;
    } finally {
      try {
        await this.#connector.close();
      } catch {
        // Cleanup errors cannot reverse an authoritative import or expose data.
      }
      this.#onSettled(this);
    }
  }

  #assertEligible(): void {
    if (
      this.#phase === "cancelled" ||
      (this.#abortController.signal.aborted && !this.#invalidatedReason)
    ) {
      throw new AgentExchangeOperationError(
        "operation_cancelled",
        "The Agent Exchange operation was cancelled."
      );
    }
    if (this.#invalidatedReason || !this.#isOwned(this)) {
      throw new AgentExchangeOperationError(
        "operation_invalidated",
        "The Agent Exchange operation no longer owns the active project scope."
      );
    }
  }

  #setPhase(phase: AgentExchangeOperationPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    for (const listener of this.#listeners) {
      try {
        listener(phase);
      } catch {
        // Product observation cannot change transport/import authority.
      }
    }
  }
}

function validateResponseBinding(
  expected: AgentExchangeOperationBinding,
  response: AgentExchangeConnectorResponse,
  responseBytes: Uint8Array
): void {
  if (
    responseBytes.byteLength > expected.max_response_bytes ||
    response.binding.response_byte_length > expected.max_response_bytes
  ) {
    throw new AgentExchangeOperationError(
      "response_oversized",
      "The Agent Exchange response exceeds the operation size ceiling."
    );
  }
  if (response.binding.response_byte_length !== responseBytes.byteLength) {
    throw new AgentExchangeOperationError(
      "response_length_mismatch",
      "The Agent Exchange response length does not match its operation binding."
    );
  }
  const exact =
    response.binding.authority === "none" &&
    response.binding.connector_id === expected.connector_id &&
    response.binding.connector_version === expected.connector_version &&
    response.binding.document_id === expected.document_id &&
    response.binding.expected_response_protocol ===
      expected.expected_response_protocol &&
    response.binding.expected_response_protocol_version ===
      expected.expected_response_protocol_version &&
    sameScope(response.binding.export_scope, expected.export_scope) &&
    response.binding.max_response_bytes === expected.max_response_bytes &&
    response.binding.operation_id === expected.operation_id &&
    response.binding.project_id === expected.project_id &&
    response.binding.request_byte_length === expected.request_byte_length &&
    response.binding.request_sha256 === expected.request_sha256 &&
    response.binding.review_batch_id === expected.review_batch_id &&
    response.binding.response_protocol === AGENT_EXCHANGE_RESPONSE_PROTOCOL &&
    response.binding.response_protocol_version ===
      AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION;
  if (!exact) {
    throw new AgentExchangeOperationError(
      "response_binding_mismatch",
      "The Agent Exchange response does not belong to the active operation."
    );
  }
}

function sameScope(
  left: AgentExchangeOperationBinding["export_scope"],
  right: AgentExchangeOperationBinding["export_scope"]
): boolean {
  return (
    left.kind === right.kind &&
    left.document_id === right.document_id &&
    left.batch_type === right.batch_type &&
    left.source === right.source
  );
}

function isSafeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isTerminal(phase: AgentExchangeOperationPhase): boolean {
  return (
    phase === "completed" ||
    phase === "cancelled" ||
    phase === "invalidated" ||
    phase === "unavailable" ||
    phase === "failed"
  );
}
