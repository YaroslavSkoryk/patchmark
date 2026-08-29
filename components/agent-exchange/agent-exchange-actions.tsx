"use client";

import { useEffect, useRef } from "react";
import styles from "./agent-exchange-actions.module.css";

export type AgentExchangeProductPhase =
  | "idle"
  | "preparing"
  | "sending"
  | "waiting"
  | "importing"
  | "ready"
  | "failed"
  | "cancelled";

export type AgentExchangeProductFailure =
  | "import"
  | "stale"
  | "unavailable";

export type AgentExchangeProductResult = Readonly<{
  patches: number;
  replies: number;
}>;

export function AgentExchangeActions({
  canFallback,
  disabled,
  failure,
  mode = "full",
  onCancel,
  onFallback,
  onReview,
  onSend,
  phase,
  result
}: {
  canFallback: boolean;
  disabled: boolean;
  failure: AgentExchangeProductFailure | null;
  mode?: "full" | "send_only";
  onCancel(): void;
  onFallback(): void;
  onReview(): void;
  onSend(): void;
  phase: AgentExchangeProductPhase;
  result: AgentExchangeProductResult | null;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  const previousPhaseRef = useRef(phase);

  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (
      (previous === "idle" || previous === "preparing") &&
      phase === "sending"
    ) {
      cancelRef.current?.focus();
    } else if (previous !== "cancelled" && phase === "cancelled") {
      fallbackRef.current?.focus();
    }
  }, [phase]);

  if (mode === "send_only") {
    return (
      <span className={styles.compact} data-testid="agent-exchange-proposal-action">
        <button disabled={disabled || phase !== "idle"} onClick={onSend} type="button">
          Send to agent
        </button>
      </span>
    );
  }

  const status = getStatus(phase, failure, result);
  const active =
    phase === "sending" ||
    phase === "waiting" ||
    phase === "importing";

  return (
    <section
      aria-label="Agent review delivery"
      className={styles.surface}
      data-agent-exchange-phase={phase}
      data-testid="agent-exchange-actions"
    >
      <div aria-atomic="true" aria-live="polite" className={styles.status} role="status">
        <strong>{status.heading}</strong>
        {status.detail ? <span>{status.detail}</span> : null}
      </div>
      <div className={styles.actions}>
        {phase === "idle" ? (
          <button disabled={disabled} onClick={onSend} type="button">
            Send to agent
          </button>
        ) : null}
        {active ? (
          <button onClick={onCancel} ref={cancelRef} type="button">
            Cancel
          </button>
        ) : null}
        {phase === "ready" ? (
          <button onClick={onReview} type="button">
            Review replies and suggestions
          </button>
        ) : null}
        {(phase === "failed" || phase === "cancelled") && canFallback ? (
          <button onClick={onFallback} ref={fallbackRef} type="button">
            Use manual export instead
          </button>
        ) : null}
      </div>
    </section>
  );
}

function getStatus(
  phase: AgentExchangeProductPhase,
  failure: AgentExchangeProductFailure | null,
  result: AgentExchangeProductResult | null
): Readonly<{ heading: string; detail: string | null }> {
  switch (phase) {
    case "idle":
      return {
        heading: "Send focused review comments to an agent",
        detail: "Replies and suggestions return here for your review."
      };
    case "preparing":
      return { heading: "Preparing review", detail: null };
    case "sending":
      return { heading: "Sending", detail: "Delivering this review batch to the agent." };
    case "waiting":
      return { heading: "Waiting for agent", detail: "You can close Comments while you wait." };
    case "importing":
      return { heading: "Receiving agent response", detail: "Checking and saving replies and suggestions." };
    case "ready": {
      const detail = getReadyDetail(result);
      return { heading: "Agent response ready", detail };
    }
    case "cancelled":
      return { heading: "Agent request cancelled", detail: "No response was imported." };
    case "failed":
      if (failure === "import") {
        return {
          heading: "Agent response couldn’t be imported",
          detail: "No partial reply or suggestion was saved."
        };
      }
      if (failure === "stale") {
        return {
          heading: "This agent response no longer belongs to the active review",
          detail: "No response was imported."
        };
      }
      return {
        heading: "Couldn’t reach agent",
        detail:
          "The prepared review is still available. Check that your local agent is ready, or continue with the exact manual export instead."
      };
  }
}

function getReadyDetail(result: AgentExchangeProductResult | null): string {
  if (!result) return "The response is ready for human review.";
  if (result.replies > 0 && result.patches > 0) {
    return `${result.replies} ${result.replies === 1 ? "reply" : "replies"} and ${result.patches} ${result.patches === 1 ? "suggestion" : "suggestions"} require your review.`;
  }
  if (result.replies > 0) {
    return `${result.replies} ${result.replies === 1 ? "reply is" : "replies are"} ready for review.`;
  }
  if (result.patches > 0) {
    return `${result.patches} ${result.patches === 1 ? "suggestion is" : "suggestions are"} ready for review.`;
  }
  return "The response is ready for human review.";
}
