import {
  developmentQualificationSignal,
  resolveCheckedInProductFeatureRelease
} from "../release/product-release-state.ts";

export type AgentExchangeFeatureState = Readonly<{
  mode: "development_qualification" | "disabled" | "released";
}>;

export function resolveAgentExchangeFeatureState(
  runtime: "development" | "test" | "production" | "unknown",
  injectedSignal: unknown
): AgentExchangeFeatureState {
  const resolution = resolveCheckedInProductFeatureRelease("agent_exchange", {
    runtime,
    qualification_signal:
      injectedSignal === developmentQualificationSignal
        ? developmentQualificationSignal
        : undefined
  });
  return Object.freeze({ mode: resolution.mode });
}

export function resolveBuildAgentExchangeFeatureState(
  injectedSignal: unknown
): AgentExchangeFeatureState {
  const runtime =
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test" ||
    process.env.NODE_ENV === "production"
      ? process.env.NODE_ENV
      : "unknown";
  return resolveAgentExchangeFeatureState(runtime, injectedSignal);
}
