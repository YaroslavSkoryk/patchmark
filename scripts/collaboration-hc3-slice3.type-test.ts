import type { ControlEventRecord } from "../lib/collaboration/control.ts";
import type {
  Hc3AuthenticatedConnectionRecord,
  Hc3DirectDataChannelPort,
  Hc3DirectWorkflowStatus,
  Hc3V3PreparedDirectBundle
} from "../lib/collaboration/hc3/index.ts";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsNotAssignable<From, To> = IsAssignable<From, To> extends true ? false : true;

type AuthRecordHasNoAuthority = Assert<IsAssignable<Hc3AuthenticatedConnectionRecord["authority"], "none">>;
type WorkflowHasNoAuthority = Assert<IsAssignable<Hc3DirectWorkflowStatus["authority"], "none">>;
type AuthRecordCannotBecomeControl = Assert<IsNotAssignable<Hc3AuthenticatedConnectionRecord, ControlEventRecord>>;
type V3BytesRemainBytes = Assert<IsAssignable<Hc3V3PreparedDirectBundle["exact_v3_bundle_bytes"], Uint8Array>>;

declare const channel: Hc3DirectDataChannelPort;
declare const rawText: string;
declare const rawBytes: Uint8Array;

// @ts-expect-error The narrow channel accepts binary ArrayBuffer values only.
channel.send(rawText);
// @ts-expect-error Raw bytes are not an authenticated connection record.
const forgedConnection: Hc3AuthenticatedConnectionRecord = rawBytes;
// @ts-expect-error A direct workflow status cannot become an authority-bearing control event.
const forgedControl: ControlEventRecord = null as unknown as Hc3DirectWorkflowStatus;

void ([
  null as unknown as AuthRecordHasNoAuthority,
  null as unknown as WorkflowHasNoAuthority,
  null as unknown as AuthRecordCannotBecomeControl,
  null as unknown as V3BytesRemainBytes,
  forgedConnection,
  forgedControl
]);
