import {
  readExactReviewBatchPromptBytes
} from "../review-batches/review-batch-export.ts";
import { createReviewBatchBytesSha256 } from "../review-batches/review-batch-fingerprints.ts";
import type { PatchmarkReviewBatch } from "../review-batches/review-batch-types.ts";
import type { PatchmarkProjectHandle } from "../project/patchmark-project.ts";
import {
  AGENT_EXCHANGE_DEFAULT_MAX_RESPONSE_BYTES,
  AGENT_EXCHANGE_RESPONSE_PROTOCOL,
  AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION,
  type PreparedAgentExchange
} from "./contracts.ts";

export async function prepareAgentExchange({
  batch,
  maxResponseBytes = AGENT_EXCHANGE_DEFAULT_MAX_RESPONSE_BYTES,
  project
}: {
  batch: PatchmarkReviewBatch;
  maxResponseBytes?: number;
  project: PatchmarkProjectHandle;
}): Promise<PreparedAgentExchange> {
  if (batch.status !== "exported") {
    throw new Error(
      "Agent Exchange can prepare only an active exported Review Batch."
    );
  }
  if (
    batch.response_protocol_version !== undefined &&
    batch.response_protocol_version !== AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION
  ) {
    throw new Error(
      "Agent Exchange can prepare only a Review Batch that requests protocol version 2."
    );
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 64 * 1024 * 1024
  ) {
    throw new Error("The Agent Exchange response-size ceiling is invalid.");
  }
  const requestBytes = await readExactReviewBatchPromptBytes({ batch, project });
  const requestSha256 = await createReviewBatchBytesSha256(requestBytes);
  const scope = Object.freeze({
    batch_type: batch.batch_type,
    document_id: batch.document_id,
    kind: "document" as const,
    source: batch.source
  });

  return Object.freeze({
    authority: "none" as const,
    copy_request_bytes: () => Uint8Array.from(requestBytes),
    expected_response_protocol: AGENT_EXCHANGE_RESPONSE_PROTOCOL,
    expected_response_protocol_version:
      AGENT_EXCHANGE_RESPONSE_PROTOCOL_VERSION,
    max_response_bytes: maxResponseBytes,
    project_id: batch.project_id,
    request_byte_length: requestBytes.byteLength,
    request_sha256: requestSha256,
    review_batch_id: batch.batch_id,
    scope
  });
}

/** Manual delivery reuses the already-prepared bytes and never re-exports. */
export function copyPreparedExchangeForManualDelivery(
  prepared: PreparedAgentExchange
): Uint8Array {
  return prepared.copy_request_bytes();
}
