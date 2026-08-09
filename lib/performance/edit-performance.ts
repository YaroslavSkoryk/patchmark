export type EditPerformanceMutationSource =
  | "composition"
  | "cut"
  | "formatter"
  | "human_rewrite"
  | "manual_source"
  | "manual_visual"
  | "move"
  | "paste"
  | "patch_apply"
  | "programmatic_sync"
  | "project_load"
  | "redo"
  | "snapshot_restore"
  | "undo";

export type EditPerformanceOperation = {
  counters: Record<string, number>;
  durations: Record<string, number>;
  id: string;
  marks: Record<string, number>;
  metadata: {
    affectedCommentCount?: number;
    broad?: boolean;
    confidence?: "high" | "low" | "medium";
    hunkCount?: number;
    newMarkdownLength: number;
    oldMarkdownLength: number;
    recoveryRequiredCount?: number;
    source: EditPerformanceMutationSource;
    transformedCommentCount?: number;
  };
  startedAt: number;
};

type EditPerformanceApi = {
  clear: () => void;
  enabled: true;
  getRecords: () => EditPerformanceOperation[];
  records: EditPerformanceOperation[];
};

declare global {
  interface Window {
    __PATCHMARK_EDIT_PERFORMANCE__?: EditPerformanceApi;
  }
}

const MAX_RECORDED_OPERATIONS = 200;
let operationCounter = 0;

export function startEditPerformanceOperation({
  newMarkdownLength,
  oldMarkdownLength,
  source
}: {
  newMarkdownLength: number;
  oldMarkdownLength: number;
  source: EditPerformanceMutationSource;
}): string | null {
  const api = getEditPerformanceApi();

  if (!api) {
    return null;
  }

  const startedAt = performance.now();
  const id = `edit-${Date.now()}-${operationCounter += 1}`;
  const operation: EditPerformanceOperation = {
    counters: {},
    durations: {},
    id,
    marks: {
      input_received: 0
    },
    metadata: {
      newMarkdownLength,
      oldMarkdownLength,
      source
    },
    startedAt
  };

  api.records.push(operation);

  if (api.records.length > MAX_RECORDED_OPERATIONS) {
    api.records.splice(0, api.records.length - MAX_RECORDED_OPERATIONS);
  }

  return id;
}

export function markEditPerformanceOperation(
  operationId: string | null | undefined,
  name: string
): void {
  const operation = getEditPerformanceOperation(operationId);

  if (operation && !(name in operation.marks)) {
    operation.marks[name] = performance.now() - operation.startedAt;
  }
}

export function markLatestEditPerformanceOperation(
  operationId: string | null | undefined,
  name: string
): void {
  const operation = getEditPerformanceOperation(operationId);

  if (operation) {
    operation.marks[name] = performance.now() - operation.startedAt;
  }
}

export function recordEditPerformanceDuration(
  operationId: string | null | undefined,
  name: string,
  duration: number
): void {
  const operation = getEditPerformanceOperation(operationId);

  if (operation) {
    operation.durations[name] =
      (operation.durations[name] ?? 0) + Math.max(0, duration);
  }
}

export function incrementEditPerformanceCounter(
  operationId: string | null | undefined,
  name: string,
  amount = 1
): void {
  const operation = getEditPerformanceOperation(operationId);

  if (operation) {
    operation.counters[name] = (operation.counters[name] ?? 0) + amount;
  }
}

export function updateEditPerformanceMetadata(
  operationId: string | null | undefined,
  metadata: Partial<EditPerformanceOperation["metadata"]>
): void {
  const operation = getEditPerformanceOperation(operationId);

  if (operation) {
    Object.assign(operation.metadata, metadata);
  }
}

export function getLatestEditPerformanceOperationId(): string | null {
  const records = getEditPerformanceApi()?.records;
  return records?.at(-1)?.id ?? null;
}

function getEditPerformanceOperation(
  operationId: string | null | undefined
): EditPerformanceOperation | null {
  if (!operationId) {
    return null;
  }

  return (
    getEditPerformanceApi()?.records.find(
      (operation) => operation.id === operationId
    ) ?? null
  );
}

function getEditPerformanceApi(): EditPerformanceApi | null {
  if (typeof window === "undefined" || !isEditPerformanceEnabled()) {
    return null;
  }

  if (!window.__PATCHMARK_EDIT_PERFORMANCE__) {
    const records: EditPerformanceOperation[] = [];
    window.__PATCHMARK_EDIT_PERFORMANCE__ = {
      clear() {
        records.splice(0, records.length);
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

  return window.__PATCHMARK_EDIT_PERFORMANCE__;
}

function isEditPerformanceEnabled(): boolean {
  return (
    new URLSearchParams(window.location.search).get("patchmarkPerformance") ===
    "1"
  );
}
