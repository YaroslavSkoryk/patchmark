import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
let assertions = 0;
const check = (condition, message) => { assertions += 1; assert(condition, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };

const approved = Object.freeze({
  "@hpke/core": {
    version: "1.9.0",
    integrity: "sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q==",
    license: "MIT",
    dependencies: { "@hpke/common": "^1.10.0" }
  },
  "@hpke/common": {
    version: "1.10.1",
    integrity: "sha512-moJwhmtLtuxiUzzNp1jpfBfx8yefKoO9D/RCR9dmwrnc7qjJqId1rEtQz+lSlU5cabX8daToMSx/7HayXOiaFw==",
    license: "MIT",
    dependencies: {}
  },
  "libsodium-wrappers-sumo": {
    version: "0.8.4",
    integrity: "sha512-ql7hcgulKZ3ekfa2DGAogcCKsWU0diA/0nArz1CFzh93WQdb46/Kj18ka/Hifq6uA3Ush34Pc6vU/6HXeRwUkg==",
    license: "ISC",
    dependencies: { "libsodium-sumo": "^0.8.0" }
  },
  "libsodium-sumo": {
    version: "0.8.4",
    integrity: "sha512-TMtHShQfVVsaxDygyapvUC3o7YsPgXa/hRWeIgzyFz6w5k/1hirGptCxp1U7XwW3rCskaTTYKgV10v86UiGgNw==",
    license: "ISC",
    dependencies: {}
  }
});

equal(packageJson.dependencies["@hpke/core"], "1.9.0", "HPKE direct dependency is exactly pinned");
equal(packageJson.dependencies["libsodium-wrappers-sumo"], "0.8.4", "libsodium wrapper direct dependency is exactly pinned");
for (const [name, expectation] of Object.entries(approved)) {
  const entry = lock.packages[`node_modules/${name}`];
  check(entry, `${name} exists in lockfile`);
  equal(entry.version, expectation.version, `${name} exact version`);
  equal(entry.integrity, expectation.integrity, `${name} registry integrity`);
  equal(entry.license, expectation.license, `${name} compatible license`);
  equal(entry.dependencies ?? {}, expectation.dependencies, `${name} has only reviewed transitives`);
  const publishedManifest = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
  equal(publishedManifest.version, expectation.version, `${name} installed artifact matches lock version`);
  check(!publishedManifest.scripts, `${name} has no lifecycle scripts`);
}

const cryptoNamedPackages = Object.keys(lock.packages)
  .filter((name) => /(?:hpke|libsodium|argon2|xchacha|tweetnacl)/i.test(name))
  .map((name) => name.replace(/^node_modules\//, ""))
  .sort();
equal(cryptoNamedPackages, Object.keys(approved).sort(), "no other crypto implementation package entered the dependency graph");

const providerRoot = join(root, "lib", "collaboration", "hc2", "providers");
const providerFiles = (await sourceFiles(providerRoot)).sort();
const forbiddenImportPatterns = [
  /from\s+["'][^"']*(?:\/(?:app|components|project-storage|persistence|transport|synchroni[sz]ation|portable-folder|coordination-store)(?:\/|\.|["']))/i,
  /import\s*\(\s*["'][^"']*(?:\/(?:app|components|project-storage|persistence|transport|synchroni[sz]ation|portable-folder|coordination-store)(?:\/|\.|["']))/i
];
const remoteImport = /(?:from\s+|import\s*\()["']https?:\/\//;
const logging = /\b(?:console\.(?:log|debug|info|warn|error)|logger\.|logSecret)\s*\(/;
const weakRandom = /Math\.random|randomUUID|Date\.now\s*\(/;
const rawPrivateExport = /exportKey\s*\(\s*["'](?:pkcs8|jwk)["'][^)]*private/i;
for (const file of providerFiles) {
  const source = await readFile(file, "utf8");
  for (const pattern of forbiddenImportPatterns) check(!pattern.test(source), `${relative(root, file)} has no forbidden application-layer import`);
  check(!remoteImport.test(source), `${relative(root, file)} has no CDN or remote import`);
  check(!logging.test(source), `${relative(root, file)} has no logging path`);
  check(!weakRandom.test(source), `${relative(root, file)} has no weak random/time identifier fallback`);
  check(!rawPrivateExport.test(source), `${relative(root, file)} exposes no general raw-private export`);
}

const hc2Barrel = await readFile(join(root, "lib", "collaboration", "hc2", "index.ts"), "utf8");
check(!hc2Barrel.includes("./providers/"), "provider modules are absent from the HC-2 barrel");
const collaborationBarrel = await readFile(join(root, "lib", "collaboration", "index.ts"), "utf8");
check(!collaborationBarrel.includes("./hc2/"), "HC-2 remains absent from the production collaboration barrel");

const cryptoContracts = await readFile(join(root, "lib", "collaboration", "hc2", "crypto-contracts.ts"), "utf8");
check(cryptoContracts.includes("sealBound(input:"), "recipient envelope sender contract exposes one bound operation");
check(cryptoContracts.includes("openBound(input:"), "recipient envelope receiver contract exposes one bound operation");
check(!cryptoContracts.includes("createSenderContext") && !cryptoContracts.includes("createRecipientContext"), "public crypto contracts expose no HPKE context constructor");
const hpkeProvider = await readFile(join(providerRoot, "hpke-provider.ts"), "utf8");
check(!/export\s+(?:class|function|const|type|interface)\s+SingleUseContext/.test(hpkeProvider), "single-use HPKE context wrapper is not exported");
check(hpkeProvider.includes("this.#context = null;\n    return context.seal"), "sender wrapper clears its context before asynchronous seal");
check(hpkeProvider.includes("this.#context = null;\n    return context.open"), "receiver wrapper clears its context before asynchronous open");

const productionSources = [
  ...await sourceFiles(join(root, "app")),
  ...await sourceFiles(join(root, "components")),
  ...await sourceFiles(join(root, "lib"))
].filter((file) => !file.startsWith(`${providerRoot}/`));
const providerImporters = [];
for (const file of productionSources) {
  const source = await readFile(file, "utf8");
  if (/hc2\/providers|providers\/(?:hpke|recovery|ed25519|native-key|secure-random|suite-negotiator)/.test(source)) {
    providerImporters.push(relative(root, file));
  }
}
equal(providerImporters, [], "no production source imports a Slice 3 provider");

let clientChunkCount = 0;
if (process.env.PATCHMARK_VERIFY_BUILD_OUTPUT === "1") {
  const chunkRoot = join(root, ".next", "static", "chunks");
  const chunks = await sourceFiles(chunkRoot);
  clientChunkCount = chunks.length;
  for (const file of chunks) {
    const source = await readFile(file, "utf8");
    check(!/@hpke\/|libsodium|argon2id|patchmark-hc2-recovery-operation|recovery-worker/.test(source), `${relative(root, file)} contains no Slice 3 implementation`);
  }
}

const artifactSizes = {};
for (const name of Object.keys(approved)) {
  artifactSizes[name] = await directoryBytes(join(root, "node_modules", name));
}

process.stdout.write(`${JSON.stringify({
  assertions,
  approved_packages: Object.fromEntries(Object.entries(approved).map(([name, value]) => [name, value.version])),
  lockfile_additions: Object.keys(approved),
  provider_modules_scanned: providerFiles.length,
  production_provider_importers: providerImporters,
  installed_artifact_bytes: artifactSizes,
  client_chunks_scanned: clientChunkCount,
  hpke_context_policy: "internal-rfc-ordered-setup-bound-finalizer-then-one-operation",
  production_collaboration_state: "disabled"
}, null, 2)}\n`);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return total;
}
