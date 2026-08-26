import type { ControlEventRecord } from "../lib/collaboration/control.ts";
import type { InvitationHandoffCore } from "../lib/collaboration/hc2/enrollment-contracts.ts";
import type {
  Hc3ArtifactText,
  Hc3ConnectionAnswerCarrier,
  Hc3ConnectionOfferCarrier,
  Hc3ConnectionOfferCommitmentPreimage,
  Hc3HandoffCarrier
} from "../lib/collaboration/hc3/index.ts";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsNotAssignable<From, To> = IsAssignable<From, To> extends true ? false : true;

type CarrierAuthorityIsNone = Assert<IsAssignable<Hc3HandoffCarrier["authority"], "none">>;
type CarrierCannotBeControlAuthority = Assert<IsNotAssignable<Hc3HandoffCarrier, ControlEventRecord>>;
type OfferCannotBeAnswer = Assert<IsNotAssignable<Hc3ConnectionOfferCarrier, Hc3ConnectionAnswerCarrier>>;
type HandoffCannotBeCarrier = Assert<IsNotAssignable<InvitationHandoffCore, Hc3HandoffCarrier<"invitation_handoff">>>;

declare const rawBytes: Uint8Array;
declare const rawText: string;
declare const invitationHandoff: InvitationHandoffCore;
declare const invitationCarrier: Hc3HandoffCarrier<"invitation_handoff">;

// @ts-expect-error Raw bytes cannot become a domain-separated connection-offer commitment preimage.
const forgedPreimage: Hc3ConnectionOfferCommitmentPreimage = rawBytes;
// @ts-expect-error Arbitrary text cannot become canonical HC-3 artifact text.
const forgedText: Hc3ArtifactText = rawText;
// @ts-expect-error An existing HC-2 invitation handoff is payload evidence, not an HC-3 carrier.
const forgedCarrier: Hc3HandoffCarrier<"invitation_handoff"> = invitationHandoff;
// @ts-expect-error Carrier bytes and fields cannot satisfy an HC-1 authoritative control event.
const forgedAuthority: ControlEventRecord = invitationCarrier;
// @ts-expect-error Artifact-family brands prevent invitation/enrollment substitution.
const wrongFamily: Hc3HandoffCarrier<"enrollment_request"> = invitationCarrier;

void ([
  null as unknown as CarrierAuthorityIsNone,
  null as unknown as CarrierCannotBeControlAuthority,
  null as unknown as OfferCannotBeAnswer,
  null as unknown as HandoffCannotBeCarrier,
  forgedPreimage,
  forgedText,
  forgedCarrier,
  forgedAuthority,
  wrongFamily
]);
