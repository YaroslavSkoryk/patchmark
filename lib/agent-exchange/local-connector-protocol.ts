export const LOCAL_CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const LOCAL_CONNECTOR_DEFAULT_PORT = 43_187;
export const LOCAL_CONNECTOR_DEFAULT_URL =
  `http://127.0.0.1:${LOCAL_CONNECTOR_DEFAULT_PORT}` as const;
export const LOCAL_CONNECTOR_MAX_REQUEST_BYTES = 1024 * 1024;
export const LOCAL_CONNECTOR_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const LOCAL_CONNECTOR_ID = "patchmark.local_codex_exec" as const;
export const LOCAL_CONNECTOR_VERSION = "0.1.0" as const;
export const PUBLICLY_SUPPORTED_CODEX_VERSIONS = Object.freeze([
  "0.151.0"
] as const);
export const DEVELOPMENT_QUALIFIED_CODEX_VERSIONS = Object.freeze([
  "0.148.0-alpha.15"
] as const);

export type CodexVersionQualification =
  | "development_qualified"
  | "publicly_supported"
  | "unsupported";

export function classifyCodexVersion(
  version: string
): CodexVersionQualification {
  if (
    PUBLICLY_SUPPORTED_CODEX_VERSIONS.some(
      (supportedVersion) => version === supportedVersion
    )
  ) {
    return "publicly_supported";
  }
  if (
    DEVELOPMENT_QUALIFIED_CODEX_VERSIONS.some(
      (qualifiedVersion) => version === qualifiedVersion
    )
  ) {
    return "development_qualified";
  }
  return "unsupported";
}

export type LocalConnectorErrorCode =
  | "authentication_required"
  | "busy"
  | "cancelled"
  | "codex_unavailable"
  | "codex_unsupported"
  | "connector_unavailable"
  | "connector_unsupported"
  | "connector_protocol_error"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "not_paired"
  | "provider_failed"
  | "request_too_large"
  | "response_too_large";

export const LOCAL_CONNECTOR_PROTOCOL_DIAGNOSTIC_CATEGORIES = Object.freeze([
  "ambiguous_final_response",
  "forbidden_tool_event",
  "invalid_event_stream",
  "unsupported_event_type",
  "unsupported_item_type"
] as const);

export type LocalConnectorProtocolDiagnosticCategory =
  (typeof LOCAL_CONNECTOR_PROTOCOL_DIAGNOSTIC_CATEGORIES)[number];

export type LocalConnectorProtocolDiagnostic = Readonly<{
  category: LocalConnectorProtocolDiagnosticCategory;
  invalid_field_kind: string | null;
  invalid_field_name: string | null;
  item_is_object: boolean;
  item_present: boolean;
  item_type_present: boolean;
  item_type_string: boolean;
  missing_required_field_names: readonly string[];
  sorted_item_key_names: readonly string[];
  top_level_type: string | null;
  unexpected_field_names: readonly string[];
}>;

export function isLocalConnectorProtocolDiagnostic(
  value: unknown
): value is LocalConnectorProtocolDiagnostic {
  return (
    isExactRecord(value, [
      "category",
      "invalid_field_kind",
      "invalid_field_name",
      "item_is_object",
      "item_present",
      "item_type_present",
      "item_type_string",
      "missing_required_field_names",
      "sorted_item_key_names",
      "top_level_type",
      "unexpected_field_names"
    ]) &&
    typeof value.category === "string" &&
    LOCAL_CONNECTOR_PROTOCOL_DIAGNOSTIC_CATEGORIES.some(
      (category) => category === value.category
    ) &&
    isSafeDiagnosticToken(value.invalid_field_kind) &&
    isSafeDiagnosticFieldName(value.invalid_field_name) &&
    typeof value.item_is_object === "boolean" &&
    typeof value.item_present === "boolean" &&
    typeof value.item_type_present === "boolean" &&
    typeof value.item_type_string === "boolean" &&
    isSortedSafeDiagnosticFieldNames(value.missing_required_field_names) &&
    isSortedSafeDiagnosticFieldNames(value.sorted_item_key_names) &&
    isSafeDiagnosticToken(value.top_level_type) &&
    isSortedSafeDiagnosticFieldNames(value.unexpected_field_names)
  );
}

export class LocalConnectorError extends Error {
  readonly code: LocalConnectorErrorCode;
  readonly status: number | null;

  constructor(
    code: LocalConnectorErrorCode,
    message: string,
    status: number | null = null
  ) {
    super(message);
    this.name = "LocalConnectorError";
    this.code = code;
    this.status = status;
  }
}

export type LocalConnectorStatus = Readonly<{
  busy: boolean;
  codex_version: string | null;
  compatibility: "supported" | "unavailable" | "unsupported";
  connector_id: typeof LOCAL_CONNECTOR_ID;
  connector_version: typeof LOCAL_CONNECTOR_VERSION;
  instance_id: string;
  paired: boolean;
  protocol_version: typeof LOCAL_CONNECTOR_PROTOCOL_VERSION;
  supported_codex_versions: readonly string[];
}>;

export type LocalConnectorExchangeRequest = Readonly<{
  expected_response_protocol: "patchmark.comment_reply_import";
  expected_response_protocol_version: 2;
  max_response_bytes: number;
  operation_id: string;
  protocol_version: typeof LOCAL_CONNECTOR_PROTOCOL_VERSION;
  request_base64: string;
  request_byte_length: number;
  request_sha256: string;
}>;

export type LocalConnectorExchangeResponse = Readonly<{
  operation_id: string;
  protocol_version: typeof LOCAL_CONNECTOR_PROTOCOL_VERSION;
  response_base64: string;
  response_byte_length: number;
}>;

export function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isSafeOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isSafeDiagnosticToken(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 64 &&
      /^[a-z][a-z0-9._-]*$/.test(value))
  );
}

function isSafeDiagnosticFieldName(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 64 &&
      /^_?[a-z][a-z0-9_]*$/.test(value))
  );
}

function isSortedSafeDiagnosticFieldNames(
  value: unknown
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (field, index) =>
        isSafeDiagnosticFieldName(field) &&
        field !== null &&
        (index === 0 || value[index - 1] < field)
    )
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new LocalConnectorError(
      "connector_protocol_error",
      "The local connector returned invalid base64."
    );
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytesToBase64(bytes) !== value) {
    throw new LocalConnectorError(
      "connector_protocol_error",
      "The local connector returned non-canonical base64."
    );
  }
  return bytes;
}
