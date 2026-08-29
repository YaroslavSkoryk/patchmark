import type { ComponentProps } from "react";
import type { AgentExchangeActions } from "../components/agent-exchange/agent-exchange-actions.tsx";
import type { AgentExchangeOperationPhase } from "../lib/agent-exchange/contracts.ts";
import type { AgentExchangeOperation } from "../lib/agent-exchange/operation-controller.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type WaitingIsTyped = Expect<
  Equal<Extract<AgentExchangeOperationPhase, "waiting">, "waiting">
>;
type OperationSubscription = Expect<
  Equal<
    Extract<keyof AgentExchangeOperation<unknown>, "subscribe">,
    "subscribe"
  >
>;
type ProductActionsHaveNoAuthority = Expect<
  Equal<
    Extract<
      keyof ComponentProps<typeof AgentExchangeActions>,
      "acceptPatch" | "applyMarkdown" | "project" | "responseBytes"
    >,
    never
  >
>;

export type AgentExchangeSlice2TypeEvidence = Readonly<{
  no_product_authority: ProductActionsHaveNoAuthority;
  operation_subscription: OperationSubscription;
  waiting_phase: WaitingIsTyped;
}>;
