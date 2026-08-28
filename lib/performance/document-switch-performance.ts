export type DocumentSwitchPerformanceMetadata = {
  cache?: "hit" | "miss" | "not_used";
  changedFiles?: string[];
  comments?: number;
  documentBytes?: number;
  projectId: string;
  patches?: number;
  saveStatus?: "committed" | "unchanged" | "superseded";
  sourceDocumentId: string;
  targetDocumentId: string;
  trigger: "bookmark" | "navigator";
  versions?: number;
};

export type DocumentSwitchPerformanceOperation = {
  counters: Record<string, number>;
  durations: Record<string, number>;
  finishedAt?: number;
  id: string;
  marks: Record<string, number>;
  metadata: DocumentSwitchPerformanceMetadata;
  startedAt: number;
};

type DocumentSwitchPerformanceApi = {
  clear: () => void;
  enabled: true;
  getRecords: () => DocumentSwitchPerformanceOperation[];
  records: DocumentSwitchPerformanceOperation[];
};

declare global {
  interface Window {
    __PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__?: DocumentSwitchPerformanceApi;
  }
}

const MAX_RECORDED_OPERATIONS = 200;
let operationCounter = 0;
let pendingDomSyncOperation: DocumentSwitchPerformanceOperation | null = null;
let domSyncScheduled = false;

export function startDocumentSwitchPerformanceOperation(
  metadata: DocumentSwitchPerformanceMetadata
): string | null {
  const api = getDocumentSwitchPerformanceApi();

  if (!api) {
    return null;
  }

  const startedAt = performance.now();
  const operation: DocumentSwitchPerformanceOperation = {
    counters: {},
    durations: {},
    id: `switch-${Date.now()}-${operationCounter += 1}`,
    marks: { switch_requested: 0 },
    metadata: { ...metadata },
    startedAt
  };
  api.records.push(operation);
  syncDocumentSwitchPerformanceDom(operation);

  if (api.records.length > MAX_RECORDED_OPERATIONS) {
    api.records.splice(0, api.records.length - MAX_RECORDED_OPERATIONS);
  }

  return operation.id;
}

export function markDocumentSwitchPerformance(
  operationId: string | null | undefined,
  name: string,
  options: { latest?: boolean } = {}
): void {
  const operation = getDocumentSwitchPerformanceOperation(operationId);

  if (operation && (options.latest || !(name in operation.marks))) {
    operation.marks[name] = performance.now() - operation.startedAt;
    syncDocumentSwitchPerformanceDom(operation);
  }
}

export function recordDocumentSwitchPerformanceDuration(
  operationId: string | null | undefined,
  name: string,
  duration: number
): void {
  const operation = getDocumentSwitchPerformanceOperation(operationId);

  if (operation) {
    operation.durations[name] =
      (operation.durations[name] ?? 0) + Math.max(0, duration);
    syncDocumentSwitchPerformanceDom(operation);
  }
}

export function incrementDocumentSwitchPerformanceCounter(
  operationId: string | null | undefined,
  name: string,
  amount = 1
): void {
  const operation = getDocumentSwitchPerformanceOperation(operationId);

  if (operation) {
    operation.counters[name] = (operation.counters[name] ?? 0) + amount;
    syncDocumentSwitchPerformanceDom(operation);
  }
}

export function updateDocumentSwitchPerformanceMetadata(
  operationId: string | null | undefined,
  metadata: Partial<DocumentSwitchPerformanceMetadata>
): void {
  const operation = getDocumentSwitchPerformanceOperation(operationId);

  if (operation) {
    Object.assign(operation.metadata, metadata);
    syncDocumentSwitchPerformanceDom(operation);
  }
}

export function finishDocumentSwitchPerformanceOperation(
  operationId: string | null | undefined
): void {
  const operation = getDocumentSwitchPerformanceOperation(operationId);

  if (operation && operation.finishedAt === undefined) {
    const finishedAt = performance.now();
    operation.finishedAt = finishedAt;
    operation.marks.secondary_work_complete = finishedAt - operation.startedAt;
    syncDocumentSwitchPerformanceDom(operation);
  }
}

export function getLatestDocumentSwitchPerformanceOperationId(): string | null {
  return getDocumentSwitchPerformanceApi()?.records.at(-1)?.id ?? null;
}

function getDocumentSwitchPerformanceOperation(
  operationId: string | null | undefined
): DocumentSwitchPerformanceOperation | null {
  if (!operationId) {
    return null;
  }

  return (
    getDocumentSwitchPerformanceApi()?.records.find(
      (operation) => operation.id === operationId
    ) ?? null
  );
}

function getDocumentSwitchPerformanceApi(): DocumentSwitchPerformanceApi | null {
  if (typeof window === "undefined" || !isDocumentSwitchPerformanceEnabled()) {
    return null;
  }

  if (!window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__) {
    const records: DocumentSwitchPerformanceOperation[] = [];
    window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__ = {
      clear() {
        records.splice(0, records.length);
        pendingDomSyncOperation = null;
        if (typeof document !== "undefined") {
          document.documentElement.removeAttribute(
            "data-patchmark-switch-performance"
          );
        }
      },
      enabled: true,
      getRecords() {
        return records.map((operation) => ({
          ...operation,
          counters: { ...operation.counters },
          durations: { ...operation.durations },
          marks: { ...operation.marks },
          metadata: { ...operation.metadata }
        }));
      },
      records
    };
  }

  return window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__;
}

function syncDocumentSwitchPerformanceDom(
  operation: DocumentSwitchPerformanceOperation
): void {
  if (typeof document === "undefined") {
    return;
  }
  pendingDomSyncOperation = operation;
  if (domSyncScheduled) {
    return;
  }
  domSyncScheduled = true;
  queueMicrotask(() => {
    domSyncScheduled = false;
    const pendingOperation = pendingDomSyncOperation;
    pendingDomSyncOperation = null;
    if (!pendingOperation || typeof document === "undefined") {
      return;
    }
    document.documentElement.setAttribute(
      "data-patchmark-switch-performance",
      JSON.stringify(pendingOperation)
    );
  });
}

function isDocumentSwitchPerformanceEnabled(): boolean {
  const query = new URLSearchParams(window.location.search);
  return (
    query.get("patchmarkPerformance") === "1" ||
    query.get("patchmarkSwitchPerformance") === "1"
  );
}
