import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CollaborationQualificationWorkspace } from "../components/collaboration/collaboration-qualification-workspace.tsx";
import { createSlice4RealProductAuthorityRuntime } from "./collaboration-hc3-slice4-product-authority-runtime.ts";
import slice5Fixture from "./fixtures/collaboration-hc2-slice5-v1.json";

const OPTIMIZED_HARNESS_MARKER = "PATCHMARK_HC3_SLICE5_OPTIMIZED_HARNESS_V1";
const role = document.documentElement.dataset.patchmarkQualificationRole === "candidate"
  ? "candidate"
  : "owner";
const projectId = "prj_hc3_slice4";
const projectTitle = "HC3 Optimized Policy Qualification";
const bridge = { loaded: false, inspects: 0, invokes: 0, closed: 0, instanceCount: 0 };
let assembled: ReturnType<typeof createSlice4RealProductAuthorityRuntime> | null = null;

function installAuthorityRuntime() {
  if (assembled) return;
  assembled = createSlice4RealProductAuthorityRuntime({
    role,
    project_id: projectId,
    project_title: projectTitle,
    database_prefix: `patchmark-hc3-slice5-optimized-${role}`,
    slice5_fixture: slice5Fixture
  });
  bridge.loaded = true;
  bridge.instanceCount = 1;
  const authorityRuntime = Object.freeze({
    async inspect(input: Readonly<{ project_id: string }>) {
      bridge.inspects += 1;
      return assembled!.runtime.inspect(input);
    },
    async invoke(input: unknown) {
      bridge.invokes += 1;
      return assembled!.runtime.invoke(input);
    },
    closeOperationalWork() {
      bridge.closed += 1;
      assembled!.runtime.closeOperationalWork();
    }
  });
  Object.defineProperties(window, {
    __patchmarkHc3ProductAuthorityRuntime: { value: authorityRuntime, configurable: false },
    __patchmarkHc3Slice4AuthorityHarness: { value: assembled.harness, configurable: false }
  });
}

Object.defineProperties(window, {
  __patchmarkHc3Slice4BridgeEvidence: { value: bridge, configurable: false },
  __patchmarkHc3Slice5OptimizedMarker: { value: OPTIMIZED_HARNESS_MARKER, configurable: false },
  __patchmarkHc3Slice5OptimizedReady: { value: true, configurable: true, writable: true }
});

function OptimizedQualificationHost() {
  const [open, setOpen] = useState(false);
  function openWorkspace() {
    installAuthorityRuntime();
    setOpen(true);
  }
  return (
    <main data-testid="hc3-slice5-optimized-host" data-qualification-state="development_shadow">
      <h1>HC-3 production-optimized policy qualification</h1>
      <p>This isolated test surface is not a Patchmark production route.</p>
      <button type="button" onClick={openWorkspace}>Open collaboration workspace</button>
      {open ? (
        <CollaborationQualificationWorkspace
          sourceProjectId={projectId}
          sourceProjectTitle={projectTitle}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Optimized qualification root is missing.");
createRoot(root).render(<OptimizedQualificationHost />);

declare global {
  interface Window {
    __patchmarkHc3ProductAuthorityRuntime: Readonly<Record<string, unknown>>;
    __patchmarkHc3Slice4AuthorityHarness: NonNullable<typeof assembled>["harness"];
    __patchmarkHc3Slice4BridgeEvidence: typeof bridge;
    __patchmarkHc3Slice5OptimizedMarker: typeof OPTIMIZED_HARNESS_MARKER;
    __patchmarkHc3Slice5OptimizedReady: boolean;
  }
}
