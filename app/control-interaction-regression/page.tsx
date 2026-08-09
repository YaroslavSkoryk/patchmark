import { ControlInteractionRegressionHarness } from "@/components/control-interaction-regression-harness";

export default function ControlInteractionRegressionPage() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Patchmark</h1>
          <p>Shared control-state browser regression fixture.</p>
        </div>
      </header>

      <ControlInteractionRegressionHarness />
    </main>
  );
}
