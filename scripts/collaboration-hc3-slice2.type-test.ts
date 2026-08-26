import type { ControlEventRecord } from "../lib/collaboration/control.ts";
import type { InvitationHandoffCore } from "../lib/collaboration/hc2/enrollment-contracts.ts";
import type {
  Hc3ArtifactText,
  Hc3BrowserPorts,
  Hc3PortResult,
  Hc3SafePreview,
  Hc3WorkflowCommandResult,
  Hc3WorkflowEvidence,
  Hc3WorkflowStatus
} from "../lib/collaboration/hc3/index.ts";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsNotAssignable<From, To> = IsAssignable<From, To> extends true ? false : true;

type StatusAuthorityIsNone = Assert<IsAssignable<Hc3WorkflowStatus["authority"], "none">>;
type PreviewAuthorityIsNone = Assert<IsAssignable<Hc3SafePreview["authority"], "none">>;
type EvidenceAuthorityIsNone = Assert<IsAssignable<Hc3WorkflowEvidence["authority"], "none">>;
type ResultCannotBeControlEvent = Assert<IsNotAssignable<Hc3WorkflowCommandResult, ControlEventRecord>>;
type PreviewCannotBeInvitation = Assert<IsNotAssignable<Hc3SafePreview, InvitationHandoffCore>>;

declare const rawText: string;
declare const rawPortResult: Promise<Hc3PortResult<unknown>>;
declare const ports: Hc3BrowserPorts;
declare const preview: Hc3SafePreview;

// @ts-expect-error Arbitrary text cannot cross a clipboard port as canonical HC-3 text.
ports.clipboard.writeText({ text: rawText });
// @ts-expect-error A preview cannot become an authoritative HC-1 control event.
const forgedControl: ControlEventRecord = preview;
// @ts-expect-error Port results cannot return authority-bearing control records.
const authorityFromPort: Promise<ControlEventRecord> = rawPortResult;
// @ts-expect-error An unbranded string cannot become canonical artifact text.
const forgedArtifactText: Hc3ArtifactText = rawText;

void ([
  null as unknown as StatusAuthorityIsNone,
  null as unknown as PreviewAuthorityIsNone,
  null as unknown as EvidenceAuthorityIsNone,
  null as unknown as ResultCannotBeControlEvent,
  null as unknown as PreviewCannotBeInvitation,
  forgedControl,
  authorityFromPort,
  forgedArtifactText
]);
