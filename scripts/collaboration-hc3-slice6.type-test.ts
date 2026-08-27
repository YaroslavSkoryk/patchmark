import type {
  Hc3ProductCapabilityName,
  Hc3ProductCapabilityState
} from "../lib/collaboration/hc3/product-capabilities.ts";

type Slice6EvidenceStatus = "pass" | "conditional" | "blocked" | "not_exercised";
type Slice6EvidenceMode = "automated" | "manual";

type Slice6CapabilityEvidence = Readonly<{
  authority: "none";
  capability: Hc3ProductCapabilityName;
  browser_state: Hc3ProductCapabilityState;
  evidence_mode: Slice6EvidenceMode;
  status: Slice6EvidenceStatus;
  nonextractable_fallback: false;
}>;

const keyPersistenceEvidence = {
  authority: "none",
  capability: "non_extractable_key_persistence",
  browser_state: "supported",
  evidence_mode: "automated",
  status: "pass",
  nonextractable_fallback: false
} as const satisfies Slice6CapabilityEvidence;

// @ts-expect-error Qualification records can never carry project authority.
const forbiddenAuthority: Slice6CapabilityEvidence = { ...keyPersistenceEvidence, authority: "hc2_hc3" };
// @ts-expect-error Extractable custody is not a compatibility fallback.
const forbiddenFallback: Slice6CapabilityEvidence = { ...keyPersistenceEvidence, nonextractable_fallback: true };
// @ts-expect-error Missing evidence cannot be represented as an invented status.
const forbiddenStatus: Slice6CapabilityEvidence = { ...keyPersistenceEvidence, status: "assumed_pass" };

void forbiddenAuthority;
void forbiddenFallback;
void forbiddenStatus;
