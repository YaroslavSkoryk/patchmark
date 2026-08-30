"use client";

import { useEffect, useRef } from "react";
import styles from "./agent-exchange-actions.module.css";

export type AgentExchangeProductPhase =
  | "idle"
  | "preparing"
  | "pairing"
  | "sending"
  | "waiting"
  | "importing"
  | "ready"
  | "failed"
  | "cancelled";

export type AgentExchangeProductFailure =
  | "authentication_required"
  | "busy"
  | "codex_unavailable"
  | "codex_unsupported"
  | "import"
  | "provider"
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
  onPair,
  onPairingCodeChange,
  onReview,
  onSend,
  phase,
  pairingCode,
  pairingError,
  result
}: {
  canFallback: boolean;
  disabled: boolean;
  failure: AgentExchangeProductFailure | null;
  mode?: "full" | "send_only";
  onCancel(): void;
  onFallback(): void;
  onPair(): void;
  onPairingCodeChange(value: string): void;
  onReview(): void;
  onSend(): void;
  phase: AgentExchangeProductPhase;
  pairingCode: string;
  pairingError: boolean;
  result: AgentExchangeProductResult | null;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  const pairingInputRef = useRef<HTMLInputElement>(null);
  const previousPhaseRef = useRef(phase);

  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (previous !== "pairing" && phase === "pairing") {
      pairingInputRef.current?.focus();
    } else if (
      (previous === "idle" || previous === "preparing") &&
      phase === "sending"
    ) {
      cancelRef.current?.focus();
    } else if (previous !== "cancelled" && phase === "cancelled") {
      fallbackRef.current?.focus();
    }
  }, [phase]);

  if (mode === "send_only" && phase === "idle") {
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
        {phase === "pairing" ? (
          <form
            className={styles.pairing}
            onSubmit={(event) => {
              event.preventDefault();
              onPair();
            }}
          >
            <label htmlFor="patchmark-agent-exchange-pairing-code">
              One-time pairing code
            </label>
            <input
              autoCapitalize="none"
              autoComplete="off"
              id="patchmark-agent-exchange-pairing-code"
              maxLength={43}
              onChange={(event) => onPairingCodeChange(event.target.value)}
              ref={pairingInputRef}
              spellCheck={false}
              type="text"
              value={pairingCode}
            />
            <button disabled={!pairingCode} type="submit">
              Pair and send
            </button>
            <button onClick={onCancel} type="button">
              Cancel
            </button>
            {pairingError ? (
              <span className={styles.pairingError} role="alert">
                Pairing failed. Check that the connector is running and enter its
                current one-time code.
              </span>
            ) : null}
          </form>
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
    case "pairing":
      return {
        heading: "Pair with local Codex",
        detail:
          "Enter the one-time code shown in the Patchmark Connector terminal. The session stays only in this browser tab."
      };
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
      if (failure === "codex_unavailable") {
        return {
          heading: "Local Codex isn’t ready",
          detail:
            "Start Patchmark Connector and check that Codex is installed, then try again or use the exact manual export."
        };
      }
      if (failure === "codex_unsupported") {
        return {
          heading: "This Codex version isn’t supported",
          detail:
            "Use the qualified local Codex version, or continue with the exact manual export."
        };
      }
      if (failure === "authentication_required") {
        return {
          heading: "Codex sign-in required",
          detail:
            "Sign in with Codex locally, then try again. Patchmark does not receive your credentials."
        };
      }
      if (failure === "busy") {
        return {
          heading: "Local Codex is busy",
          detail:
            "Another tab or profile owns the current request. Wait for it to finish, or use the exact manual export."
        };
      }
      if (failure === "provider") {
        return {
          heading: "Codex couldn’t complete the review",
          detail:
            "No response was imported. Try again deliberately, or use the exact manual export."
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
