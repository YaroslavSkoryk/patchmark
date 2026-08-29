import type * as AgentExchangeQualification from "./qualification-loader.ts";
import { resolveBuildAgentExchangeFeatureState } from "./feature-state.ts";

export const agentExchangeDisabled = Object.freeze({
  mode: "disabled" as const,
  outcome: "disabled" as const
});

export type AgentExchangeQualificationDispatch =
  | typeof agentExchangeDisabled
  | Promise<typeof AgentExchangeQualification>;

export function loadAgentExchangeQualification(
  injectedSignal: unknown
): AgentExchangeQualificationDispatch {
  const state = resolveBuildAgentExchangeFeatureState(injectedSignal);
  if (state.mode === "disabled") return agentExchangeDisabled;
  return import("./qualification-loader.ts");
}
