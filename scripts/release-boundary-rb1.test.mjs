import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  developmentQualificationSignal,
  productFeatureNames,
  productReleaseState,
  resolveCheckedInProductFeatureRelease,
  resolveProductFeatureRelease
} from "../lib/release/product-release-state.ts";
import {
  resolveCollaborationProductFeatureStateForRuntime
} from "../lib/collaboration-shadow/feature-state.ts";
import {
  isCollaborationShadowDisabled,
  loadCollaborationProductQualification
} from "../lib/collaboration-shadow/entrypoint.ts";
import {
  agentExchangeDisabled,
  loadAgentExchangeQualification
} from "../lib/agent-exchange/entrypoint.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
let assertions = 0;
const check = (value, message) => {
  assertions += 1;
  assert.ok(value, message);
};
const equal = (actual, expected, message) => {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
};

equal(productFeatureNames, ["human_collaboration", "agent_exchange"], "release authority has exactly two independent feature keys");
equal(productReleaseState, { human_collaboration: false, agent_exchange: false }, "both checked-in production release literals are false");
check(Object.isFrozen(productReleaseState), "checked-in production release state is frozen");
assertions += 1;
assert.throws(() => {
  productReleaseState.human_collaboration = true;
}, TypeError, "runtime mutation cannot release human collaboration");

const production = (feature, releaseState, qualificationSignal = undefined) =>
  resolveProductFeatureRelease({
    feature,
    release_state: releaseState,
    environment: {
      runtime: "production",
      qualification_signal: qualificationSignal
    }
  });
const qualification = (feature, enabled) =>
  resolveProductFeatureRelease({
    feature,
    release_state: false,
    environment: {
      runtime: "test",
      qualification_signal: enabled
        ? developmentQualificationSignal
        : undefined
    }
  });

const matrix = [
  {
    name: "disabled_disabled",
    human: production("human_collaboration", false).mode,
    agent: production("agent_exchange", false).mode
  },
  {
    name: "human_qualification_only",
    human: qualification("human_collaboration", true).mode,
    agent: qualification("agent_exchange", false).mode
  },
  {
    name: "agent_qualification_only",
    human: qualification("human_collaboration", false).mode,
    agent: qualification("agent_exchange", true).mode
  },
  {
    name: "human_released_only",
    human: production("human_collaboration", true).mode,
    agent: production("agent_exchange", false).mode
  },
  {
    name: "agent_released_only",
    human: production("human_collaboration", false).mode,
    agent: production("agent_exchange", true).mode
  }
];
equal(matrix, [
  { name: "disabled_disabled", human: "disabled", agent: "disabled" },
  { name: "human_qualification_only", human: "development_qualification", agent: "disabled" },
  { name: "agent_qualification_only", human: "disabled", agent: "development_qualification" },
  { name: "human_released_only", human: "released", agent: "disabled" },
  { name: "agent_released_only", human: "disabled", agent: "released" }
], "human collaboration and agent exchange cannot enable each other");

for (const feature of productFeatureNames) {
  const checked = resolveCheckedInProductFeatureRelease(feature, {
    runtime: "production",
    qualification_signal: developmentQualificationSignal
  });
  equal(checked.mode, "disabled", `${feature} ignores a production qualification signal`);
  check(Object.isFrozen(checked), `${feature} returns a frozen production resolution`);
  check(!(checked instanceof Promise), `${feature} production resolution is synchronous`);
}

const activationVectors = [
  "?human_collaboration=released&agent_exchange=released",
  "#human_collaboration=true",
  "human_collaboration=true; agent_exchange=true",
  { localStorage: "released" },
  { sessionStorage: "released" },
  { indexedDB: "released" },
  { project_metadata: { human_collaboration: true, agent_exchange: true } },
  { frontmatter: "human_collaboration: true\nagent_exchange: true" },
  { protocol_artifact: { release: true } },
  { private_environment: "released" },
  { remote_rollout: { percentage: 100 } },
  { database_setting: "released" },
  { user_preference: "released" },
  { hidden_keyboard_shortcut: "released" },
  { browser_extension_message: "released" },
  { current_time: "2099-01-01T00:00:00.000Z" },
  developmentQualificationSignal
];
for (const vector of activationVectors) {
  for (const feature of productFeatureNames) {
    equal(
      resolveCheckedInProductFeatureRelease(feature, {
        runtime: "production",
        qualification_signal: vector
      }).mode,
      "disabled",
      `${feature} rejects activation vector ${JSON.stringify(vector)}`
    );
  }
}

equal(
  resolveProductFeatureRelease({
    feature: "human_collaboration",
    release_state: false,
    environment: {
      runtime: "test",
      qualification_signal: developmentQualificationSignal,
      imported_artifact: { released: true }
    }
  }).mode,
  "disabled",
  "an environment carrying an extra imported-artifact field fails closed"
);
equal(
  resolveCollaborationProductFeatureStateForRuntime(
    "production",
    "development_shadow"
  ).mode,
  "disabled",
  "the existing human-collaboration seam remains production locked"
);
equal(
  resolveCollaborationProductFeatureStateForRuntime(
    "test",
    "development_shadow"
  ).mode,
  "development_shadow",
  "the existing injected human-collaboration qualification seam remains available"
);

const disabledHumanDispatch = loadCollaborationProductQualification(
  "development_shadow"
);
check(isCollaborationShadowDisabled(disabledHumanDispatch), "production human-collaboration loading returns the existing disabled sentinel");
check(!(disabledHumanDispatch instanceof Promise), "production human-collaboration loading returns before dynamic import");

const disabledAgentDispatch = loadAgentExchangeQualification(
  developmentQualificationSignal
);
equal(disabledAgentDispatch, agentExchangeDisabled, "production Agent Exchange loading returns the disabled sentinel");
check(!(disabledAgentDispatch instanceof Promise), "production Agent Exchange loading returns before dynamic import");

const releaseSource = await readFile(
  join(root, "lib/release/product-release-state.ts"),
  "utf8"
);
for (const forbidden of [
  "process.env",
  "NEXT_PUBLIC_",
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch(",
  "WebSocket",
  "RTCPeerConnection",
  "crypto",
  "setTimeout",
  "setInterval",
  "Worker",
  "import("
]) {
  check(!releaseSource.includes(forbidden), `release authority contains no ${forbidden} capability or rollout input`);
}
equal(
  [...releaseSource.matchAll(/\b(?:human_collaboration|agent_exchange):\s*(true|false)/g)]
    .map((match) => match[0]),
  ["human_collaboration: false", "agent_exchange: false"],
  "the two checked-in false literals are the only release assignments"
);

const productionSources = await sourceFiles(join(root, "app"), join(root, "components"), join(root, "lib"));
const ungatedAgentImplementationEdges = [];
const releaseAuthorityAssignments = [];
for (const file of productionSources) {
  const source = await readFile(file, "utf8");
  const path = relative(root, file);
  if (
    !path.startsWith("lib/agent-exchange/") &&
    /(?:from\s+|import\s*\()["'][^"']*agent[-_/]exchange|AgentExchangeWorkspace|agent_exchange_loader/.test(source)
  ) {
    ungatedAgentImplementationEdges.push(path);
  }
  if (/\b(?:human_collaboration|agent_exchange):\s*(?:true|false)/.test(source)) {
    releaseAuthorityAssignments.push(path);
  }
}
equal(ungatedAgentImplementationEdges, [], "Agent Exchange has no ordinary product UI or ungated application load edge");
equal(releaseAuthorityAssignments, ["lib/release/product-release-state.ts"], "application source contains one release authority");

const agentEntrypoint = await readFile(
  join(root, "lib/agent-exchange/entrypoint.ts"),
  "utf8"
);
check(
  agentEntrypoint.includes('import("./qualification-loader.ts")'),
  "Agent Exchange qualification remains behind one dynamic loader"
);

process.stdout.write(`${JSON.stringify({
  assertions,
  release_state: productReleaseState,
  production_resolution: {
    human_collaboration: "disabled",
    agent_exchange: "disabled"
  },
  independence_matrix: matrix,
  activation_vectors_rejected_per_feature: activationVectors.length,
  agent_exchange_boundary: "production_disabled_qualification_loader",
  production_dispatch: "synchronous_disabled_sentinel",
  status: "ok"
}, null, 2)}\n`);

async function sourceFiles(...roots) {
  const files = [];
  for (const rootDirectory of roots) {
    for (const entry of await readdir(rootDirectory, { withFileTypes: true })) {
      const path = join(rootDirectory, entry.name);
      if (entry.isDirectory()) files.push(...await sourceFiles(path));
      else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
    }
  }
  return files;
}
