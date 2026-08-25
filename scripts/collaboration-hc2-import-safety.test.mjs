import assert from "node:assert/strict";

const touched = [];
for (const name of [
  "indexedDB", "showDirectoryPicker", "fetch", "Worker", "WebSocket", "EventSource",
  "crypto", "navigator", "document", "localStorage", "caches", "requestAnimationFrame"
]) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor?.configurable === false) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      touched.push(name);
      throw new Error(`HC-2 import touched ${name}`);
    }
  });
}

const originalRandom = Math.random;
Math.random = () => {
  touched.push("Math.random");
  throw new Error("HC-2 import touched Math.random");
};
const timerNames = ["setTimeout", "setInterval", "queueMicrotask"];
const originalTimers = new Map(timerNames.map((name) => [name, globalThis[name]]));
for (const name of timerNames) {
  globalThis[name] = () => {
    touched.push(name);
    throw new Error(`HC-2 import touched ${name}`);
  };
}

const importTargets = [
  "../lib/collaboration/hc2/index.ts",
  "../lib/collaboration/hc2/providers/provider-errors.ts",
  "../lib/collaboration/hc2/providers/secure-random.ts",
  "../lib/collaboration/hc2/providers/public-key-codec.ts",
  "../lib/collaboration/hc2/providers/native-key-handles.ts",
  "../lib/collaboration/hc2/providers/ed25519-provider.ts",
  "../lib/collaboration/hc2/providers/hpke-provider.ts",
  "../lib/collaboration/hc2/providers/hpke-v2-provider.ts",
  "../lib/collaboration/hc2/providers/hpke-v3-provider.ts",
  "../lib/collaboration/hc2/qualification-workflow.ts",
  "../lib/collaboration/hc2/providers/suite-negotiator.ts",
  "../lib/collaboration/hc2/providers/recovery-format.ts",
  "../lib/collaboration/hc2/providers/recovery-worker-protocol.ts",
  "../lib/collaboration/hc2/providers/recovery-provider.ts",
  "../lib/collaboration/hc2/transport-v2-contracts.ts",
  "../lib/collaboration/hc2/transport-v2-crypto.ts",
  "../lib/collaboration/hc2/transport-bundle-framing.ts",
  "../lib/collaboration/hc2/transport-stream-store.ts",
  "../lib/collaboration/hc2/transport-attachment-store.ts",
  "../lib/collaboration/hc2/transport-export.ts",
  "../lib/collaboration/hc2/transport-import.ts"
];
for (const target of importTargets) await import(`${target}?import-safety=${Date.now()}`);
Math.random = originalRandom;
for (const [name, implementation] of originalTimers) globalThis[name] = implementation;
assert.deepEqual(touched, []);
process.stdout.write(`${JSON.stringify({ side_effect_free_import: true, imported_modules: importTargets.length, touched_browser_globals: touched }, null, 2)}\n`);
