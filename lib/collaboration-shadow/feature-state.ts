import {
  developmentQualificationSignal,
  resolveCheckedInProductFeatureRelease
} from "../release/product-release-state.ts";

export const collaborationShadowModes = [
  "disabled",
  "development_shadow"
] as const;

export type CollaborationShadowMode =
  (typeof collaborationShadowModes)[number];

export type CollaborationShadowFeatureEnvironment = Readonly<{
  runtime: "development" | "test" | "production" | "unknown";
  enable_signal: unknown;
  conflicting_signal?: unknown;
}>;

const disabledState = Object.freeze({
  mode: "disabled" as const,
  reason: "disabled_by_default" as const
});

export type CollaborationShadowFeatureState =
  | typeof disabledState
  | Readonly<{
      mode: "development_shadow";
      reason: "explicit_development_or_test_enable";
    }>;

export type CollaborationProductFeatureState =
  | CollaborationShadowFeatureState
  | Readonly<{
      mode: "released";
      reason: "reviewed_source_release";
    }>;

export function resolveCollaborationShadowFeatureState(
  environment: CollaborationShadowFeatureEnvironment
): CollaborationShadowFeatureState {
  const keys = environment && typeof environment === "object"
    ? Object.keys(environment)
    : [];
  if (
    !environment ||
    keys.some((key) => !["runtime", "enable_signal", "conflicting_signal"].includes(key)) ||
    Object.prototype.hasOwnProperty.call(environment, "conflicting_signal") ||
    (environment.runtime !== "development" &&
      environment.runtime !== "test") ||
    environment.enable_signal !== "development_shadow"
  ) {
    return disabledState;
  }
  return Object.freeze({
    mode: "development_shadow" as const,
    reason: "explicit_development_or_test_enable" as const
  });
}

export function getBuildCollaborationShadowFeatureState(): CollaborationShadowFeatureState {
  const runtime = normalizeRuntime(process.env.NODE_ENV);
  return resolveCollaborationShadowFeatureState({
    runtime,
    enable_signal: process.env.NEXT_PUBLIC_PATCHMARK_COLLABORATION_SHADOW
  });
}

/**
 * Product qualification uses the same fail-closed state machine as the shadow
 * seam, but its enable signal is injected by trusted application code rather
 * than read from a URL, browser store, cookie, or public environment variable.
 */
export function resolveInjectedCollaborationProductFeatureState(
  enableSignal: unknown
): CollaborationProductFeatureState {
  return resolveCollaborationProductFeatureStateForRuntime(
    normalizeRuntime(process.env.NODE_ENV),
    enableSignal
  );
}

export function resolveCollaborationProductFeatureStateForRuntime(
  runtime: CollaborationShadowFeatureEnvironment["runtime"],
  enableSignal: unknown
): CollaborationProductFeatureState {
  const resolution = resolveCheckedInProductFeatureRelease(
    "human_collaboration",
    {
      runtime,
      qualification_signal:
        enableSignal === "development_shadow"
          ? developmentQualificationSignal
          : enableSignal
    }
  );
  if (resolution.mode === "released") {
    return Object.freeze({
      mode: "released" as const,
      reason: "reviewed_source_release" as const
    });
  }
  if (resolution.mode === "development_qualification") {
    return Object.freeze({
      mode: "development_shadow" as const,
      reason: "explicit_development_or_test_enable" as const
    });
  }
  return disabledState;
}

function normalizeRuntime(value: unknown): CollaborationShadowFeatureEnvironment["runtime"] {
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  return "unknown";
}
