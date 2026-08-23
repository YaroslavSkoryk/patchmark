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

await import(`../lib/collaboration/hc2/index.ts?import-safety=${Date.now()}`);
Math.random = originalRandom;
for (const [name, implementation] of originalTimers) globalThis[name] = implementation;
assert.deepEqual(touched, []);
process.stdout.write(`${JSON.stringify({ side_effect_free_import: true, touched_browser_globals: touched }, null, 2)}\n`);
