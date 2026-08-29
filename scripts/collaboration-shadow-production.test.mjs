import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getCollaborationProductQualificationState,
  isCollaborationShadowDisabled,
  loadCollaborationProductQualification,
  runCollaborationShadowAfterLegacyCommit
} from "../lib/collaboration-shadow/entrypoint.ts";
import { getBuildCollaborationShadowFeatureState } from "../lib/collaboration-shadow/feature-state.ts";
import { productReleaseState } from "../lib/release/product-release-state.ts";

assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.NEXT_PUBLIC_PATCHMARK_COLLABORATION_SHADOW, "development_shadow");
assert.deepEqual(productReleaseState, {
  human_collaboration: false,
  agent_exchange: false
});
assert(Object.isFrozen(productReleaseState));
assert.equal(getBuildCollaborationShadowFeatureState().mode, "disabled");
assert.equal(
  getCollaborationProductQualificationState("development_shadow").mode,
  "disabled"
);

const productDispatch = loadCollaborationProductQualification(
  "development_shadow"
);
assert(isCollaborationShadowDisabled(productDispatch));
assert(!(productDispatch instanceof Promise));

let receiptFactoryCalls = 0;
const dispatch = runCollaborationShadowAfterLegacyCommit(() => {
  receiptFactoryCalls += 1;
  throw new Error("production-disabled receipt factory was invoked");
});
assert(isCollaborationShadowDisabled(dispatch));
assert(!(dispatch instanceof Promise));
assert.equal(receiptFactoryCalls, 0);

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");
const pageClientReferenceSource = await fs.readFile(
  path.join(root, ".next/server/app/page_client-reference-manifest.js"),
  "utf8"
);
const pageManifestPrefix = 'globalThis.__RSC_MANIFEST["/page"]=';
const pageManifestStart = pageClientReferenceSource.indexOf(pageManifestPrefix);
assert(pageManifestStart >= 0, "Next app-page client reference manifest is present");
const appPageManifest = JSON.parse(
  pageClientReferenceSource.slice(pageManifestStart + pageManifestPrefix.length, pageClientReferenceSource.lastIndexOf(";"))
);
const loadableManifest = JSON.parse(
  await fs.readFile(path.join(root, ".next/react-loadable-manifest.json"), "utf8")
);
const disabledImplementationKeys = Object.keys(loadableManifest).filter((key) =>
  /collaboration-shadow\/entrypoint\.ts -> \.(?:\/shadow-implementation|\/product-qualification-loader)\.ts/.test(key)
);
assert.deepEqual(
  disabledImplementationKeys,
  [],
  "Production manifests must not expose disabled collaboration loaders"
);
const initialPageFiles = [...new Set(Object.values(appPageManifest.clientModules)
  .flatMap((entry) => entry.chunks)
  .filter((entry) => typeof entry === "string" && entry.endsWith(".js")))];
assert(initialPageFiles.length > 0, "Next app-page client chunks are explicit");

const initialPageSource = (
  await Promise.all(
    initialPageFiles
      .filter((file) => file.endsWith(".js"))
      .map((file) => fs.readFile(path.join(root, ".next", file), "utf8"))
  )
).join("\n");
assert(!initialPageSource.includes("collaboration_shadow_container_metadata"));
assert(!initialPageSource.includes("complete_experimental_foundation"));
assert(!initialPageSource.includes("AgentExchangeWorkspace"));
assert(!initialPageSource.includes("agent_exchange_loader"));

const productionModule = await fs.readFile(
  path.join(root, "lib/project/patchmark-project.ts"),
  "utf8"
);
const productionCollaborationImports = [
  ...productionModule.matchAll(/from\s+["']([^"']*collaboration[^"']*)["']/g)
].map((match) => match[1]);
assert.deepEqual(productionCollaborationImports, ["../collaboration-shadow/entrypoint.ts"]);
assert(!productionModule.includes("../collaboration/immutable-store"));
assert(!productionModule.includes("../collaboration/projector"));
assert(!productionModule.includes("../collaboration/bootstrap"));

console.log(JSON.stringify({
  production_feature_state: "disabled",
  release_state: productReleaseState,
  agent_exchange_implementation_in_initial_page: false,
  attempted_enable_ignored: true,
  receipt_factory_calls: receiptFactoryCalls,
  disabled_implementation_loadable_keys: disabledImplementationKeys,
  disabled_implementation_in_production_manifest: false,
  heavy_chunk_in_initial_page: false,
  production_collaboration_imports: productionCollaborationImports
}, null, 2));
