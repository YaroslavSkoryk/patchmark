import type {
  PatchmarkDocumentIdentity,
  PatchmarkManifest
} from "./project-types.ts";

export function createNewPatchmarkProjectId(): string {
  const randomId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  return `PM-PROJECT-${randomId}`;
}

export function getPatchmarkProjectId(
  manifest: Pick<
    PatchmarkManifest,
    "created_at" | "document_file" | "project_id" | "project_name"
  >
): string {
  if (manifest.project_id?.trim()) {
    return manifest.project_id;
  }

  const legacyIdentity = [
    manifest.created_at,
    manifest.project_name,
    manifest.document_file
  ].join("\u0000");

  return `PM-PROJECT-LEGACY-${hashIdentity(legacyIdentity)}`;
}

export function getPatchmarkDocumentIdentity(
  manifest: Pick<
    PatchmarkManifest,
    "created_at" | "document_file" | "project_id" | "project_name"
  >
): PatchmarkDocumentIdentity {
  return {
    project_id: getPatchmarkProjectId(manifest),
    document_file: manifest.document_file
  };
}

export function createPatchmarkDocumentIdentityKey(
  identity: PatchmarkDocumentIdentity
): string {
  return `${encodeURIComponent(identity.project_id)}::${encodeURIComponent(
    identity.document_file
  )}`;
}

function hashIdentity(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}
