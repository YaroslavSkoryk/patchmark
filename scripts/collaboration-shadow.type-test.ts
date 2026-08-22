import type {
  CollaborationShadowDisabledSentinel,
  CollaborationShadowMutationReceipt,
  ShadowLegacySharedState
} from "../lib/collaboration-shadow/contracts.ts";
import type {
  DevelopmentShadowIdentityAllocator,
  InitializeDevelopmentShadowInput
} from "../lib/collaboration-shadow/shadow-implementation.ts";

declare const disabled: CollaborationShadowDisabledSentinel;
declare const receipt: CollaborationShadowMutationReceipt;
declare const shared: ShadowLegacySharedState;
declare const allocator: DevelopmentShadowIdentityAllocator;
declare const initialization: InitializeDevelopmentShadowInput;

void disabled;
void receipt;
void shared;
void allocator;
void initialization;

// @ts-expect-error disabled sentinel cannot become an executed shadow result
const invalidExecuted: CollaborationShadowMutationReceipt = disabled;
// @ts-expect-error a private path is not part of normalized shared state
const privateState: ShadowLegacySharedState = { ...shared, absolute_path: "/private/source.md" };
// @ts-expect-error identity allocation requires the explicit secure capability marker
const weakAllocator: DevelopmentShadowIdentityAllocator = { allocate: () => "legacy-1" };
// @ts-expect-error a mutation receipt is not an initialization request
const invalidInitialization: InitializeDevelopmentShadowInput = receipt;

void invalidExecuted;
void privateState;
void weakAllocator;
void invalidInitialization;
