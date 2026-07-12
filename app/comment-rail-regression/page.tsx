import { CommentRailRegressionHarness } from "@/components/comment-rail-regression-harness";

export default function CommentRailRegressionPage() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Patchmark</h1>
          <p>Comment rail browser regression harness.</p>
        </div>
      </header>

      <CommentRailRegressionHarness />
    </main>
  );
}
