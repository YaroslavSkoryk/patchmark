import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const nextRoot = join(root, ".next");
const loadable = JSON.parse(
  await readFile(join(nextRoot, "react-loadable-manifest.json"), "utf8")
);
const forbiddenLoadableKeys = Object.keys(loadable).filter((key) =>
  /agent-exchange\/entrypoint\.ts -> \.\/qualification-loader\.ts/.test(key)
);
assert.deepEqual(forbiddenLoadableKeys, []);

const forbiddenPatterns = [
  /Send to agent/,
  /Waiting for agent/,
  /Agent response ready/,
  /Use manual export instead/,
  /__patchmarkAgentExchangeProductQualificationDriver/,
  /qualification\.deterministic/,
  /AgentExchangeActions/,
  /readInjectedAgentExchangeProductQualificationDriver/,
  /AgentExchangeOperationController/,
  /prepareAgentExchange/
];
const deployableHits = [];
for (const file of await deployableFiles(nextRoot)) {
  const contents = await readFile(file, "utf8");
  const patterns = forbiddenPatterns
    .filter((pattern) => pattern.test(contents))
    .map((pattern) => pattern.source);
  if (patterns.length > 0) {
    deployableHits.push({ file: relative(root, file), patterns });
  }
}
assert.deepEqual(
  deployableHits,
  [],
  "disabled Agent Exchange product/core implementation entered deployable production output"
);

process.stdout.write(`${JSON.stringify({
  deployableHits,
  forbiddenLoadableKeys,
  productionAgentExchangeUi: false,
  productionAgentExchangeImplementation: false,
  status: "ok"
}, null, 2)}\n`);

async function deployableFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const repositoryPath = relative(root, path);
    if (repositoryPath === ".next/cache" || repositoryPath === ".next/dev") continue;
    if (entry.isDirectory()) files.push(...await deployableFiles(path));
    else if (/\.(?:html|js|json|txt)$/.test(entry.name)) files.push(path);
  }
  return files;
}
