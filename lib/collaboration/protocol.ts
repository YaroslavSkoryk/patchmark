import {
  COLLABORATION_PROTOCOL_NAME,
  COLLABORATION_PROTOCOL_VERSION
} from "./versions.ts";
import {
  expectEnum,
  expectExactRecord,
  expectLiteral,
  freezeRecord
} from "./validation.ts";

export const protocolObjectKinds = [
  "document_revision",
  "semantic_payload",
  "semantic_event",
  "control_action",
  "control_event",
  "checkpoint_payload",
  "projection_snapshot",
  "admission_boundary",
  "acknowledgement",
  "attestation",
  "derived_conflict"
] as const;

export type ProtocolObjectKind = (typeof protocolObjectKinds)[number];

export type CollaborationProtocolEnvelope<
  TKind extends ProtocolObjectKind,
  TBody
> = Readonly<{
  protocol: typeof COLLABORATION_PROTOCOL_NAME;
  protocol_version: typeof COLLABORATION_PROTOCOL_VERSION;
  object_kind: TKind;
  body: TBody;
}>;

/**
 * Validates the critical envelope and delegates strict body validation to the
 * object-specific parser. There is intentionally no "unknown object" result.
 */
export function parseProtocolEnvelope<TKind extends ProtocolObjectKind, TBody>(
  value: unknown,
  expectedKind: TKind,
  parseBody: (body: unknown) => TBody
): CollaborationProtocolEnvelope<TKind, TBody> {
  const record = expectExactRecord(value, "collaboration protocol envelope", [
    "protocol",
    "protocol_version",
    "object_kind",
    "body"
  ]);
  expectLiteral(
    record.protocol,
    COLLABORATION_PROTOCOL_NAME,
    "collaboration protocol name"
  );
  expectLiteral(
    record.protocol_version,
    COLLABORATION_PROTOCOL_VERSION,
    "collaboration protocol version"
  );
  const kind = expectEnum(
    record.object_kind,
    protocolObjectKinds,
    "collaboration protocol object kind"
  );
  if (kind !== expectedKind) {
    throw new Error(
      `Expected collaboration object kind ${expectedKind}, received ${kind}.`
    );
  }
  return freezeRecord({
    protocol: COLLABORATION_PROTOCOL_NAME,
    protocol_version: COLLABORATION_PROTOCOL_VERSION,
    object_kind: expectedKind,
    body: parseBody(record.body)
  });
}
