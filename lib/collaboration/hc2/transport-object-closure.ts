import { parseEntityId, type AccessScopeId, type ProjectId } from "../identities.ts";
import {
  parseCollaborationObjectId,
  parseCollaborationObjectKind,
  type CollaborationAddressedObject,
  type CollaborationObjectId,
  type CollaborationObjectKind
} from "../storage.ts";
import {
  createChunkPayloadCore,
  type ChunkPayloadCore,
  type ChunkPayloadObjectInput
} from "./envelope.ts";
import { Hc1CanonicalPortableObjectVerifier } from "./hc1-object-verifier.ts";
import { hc2ProtocolLimits } from "./limits.ts";
import type { TransportBindingCommonV2 } from "./transport-v2-contracts.ts";

export interface Hc1ExactObjectSource {
  readExactObject(input: CollaborationAddressedObject): Promise<Uint8Array | null>;
}

export type ClosedHc1Object = Readonly<{
  object_kind: CollaborationObjectKind;
  object_id: CollaborationObjectId;
  exact_bytes: Uint8Array;
  dependency_ids: readonly CollaborationObjectId[];
  dependency_depth: number;
}>;

export async function resolveDeterministicHc1Closure(input: Readonly<{
  project_id: ProjectId;
  roots: readonly CollaborationAddressedObject[];
  source: Hc1ExactObjectSource;
}>): Promise<readonly ClosedHc1Object[]> {
  const project = parseEntityId("project", input.project_id);
  if (!Array.isArray(input.roots) || input.roots.length === 0) throw new Error("HC-1 transport selection requires at least one explicit root.");
  const verifier = new Hc1CanonicalPortableObjectVerifier(project);
  const pending = new Map<string, CollaborationAddressedObject>();
  for (const root of input.roots) {
    const addressed = parseAddressedObject(root);
    pending.set(objectKey(addressed.kind, addressed.id), addressed);
  }
  const collected = new Map<string, Omit<ClosedHc1Object, "dependency_depth">>();
  while (pending.size > 0) {
    const nextKey = [...pending.keys()].sort()[0];
    const addressed = pending.get(nextKey);
    if (!addressed) throw new Error("Deterministic closure queue invariant failed.");
    pending.delete(nextKey);
    if (collected.has(nextKey)) continue;
    if (collected.size >= hc2ProtocolLimits.maximum_chunks_per_bundle * hc2ProtocolLimits.maximum_objects_per_chunk) {
      throw new Error("HC-1 dependency closure exceeds the frozen object-count bound.");
    }
    const bytes = await input.source.readExactObject(addressed);
    if (!(bytes instanceof Uint8Array)) throw new Error(`Required HC-1 dependency is missing: ${addressed.id}.`);
    if (BigInt(bytes.length) > hc2ProtocolLimits.maximum_canonical_object_bytes) throw new Error(`HC-1 object exceeds the frozen canonical byte limit: ${addressed.id}.`);
    const verified = await verifier.verifyExactObject({
      object_kind: addressed.kind,
      object_id: addressed.id as never,
      exact_bytes: bytes
    });
    const dependencies = Object.freeze([...verified.dependency_ids].sort());
    collected.set(nextKey, Object.freeze({
      object_kind: addressed.kind,
      object_id: addressed.id,
      exact_bytes: Uint8Array.from(bytes),
      dependency_ids: dependencies
    }));
    for (const dependencyId of dependencies) {
      const dependency = addressedFromId(dependencyId);
      const key = objectKey(dependency.kind, dependency.id);
      if (!collected.has(key)) pending.set(key, dependency);
    }
  }
  const depthById = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: CollaborationObjectId): number => {
    const key = objectKeyFromId(id);
    const known = depthById.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) throw new Error("HC-1 dependency closure contains a cycle.");
    const object = collected.get(key);
    if (!object) throw new Error(`HC-1 dependency closure is incomplete: ${id}.`);
    visiting.add(key);
    let result = 0;
    for (const dependency of object.dependency_ids) result = Math.max(result, depth(dependency) + 1);
    visiting.delete(key);
    if (result > hc2ProtocolLimits.maximum_dependency_depth) throw new Error("HC-1 dependency closure exceeds the frozen depth limit.");
    depthById.set(key, result);
    return result;
  };
  const closed = [...collected.values()].map((entry) => Object.freeze({
    ...entry,
    exact_bytes: Uint8Array.from(entry.exact_bytes),
    dependency_depth: depth(entry.object_id)
  }));
  closed.sort((left, right) => left.dependency_depth - right.dependency_depth || compareAscii(objectKey(left.object_kind, left.object_id), objectKey(right.object_kind, right.object_id)));
  return Object.freeze(closed);
}

export async function createDeterministicTransportChunks(input: Readonly<{
  project_id: ProjectId;
  scope_id: AccessScopeId;
  common_binding: TransportBindingCommonV2;
  objects: readonly ClosedHc1Object[];
}>): Promise<readonly ChunkPayloadCore[]> {
  const project = parseEntityId("project", input.project_id);
  const scope = parseEntityId("access-scope", input.scope_id);
  if (project !== input.common_binding.project_id) throw new Error("Chunk project differs from transport binding project.");
  if (!Array.isArray(input.objects) || input.objects.length === 0) throw new Error("Transport chunking requires a nonempty verified closure.");
  const chunks: ChunkPayloadCore[] = [];
  let current: ClosedHc1Object[] = [];
  let currentBytes = BigInt(0);
  const flush = async (): Promise<void> => {
    if (current.length === 0) return;
    chunks.push(await buildChunk(project, scope, input.common_binding, current));
    current = [];
    currentBytes = BigInt(0);
  };
  for (const object of input.objects) {
    const nextBytes = currentBytes + BigInt(object.exact_bytes.length);
    if (current.length > 0 && (current.length >= hc2ProtocolLimits.maximum_objects_per_chunk || nextBytes > hc2ProtocolLimits.maximum_total_object_bytes_per_chunk)) {
      await flush();
    }
    current.push(object);
    currentBytes += BigInt(object.exact_bytes.length);
  }
  await flush();
  if (chunks.length + 1 > hc2ProtocolLimits.maximum_chunks_per_bundle) throw new Error("Transport chunk count exceeds the frozen payload limit.");
  return Object.freeze(chunks);
}

async function buildChunk(project: ProjectId, scope: AccessScopeId, binding: TransportBindingCommonV2, objects: readonly ClosedHc1Object[]): Promise<ChunkPayloadCore> {
  return createChunkPayloadCore({
    project_id: project,
    scope_id: scope,
    sender_person_id: binding.sender_person_id,
    sender_device_id: binding.sender_device_id,
    recipient_device_id: binding.recipient_device_id,
    recipient_key_id: binding.recipient_key_id,
    key_epoch_id: binding.key_epoch_id,
    accepted_control_head_id: binding.accepted_control_head_id,
    bundle_kind: binding.purpose === "admission" ? "enrollment_delivery" : "collaboration_exchange",
    objects: objects.map((entry): ChunkPayloadObjectInput => ({
      object_kind: entry.object_kind,
      object_id: entry.object_id,
      exact_bytes: entry.exact_bytes,
      dependency_ids: entry.dependency_ids,
      dependency_depth: entry.dependency_depth
    }))
  });
}

function parseAddressedObject(value: CollaborationAddressedObject): CollaborationAddressedObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) throw new Error("HC-1 object selection entry is malformed.");
  const kind = parseCollaborationObjectKind(value.kind);
  return Object.freeze({ kind, id: parseCollaborationObjectId(kind, value.id) }) as CollaborationAddressedObject;
}

function addressedFromId(id: CollaborationObjectId): CollaborationAddressedObject {
  const match = /^pm:([^:]+):v1:/.exec(id);
  if (!match) throw new Error("HC-1 dependency ID has an unsupported namespace.");
  const kind = parseCollaborationObjectKind(match[1]);
  return Object.freeze({ kind, id: parseCollaborationObjectId(kind, id) }) as CollaborationAddressedObject;
}

function objectKeyFromId(id: CollaborationObjectId): string {
  const addressed = addressedFromId(id);
  return objectKey(addressed.kind, addressed.id);
}

function objectKey(kind: CollaborationObjectKind, id: CollaborationObjectId): string { return `${kind}\u0000${id}`; }
function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
