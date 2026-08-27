import type {
  Hc3ProductCapabilityName,
  Hc3ProductCapabilityState
} from "./product-capabilities.ts";

export type Hc3CapabilityOperationPhase =
  | "before_operation"
  | "during_operation"
  | "result_validation";

export type Hc3CapabilityOperationFailure = Readonly<{
  authority: "none";
  capability: Hc3ProductCapabilityName;
  state: Extract<Hc3ProductCapabilityState,
    | "permission_denied"
    | "temporarily_unavailable"
    | "lost_during_operation"
    | "incompatible_result">;
  phase: Hc3CapabilityOperationPhase;
  recovery: "retry_explicitly" | "use_fallback" | "blocked";
  fallback: string | null;
  automatic_retry: false;
  prepared_artifact_preserved: true;
  resources_released: boolean;
  diagnostic_code: string;
}>;

export function classifyHc3CapabilityOperationFailure(input: Readonly<{
  capability: Hc3ProductCapabilityName;
  phase: Hc3CapabilityOperationPhase;
  error: unknown;
  fallback: string | null;
  resources_released: boolean;
}>): Hc3CapabilityOperationFailure {
  const errorName = readErrorName(input.error);
  const state = classifyState(errorName, input.phase);
  return Object.freeze({
    authority: "none",
    capability: input.capability,
    state,
    phase: input.phase,
    recovery: input.fallback ? "use_fallback" : state === "temporarily_unavailable" ? "retry_explicitly" : "blocked",
    fallback: input.fallback,
    automatic_retry: false,
    prepared_artifact_preserved: true,
    resources_released: input.resources_released,
    diagnostic_code: `${input.capability}_${state}`
  });
}

export function safeHc3DiagnosticMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  if (!message || containsSensitiveDiagnosticMaterial(message)) {
    return "The operation failed safely. Technical code: collaboration_operation_failed.";
  }
  const withoutControls = message.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
  return withoutControls.slice(0, 240);
}

export function safeHc3DisplayLabel(value: string): string {
  const normalized = value.normalize("NFC").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return normalized ? normalized.slice(0, 128) : "Unnamed collaborator";
}

export function containsSensitiveDiagnosticMaterial(value: string): boolean {
  return /(?:pmhc3\.|-----BEGIN|private[_ -]?key|recovery(?:[_ -]?material|[_ -]?bytes|[_ -]?secret)|plaintext|hpke[_ -]?private|clipboard(?:[_ -]?contents)?|file:\/\/|\/(?:Users|home|private|tmp)\/|[a-f0-9]{96,}|[A-Za-z0-9+/]{160,}={0,2})/i.test(value);
}

function classifyState(
  name: string,
  phase: Hc3CapabilityOperationPhase
): Hc3CapabilityOperationFailure["state"] {
  if (name === "NotAllowedError" || name === "SecurityError") {
    return phase === "before_operation" ? "permission_denied" : "lost_during_operation";
  }
  if (name === "NotReadableError" || name === "InvalidStateError" || name === "NetworkError") {
    return phase === "during_operation" ? "lost_during_operation" : "temporarily_unavailable";
  }
  if (name === "TypeError" || name === "DataError" || phase === "result_validation") return "incompatible_result";
  return "temporarily_unavailable";
}

function readErrorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string"
    ? error.name
    : "Error";
}
