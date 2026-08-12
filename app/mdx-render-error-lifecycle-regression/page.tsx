import { MdxRenderErrorLifecycleRegressionHarness } from "@/components/mdx-render-error-lifecycle-regression-harness";
import { notFound } from "next/navigation";

export default function MdxRenderErrorLifecycleRegressionPage() {
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
          <p>Queued MDX render-error lifecycle regression fixture.</p>
        </div>
      </header>

      <MdxRenderErrorLifecycleRegressionHarness />
    </main>
  );
}
