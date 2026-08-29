# Agent Exchange AE-1 Slice 1

Status: provider-neutral foundation qualified; production release remains disabled.

## Purpose and scope

Agent Exchange removes transport friction from Patchmark's existing manual
comment/reply/patch workflow. It does not create a second review protocol. The
manual `patchmark.comment_export` request inside the saved Review Batch prompt
and the existing `patchmark.comment_reply_import` response remain canonical.
Agent output remains untrusted proposed work. Import may add replies and pending
patch proposals, but only the existing explicit human Accept Patch action may
change Markdown. Reject Patch remains an explicit human action, and neither an
agent nor a connector can resolve comments.

AE-1 Slice 1 connects to no real AI provider. It does not implement Codex
Server integration or Claude Code integration, and it adds no Send to agent UI.

## Existing manual exchange audit

The authoritative request path begins in `DocumentEditor`:

1. `getFocusedCommentsForExport` selects open, non-trashed focused comments;
   the Guided Review path instead uses `deriveReviewQueue` and
   `validateGuidedReviewSessionSelection`.
2. `buildFocusedCommentsPromptPreview` creates the existing export object and
   prompt. `createTrackedReviewBatchExport` validates the selection, assigns or
   accepts the Review Batch ID, captures project/document identity, records
   ordered comment IDs and comment fingerprints, hashes the document and
   prompt, writes the exact document snapshot and context pack, verifies both,
   then commits the Review Batch record.
3. `readExactReviewBatchPrompt` re-reads the committed prompt and verifies its
   byte length and SHA-256 before the manual clipboard path exposes it.
   `readExactReviewBatchPromptBytes` is the shared UTF-8 byte boundary used by
   Prepared Exchange.

The authoritative response path is now the extracted
`importProjectCommentReplyResponse` / `importProjectCommentReplyResponseBytes`
boundary. The manual import form invokes it directly. The boundary reuses:

- `parsePatchmarkCommentReplyImport` for JSON/fence parsing, protocol schema,
  citation cleanup, source metadata checks, and dependency-graph validation;
- `associateReviewBatchResponse` for project, document, Review Batch, active
  lifecycle, duplicate, and replay association;
- `validateExactReviewBatchResponseComments` for exported-comment scope;
- `readExactReviewBatchDocumentSnapshot` for the exact source revision used by
  structural and dependency validation;
- `validateAtomicTablePatchImport` and
  `validateImportedPatchDependencySimulation` for patch planning;
- `analyzeImportedReviewBatchResponse` and
  `createRespondedReviewBatchRecords` for response lineage and lifecycle;
- `writeProjectImport` plus `saveProjectState(... rollbackOnFailure: true)` for
  import evidence and atomic comments/patches/Review Batch persistence.

Imported replies and patches retain `source_import_id`; patches also retain
response-local `source_patch_key`, dependency IDs, and their comment ID. Exact
tracked replay is fail-closed: once a Review Batch is responded, both an exact
duplicate and a conflicting alternative are rejected before mutation. Legacy
responses without Review Batch identity retain the pre-existing permissive
manual behavior and are not given new portable duplicate semantics.

Stale patch text is not written during import. Imported proposals remain
pending; the existing target-resolution and exact-original-text checks run when
the user explicitly accepts one. Rejection changes only proposal/review state.

The current manual response surface is a pasted JSON form, not a response-file
picker. The current request surface copies the verified saved prompt; it does
not download a separate request artifact. The Guided Review prompt estimator
warns above 20,000 estimated tokens. The legacy manual response form has no
separate byte or object-count ceiling. Agent Exchange adds an operation-local
8 MiB default response ceiling (injectably smaller for qualification). A
configured response ceiling may not exceed 64 MiB. This does not change the
portable response.

## Prepared Exchange

`prepareAgentExchange` accepts an already-exported active Review Batch and reads
its exact verified saved prompt bytes once. A `PreparedAgentExchange` retains:

- private exact request bytes exposed only through copy operations;
- request byte length and SHA-256 commitment;
- project ID and document-scoped export identity;
- Review Batch ID and existing batch type/source;
- expected `patchmark.comment_reply_import` protocol version 2;
- response byte ceiling;
- `authority: "none"`.

The digest is a binding commitment, not a secret or authorization token. A
Prepared Exchange is transient operation state and is never stored in project
metadata. Connector failure, unavailability, cancellation, or ownership
invalidation does not consume it. `copyPreparedExchangeForManualDelivery` and
`operation.copy_manual_fallback_bytes()` return copies of those same prepared
bytes and never regenerate the export or Review Batch identity.

## Connector and operation boundary

`AgentExchangeConnector` exposes only a frozen name/version descriptor,
availability check, one asynchronous submission, `AbortSignal`, and cleanup.
Each connector instance may be bound to exactly one operation; the controller
rejects instance reuse.
Submission contains copied request bytes plus non-authoritative binding
metadata. The connector receives no project/document store, editor ref,
comment/reply/patch mutation API, patch acceptance/rejection API, file handle,
provider credential store, or human-collaboration custody. Compile-time tests
lock this structural surface.

The operation binding covers operation ID, connector ID/version, exact request
digest and length, project ID, document scope, Review Batch ID, expected
response protocol/version, response ceiling, and `authority: "none"`. The
connector must return the same binding plus actual response length and response
protocol/version. The controller copies response bytes and rejects mismatched
identity, scope, digest, lengths, protocol metadata, or size before invoking the
importer. The importer then independently validates the portable response.

Operation IDs come only from an injected factory. The controller rejects empty
or reused IDs and performs no ambient random generation. Repeated `execute()`
calls share one Promise and cannot submit or import twice.

The controller owns one active operation generation. Starting a newer operation
invalidates the older one. Cancellation aborts transport and makes any late
response ineligible to import while retaining manual-fallback bytes. Project or
document switching explicitly invalidates a mismatched operation. The importer
receives a commit-time ownership assertion that executes inside Patchmark's
serialized project commit queue and again around awaited file installation.
Ownership loss raises inside the rollback boundary, closing the asynchronous
gap between response receipt and authoritative persistence.

## Qualification connector and evidence

`QualificationAgentExchangeConnector` exists under `scripts/lib` only. It
copies submitted and returned byte arrays and supports immediate completion,
externally controlled deferred completion, cancellation-aware or deliberately
late completion, unavailable state, thrown interruption, arbitrary malformed
or oversized bytes, and binding transformation for substitution/hostile cases.
It starts no network request, worker, background timer, or durable store.

Focused qualification uses copied deterministic multi-document fixtures and
the production project readers/writers. It proves exact manual/prepared/
connector/fallback byte equality; connector-buffer mutation isolation; one
reply plus two pending patches; byte-identical Markdown after import; explicit
accept/reject authority; persistence and reopen; cancellation; project switch;
stale operation; invalid portable and transport bindings; over-size and length
failure; exact replay and conflict rejection; and manual/automated semantic
convergence.

Errors contain bounded categories and lengths only; neither Agent Exchange nor
the qualification connector logs full requests, responses, document source,
comments, patch text, credentials, or file paths. Executable-looking response
text remains inert data handled by the existing parser and project stores.

## Release isolation and deferred work

The sole checked-in release authority remains:

```ts
{
  human_collaboration: false,
  agent_exchange: false
}
```

Agent Exchange and Human Collaboration resolve independently. The Agent
Exchange entrypoint returns a synchronous disabled sentinel in production
before its dynamic qualification import. The production webpack configuration
removes the disabled qualification-loader edge. No product component imports
the Agent Exchange boundary, no connector is constructed, and no Agent Exchange
storage, crypto, randomness, timer, worker, or network work occurs in the
ordinary production path. The deterministic connector is outside production
source. Human Collaboration remains frozen and production-disabled.

AE-1 Slice 2 should integrate this boundary into the actual Comments/Review UI:
the Send to agent action, sending/waiting/result feedback, manual-fallback and
cancel controls, review navigation, focus/live-region behavior, and responsive
qualification. AE-2 should investigate and implement the real Codex local
connector path only after that provider-neutral Patchmark workflow is qualified.

Any future local bridge requires a separate review of loopback exposure, origin
validation, explicit pairing, CSRF, connector authentication, process lifecycle,
port discovery, local credential custody, filesystem/tool authority, upgrade
compatibility, and installer/uninstaller behavior. None is prematurely solved
in Slice 1.
