import assert from "node:assert/strict";

const touched = [];
const guardedGlobals = [
  "indexedDB", "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker",
  "fetch", "Worker", "WebSocket", "EventSource", "RTCPeerConnection",
  "crypto", "navigator", "document", "location", "history", "localStorage",
  "caches", "requestAnimationFrame"
];
const descriptors = new Map();
for (const name of guardedGlobals) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  descriptors.set(name, descriptor);
  if (descriptor?.configurable === false) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      touched.push(name);
      throw new Error(`HC-3 import touched ${name}`);
    }
  });
}

const originalRandom = Math.random;
Math.random = () => { touched.push("Math.random"); throw new Error("HC-3 import touched Math.random"); };
const timerNames = ["setTimeout", "setInterval", "queueMicrotask"];
const originalTimers = new Map(timerNames.map((name) => [name, globalThis[name]]));
for (const name of timerNames) globalThis[name] = () => { touched.push(name); throw new Error(`HC-3 import touched ${name}`); };

const targets = [
  "../lib/collaboration/hc3/versions.ts",
  "../lib/collaboration/hc3/contracts.ts",
  "../lib/collaboration/hc3/text.ts",
  "../lib/collaboration/hc3/link.ts",
  "../lib/collaboration/hc3/qr.ts",
  "../lib/collaboration/hc3/bundle-files.ts",
  "../lib/collaboration/hc3/workflow-contracts.ts",
  "../lib/collaboration/hc3/workflow-ports.ts",
  "../lib/collaboration/hc3/browser-adapters.ts",
  "../lib/collaboration/hc3/workflow.ts",
  "../lib/collaboration/hc3/index.ts"
];
try {
  for (const target of targets) await import(`${target}?import-safety=${Date.now()}`);
} finally {
  Math.random = originalRandom;
  for (const [name, implementation] of originalTimers) globalThis[name] = implementation;
  for (const [name, descriptor] of descriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
}

assert.deepEqual(touched, []);
process.stdout.write(`${JSON.stringify({
  side_effect_free_import: true,
  imported_modules: targets.length,
  touched_browser_globals: touched,
  import_time_crypto_or_randomness: false,
  import_time_network_or_navigation: false
}, null, 2)}\n`);
