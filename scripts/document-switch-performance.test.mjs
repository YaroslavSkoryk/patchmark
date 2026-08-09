import assert from "node:assert/strict";
import {
  finishDocumentSwitchPerformanceOperation,
  getLatestDocumentSwitchPerformanceOperationId,
  incrementDocumentSwitchPerformanceCounter,
  markDocumentSwitchPerformance,
  recordDocumentSwitchPerformanceDuration,
  startDocumentSwitchPerformanceOperation,
  updateDocumentSwitchPerformanceMetadata
} from "../lib/performance/document-switch-performance.ts";

globalThis.window = createWindow("?patchmarkSwitchPerformance=1");

const operationId = startDocumentSwitchPerformanceOperation({
  cache: "not_used",
  projectId: "prj_performance",
  sourceDocumentId: "doc_source",
  targetDocumentId: "doc_target",
  trigger: "navigator"
});

assert.ok(operationId);
assert.equal(getLatestDocumentSwitchPerformanceOperationId(), operationId);
markDocumentSwitchPerformance(operationId, "current_editor_flushed");
markDocumentSwitchPerformance(operationId, "current_editor_flushed");
markDocumentSwitchPerformance(operationId, "first_target_render");
recordDocumentSwitchPerformanceDuration(operationId, "read_target_markdown", 4);
recordDocumentSwitchPerformanceDuration(operationId, "read_target_markdown", 6);
recordDocumentSwitchPerformanceDuration(operationId, "read_target_markdown", -20);
incrementDocumentSwitchPerformanceCounter(operationId, "bytes_read", 100);
incrementDocumentSwitchPerformanceCounter(operationId, "bytes_read", 25);
updateDocumentSwitchPerformanceMetadata(operationId, {
  comments: 31,
  patches: 59,
  saveStatus: "unchanged",
  versions: 49
});
finishDocumentSwitchPerformanceOperation(operationId);
finishDocumentSwitchPerformanceOperation(operationId);

const api = window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__;
assert.ok(api?.enabled);
const records = api.getRecords();
assert.equal(records.length, 1);
assert.equal(records[0].durations.read_target_markdown, 10);
assert.equal(records[0].counters.bytes_read, 125);
assert.equal(records[0].metadata.comments, 31);
assert.equal(records[0].metadata.cache, "not_used");
assert.ok(records[0].marks.first_target_render >= 0);
assert.ok(records[0].marks.secondary_work_complete >= 0);
assert.ok(records[0].finishedAt >= records[0].startedAt);

records[0].counters.bytes_read = 0;
assert.equal(api.getRecords()[0].counters.bytes_read, 125);

api.clear();
assert.equal(api.getRecords().length, 0);

for (let index = 0; index < 205; index += 1) {
  startDocumentSwitchPerformanceOperation({
    projectId: "prj_performance",
    sourceDocumentId: `doc_${index}`,
    targetDocumentId: `doc_${index + 1}`,
    trigger: "navigator"
  });
}

assert.equal(api.getRecords().length, 200);
assert.equal(api.getRecords().at(-1).metadata.targetDocumentId, "doc_205");

globalThis.window = createWindow("");
assert.equal(
  startDocumentSwitchPerformanceOperation({
    projectId: "prj_disabled",
    sourceDocumentId: "doc_a",
    targetDocumentId: "doc_b",
    trigger: "bookmark"
  }),
  null
);
assert.equal(window.__PATCHMARK_DOCUMENT_SWITCH_PERFORMANCE__, undefined);

globalThis.window = createWindow("?patchmarkPerformance=1");
assert.ok(
  startDocumentSwitchPerformanceOperation({
    projectId: "prj_general",
    sourceDocumentId: "doc_a",
    targetDocumentId: "doc_b",
    trigger: "bookmark"
  })
);

console.log("Document-switch performance instrumentation tests passed.");

function createWindow(search) {
  return {
    location: { search }
  };
}
