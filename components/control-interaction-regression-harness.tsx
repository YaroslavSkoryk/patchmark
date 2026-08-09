"use client";

import { useState } from "react";

export function ControlInteractionRegressionHarness() {
  const [isLoading, setIsLoading] = useState(false);
  const [isToggleSelected, setIsToggleSelected] = useState(false);
  const [normalActivations, setNormalActivations] = useState(0);
  const [disabledActivations, setDisabledActivations] = useState(0);
  const [loadingActivations, setLoadingActivations] = useState(0);

  function handleLoadingActivation() {
    if (isLoading) {
      return;
    }

    setLoadingActivations((count) => count + 1);
    setIsLoading(true);
    window.setTimeout(() => setIsLoading(false), 800);
  }

  return (
    <section
      aria-label="Interaction state fixture"
      className="editor-panel"
      data-control-fixture-ready="true"
      style={{ margin: "0 auto 20px", maxWidth: 1280, padding: 18 }}
    >
      <h2 style={{ marginTop: 0 }}>Shared control-state fixture</h2>
      <div
        className="document-actions"
        style={{ justifyContent: "flex-start" }}
      >
        <button
          data-activation-count={normalActivations}
          data-control="normal"
          type="button"
          onClick={() => setNormalActivations((count) => count + 1)}
        >
          Ordinary
        </button>
        <button
          className="document-action-primary"
          data-control="primary"
          type="button"
        >
          Primary
        </button>
        <button
          aria-label="Favorite document"
          data-control="icon"
          type="button"
        >
          ★
        </button>
        <div className="mode-switcher" aria-label="Fixture mode">
          <button
            aria-pressed={isToggleSelected}
            data-control="toggle"
            type="button"
            onClick={() => setIsToggleSelected((selected) => !selected)}
          >
            Toggle
          </button>
          <button aria-pressed="true" data-control="selected" type="button">
            Selected
          </button>
        </div>
        <button
          data-activation-count={disabledActivations}
          data-control="disabled"
          disabled
          type="button"
          onClick={() => setDisabledActivations((count) => count + 1)}
        >
          Disabled
        </button>
        <button
          aria-busy={isLoading}
          data-activation-count={loadingActivations}
          data-control="loading"
          disabled={isLoading}
          type="button"
          onClick={handleLoadingActivation}
        >
          {isLoading ? "Saving fixture…" : "Save fixture"}
        </button>
        <button
          className="destructive-action"
          data-control="destructive"
          type="button"
        >
          Destructive
        </button>
      </div>
    </section>
  );
}
