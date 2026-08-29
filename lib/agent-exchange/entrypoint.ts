import type * as AgentExchangeQualification from "./qualification-loader.ts";
import {
  resolveAgentExchangeProductFeatureState,
  resolveBuildAgentExchangeFeatureState
} from "./feature-state.ts";

export const agentExchangeDisabled = Object.freeze({
  mode: "disabled" as const,
  outcome: "disabled" as const
});

export type AgentExchangeQualificationDispatch =
  | typeof agentExchangeDisabled
  | Promise<typeof AgentExchangeQualification>;

export type AgentExchangeProductFeatureState = Readonly<{
  mode: "development_qualification" | "disabled" | "released";
}>;

export function getAgentExchangeProductQualificationState(
  injectedState: unknown
): AgentExchangeProductFeatureState {
  return resolveAgentExchangeProductFeatureState(injectedState);
}

export function loadAgentExchangeProductQualification(
  injectedState: unknown
): AgentExchangeQualificationDispatch {
  const state = resolveAgentExchangeProductFeatureState(injectedState);
  if (state.mode === "disabled") return agentExchangeDisabled;
  return import("./qualification-loader.ts");
}

export function loadAgentExchangeQualification(
  injectedSignal: unknown
): AgentExchangeQualificationDispatch {
  const state = resolveBuildAgentExchangeFeatureState(injectedSignal);
  if (state.mode === "disabled") return agentExchangeDisabled;
  return import("./qualification-loader.ts");
}
