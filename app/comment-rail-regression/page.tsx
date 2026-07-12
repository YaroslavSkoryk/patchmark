import { CommentRailRegressionHarness } from "@/components/comment-rail-regression-harness";
import { notFound } from "next/navigation";

export default function CommentRailRegressionPage() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.PATCHMARK_ENABLE_TEST_ROUTES !== "1"
  ) {
    notFound();
  }

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
