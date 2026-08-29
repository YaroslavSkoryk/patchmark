export const AGENT_EXCHANGE_RESPONSE_PROTOCOL =
  "patchmark.comment_reply_import" as const;
export const AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION = 2 as const;
export const AGENT_EXCHANGE_DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type AgentExchangeAuthority = "none";

export type AgentExchangeConnectorDescriptor = Readonly<{
  id: string;
  version: string;
}>;

export type AgentExchangeDocumentScope = Readonly<{
  batch_type: "follow_up" | "document_level" | "section" | "manual";
  document_id: string;
  kind: "document";
  source: "guided_review" | "manual";
}>;

export type PreparedAgentExchange = Readonly<{
  authority: AgentExchangeAuthority;
  copy_request_bytes(): Uint8Array;
  expected_response_protocol: typeof AGENT_EXCHANGE_RESPONSE_PROTOCOL;
  expected_response_protocol_version:
    typeof AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION;
  max_response_bytes: number;
  project_id: string;
  request_byte_length: number;
  request_sha256: string;
  review_batch_id: string;
  scope: AgentExchangeDocumentScope;
}>;

export type AgentExchangeOperationBinding = Readonly<{
  authority: AgentExchangeAuthority;
  connector_id: string;
  connector_version: string;
  document_id: string;
  expected_response_protocol: typeof AGENT_EXCHANGE_RESPONSE_PROTOCOL;
  expected_response_protocol_version:
    typeof AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION;
  export_scope: AgentExchangeDocumentScope;
  max_response_bytes: number;
  operation_id: string;
  project_id: string;
  request_byte_length: number;
  request_sha256: string;
  review_batch_id: string;
}>;

export type AgentExchangeResponseBinding = AgentExchangeOperationBinding &
  Readonly<{
    response_byte_length: number;
    response_protocol: typeof AGENT_EXCHANGE_RESPONSE_PROTOCOL;
    response_protocol_version:
      typeof AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION;
  }>;

export type AgentExchangeConnectorSubmission = Readonly<{
  binding: AgentExchangeOperationBinding;
  request_bytes: Uint8Array;
  signal: AbortSignal;
}>;

export type AgentExchangeConnectorResponse = Readonly<{
  binding: AgentExchangeResponseBinding;
  response_bytes: Uint8Array;
}>;

export type AgentExchangeAvailability =
  | Readonly<{ status: "available" }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "connector_disabled"
        | "connector_not_ready"
        | "connector_unsupported";
    }>;

export interface AgentExchangeConnector {
  readonly descriptor: AgentExchangeConnectorDescriptor;
  checkAvailability(input: Readonly<{
    signal: AbortSignal;
  }>): Promise<AgentExchangeAvailability>;
  submit(
    input: AgentExchangeConnectorSubmission
  ): Promise<AgentExchangeConnectorResponse>;
  close(): void | Promise<void>;
}

export type AgentExchangeResponseImporter<TResult> = (
  input: Readonly<{
    binding: AgentExchangeOperationBinding;
    response_bytes: Uint8Array;
    validate_before_commit: () => void;
  }>
) => Promise<TResult>;

export type AgentExchangeOperationPhase =
  | "prepared"
  | "checking_availability"
  | "submitting"
  | "waiting"
  | "importing"
  | "completed"
  | "cancelled"
  | "invalidated"
  | "unavailable"
  | "failed";
