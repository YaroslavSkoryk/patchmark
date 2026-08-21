import type {
  CollaborationProjectorInput,
  CollaborationProjection,
  MarkdownMergeCandidateInput
} from "../lib/collaboration/index.ts";

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type HasKey<T, TKey extends PropertyKey> = TKey extends keyof T ? true : false;

export type ProjectorContractAssertions = readonly [
  AssertFalse<HasKey<CollaborationProjectorInput, "putRevision">>,
  AssertFalse<HasKey<CollaborationProjectorInput, "append_event">>,
  AssertFalse<HasKey<CollaborationProjectorInput, "allocate_sequence">>,
  AssertFalse<HasKey<CollaborationProjectorInput, "sign">>,
  AssertFalse<HasKey<CollaborationProjectorInput, "set_quarantine">>,
  AssertFalse<HasKey<CollaborationProjectorInput, "materializeMarkdownBlob">>,
  AssertFalse<HasKey<MarkdownMergeCandidateInput, "write">>,
  AssertFalse<HasKey<MarkdownMergeCandidateInput, "store">>,
  AssertFalse<HasKey<CollaborationProjection, "active_document">>,
  AssertFalse<HasKey<CollaborationProjection, "selection">>,
  AssertFalse<HasKey<CollaborationProjection, "editor_mode">>,
  AssertFalse<HasKey<CollaborationProjection, "reading_bookmark">>,
  AssertFalse<HasKey<CollaborationProjection, "file_handle">>,
  AssertFalse<HasKey<CollaborationProjection, "recovery_draft">>,
  Assert<HasKey<CollaborationProjectorInput, "read_event">>,
  Assert<HasKey<CollaborationProjectorInput, "read_revision">>
];

declare const projectorInput: CollaborationProjectorInput;
declare const mergeInput: MarkdownMergeCandidateInput;

// @ts-expect-error The read-only projector input exposes no append authority.
void projectorInput.append_event;
// @ts-expect-error The read-only projector input exposes no signing authority.
void projectorInput.sign;
// @ts-expect-error The pure merge input exposes no immutable-object writer.
void mergeInput.putRevision;

export {};
