const draftKeyPrefix = "patchmark:draft:";

export type DocumentDraft = {
  fileName: string;
  markdown: string;
  updatedAt: string;
};

export type LegacyUnscopedDocumentDraft = DocumentDraft & {
  storageKey: string;
};

export function getDocumentDraftKey(fileName: string): string {
  return `${draftKeyPrefix}${encodeURIComponent(fileName)}`;
}

export function saveDocumentDraft(draft: DocumentDraft): void {
  if (!canUseLocalStorage()) {
    return;
  }

  localStorage.setItem(getDocumentDraftKey(draft.fileName), JSON.stringify(draft));
}

export function deleteDocumentDraft(fileName: string): void {
  if (!canUseLocalStorage()) {
    return;
  }

  localStorage.removeItem(getDocumentDraftKey(fileName));
}

export function readMostRecentDocumentDraft(): DocumentDraft | null {
  return readLegacyUnscopedDocumentDrafts().sort(
    (draftA, draftB) =>
      Date.parse(draftB.updatedAt) - Date.parse(draftA.updatedAt)
  )[0] ?? null;
}

export function readLegacyUnscopedDocumentDrafts(): LegacyUnscopedDocumentDraft[] {
  if (!canUseLocalStorage()) {
    return [];
  }

  const drafts: LegacyUnscopedDocumentDraft[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);

    if (!key?.startsWith(draftKeyPrefix)) {
      continue;
    }

    const draft = readDraftFromKey(key);

    if (draft) {
      drafts.push({ ...draft, storageKey: key });
    }
  }

  return drafts.sort(
    (draftA, draftB) =>
      Date.parse(draftB.updatedAt) - Date.parse(draftA.updatedAt)
  );
}

export function deleteLegacyUnscopedDocumentDraft(storageKey: string): void {
  if (!canUseLocalStorage() || !storageKey.startsWith(draftKeyPrefix)) {
    return;
  }
  localStorage.removeItem(storageKey);
}

function readDraftFromKey(key: string): DocumentDraft | null {
  const value = localStorage.getItem(key);

  if (!value) {
    return null;
  }

  try {
    const parsedValue = JSON.parse(value) as Partial<DocumentDraft>;

    if (
      typeof parsedValue.fileName !== "string" ||
      typeof parsedValue.markdown !== "string" ||
      typeof parsedValue.updatedAt !== "string" ||
      Number.isNaN(Date.parse(parsedValue.updatedAt))
    ) {
      return null;
    }

    return {
      fileName: parsedValue.fileName,
      markdown: parsedValue.markdown,
      updatedAt: parsedValue.updatedAt
    };
  } catch {
    return null;
  }
}

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}
