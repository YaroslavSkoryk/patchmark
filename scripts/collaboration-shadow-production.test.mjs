import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isCollaborationShadowDisabled,
  runCollaborationShadowAfterLegacyCommit
} from "../lib/collaboration-shadow/entrypoint.ts";
import { getBuildCollaborationShadowFeatureState } from "../lib/collaboration-shadow/feature-state.ts";

assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.NEXT_PUBLIC_PATCHMARK_COLLABORATION_SHADOW, "development_shadow");
assert.equal(getBuildCollaborationShadowFeatureState().mode, "disabled");

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
const appManifest = JSON.parse(
  await fs.readFile(path.join(root, ".next/app-build-manifest.json"), "utf8")
);
const loadableManifest = JSON.parse(
  await fs.readFile(path.join(root, ".next/react-loadable-manifest.json"), "utf8")
);
const deferredKey = "lib/collaboration-shadow/entrypoint.ts -> ./shadow-implementation.ts";
assert(loadableManifest[deferredKey]);
const deferredFiles = loadableManifest[deferredKey].files;
const initialPageFiles = appManifest.pages["/page"];
assert(deferredFiles.every((file) => !initialPageFiles.includes(file)));

const initialPageSource = (
  await Promise.all(
    initialPageFiles
      .filter((file) => file.endsWith(".js"))
      .map((file) => fs.readFile(path.join(root, ".next", file), "utf8"))
  )
).join("\n");
assert(!initialPageSource.includes("collaboration_shadow_container_metadata"));
assert(!initialPageSource.includes("complete_experimental_foundation"));

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
  attempted_enable_ignored: true,
  receipt_factory_calls: receiptFactoryCalls,
  heavy_chunk_deferred: deferredFiles,
  heavy_chunk_in_initial_page: false,
  production_collaboration_imports: productionCollaborationImports
}, null, 2));
