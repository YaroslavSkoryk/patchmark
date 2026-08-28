import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
let assertions = 0;
const check = (value, message) => { assertions += 1; assert.ok(value, message); };
const equal = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };

equal(packageJson.dependencies.qr, "0.6.0", "QR remains exactly pinned");
check(!packageJson.overrides && !packageJson.resolutions, "no override or resolution conceals the dependency graph");
equal(lock.packages["node_modules/qr"], {
  version: "0.6.0",
  resolved: "https://registry.npmjs.org/qr/-/qr-0.6.0.tgz",
  integrity: "sha512-P23VoX7SipHALdiIYG+D+LT/6n22dNKwV92FAb3d+Nlki/5WisSsfLt0UDFz2XEBtuwrECTznvu+chKKFCSYhA==",
  license: "(MIT OR Apache-2.0)",
  engines: { node: ">= 20.19.0" }
}, "the lockfile retains the reviewed QR tarball, integrity, license, and zero-dependency record");

const qrRoot = join(root, "node_modules/qr");
const qrManifest = JSON.parse(readFileSync(join(qrRoot, "package.json"), "utf8"));
equal(qrManifest.version, "0.6.0", "installed QR version matches the lock");
equal(qrManifest.repository.url, "git+https://github.com/paulmillr/qr.git", "installed QR source repository is explicit");
check(!qrManifest.dependencies && !qrManifest.optionalDependencies && !qrManifest.peerDependencies, "QR has no runtime dependency graph");
check(!Object.keys(qrManifest.scripts ?? {}).some((name) => /^(?:preinstall|install|postinstall|prepare)$/.test(name)), "QR has no install lifecycle script");
const qrSources = qrFiles(qrRoot).filter((path) => /\.(?:js|ts)$/.test(path)).map((path) => readFileSync(path, "utf8")).join("\n");
check(!/\beval\s*\(|new\s+Function\s*\(|WebSocket|EventSource|XMLHttpRequest|child_process|process\.dlopen|\.node["']/.test(qrSources), "QR source contains no dynamic evaluation, network transport, child process, or native binding");
const productionImports = [
  readFileSync(join(root, "lib/collaboration/hc3/qr-provider.ts"), "utf8"),
  ...qrFiles(join(root, "lib")).filter((path) => /\.(?:ts|tsx)$/.test(path)).map((path) => readFileSync(path, "utf8"))
].join("\n");
check(productionImports.includes('from "qr"') && productionImports.includes('from "qr/decode.js"'), "Patchmark uses the raw QR encoder and decoder");
check(!productionImports.includes('from "qr/dom.js"'), "Patchmark never imports QR DOM, SVG, GIF, or string rendering helpers");

equal(packageJson.dependencies["@mdxeditor/editor"], "4.2.2", "MDXEditor is exactly pinned to the qualified v4 release");
equal(packageJson.dependencies.lexical, "0.48.0", "the direct Lexical command provider is exactly pinned to the editor family");
equal(packageJson.dependencies.next, "16.3.3", "Next is exactly pinned to the qualified v16 release");
equal(packageJson.devDependencies["eslint-config-next"], "16.3.3", "the Next lint configuration follows the framework family");
equal(lock.packages["node_modules/@mdxeditor/editor"].version, "4.2.2", "MDXEditor migrated to the qualified v4 release");
equal(lock.packages["node_modules/js-yaml"].version, "4.3.1", "the product-reachable js-yaml path is patched");
equal(lock.packages["node_modules/lexical"].version, "0.48.0", "the direct Lexical command provider matches MDXEditor");
equal(lock.packages["node_modules/next"].version, "16.3.3", "Next migrated to the qualified v16 release");
equal(lock.packages["node_modules/postcss"].version, "8.5.23", "the Next build-time PostCSS path is patched");
equal(lock.packages["node_modules/@mdxeditor/editor"].dependencies["js-yaml"], "4.3.1", "the exact MDXEditor to js-yaml path is recorded");
equal(lock.packages["node_modules/next"].dependencies.postcss, "8.5.23", "the exact Next to PostCSS path is recorded");
const lexicalVersions = new Set(Object.entries(lock.packages)
  .filter(([path]) => path === "node_modules/lexical" || path.includes("/node_modules/lexical"))
  .map(([, entry]) => entry.version));
equal([...lexicalVersions], ["0.48.0"], "the lock contains one coherent Lexical family");
check(!Object.keys(lock.packages).some((path) => path.includes("sandpack")), "the removed Sandpack family is absent from the lock");
check(!Object.keys(lock.packages).some((path) => /node_modules\/(?:js-yaml|postcss)$/.test(path) && ["4.1.1", "8.4.31"].includes(lock.packages[path].version)), "the vulnerable js-yaml and PostCSS baselines are absent");
equal(packageJson.scripts.dev, "next dev --webpack", "development uses the same reviewed Webpack topology as qualification");
equal(packageJson.scripts.build, "next build --webpack", "production builds opt into the reviewed Webpack topology explicitly");

const disposition = readFileSync(join(root, "docs/hc3/dependency-disposition-slice6.md"), "utf8");
for (const advisory of ["GHSA-h67p-54hq-rp68", "GHSA-52cp-r559-cp3m", "GHSA-5p4m-2wfm-xmqj", "GHSA-qx2v-qp2m-jg93", "GHSA-6g55-p6wh-862q", "GHSA-fxqj-rqcc-2cmp", "GHSA-r28c-9q8g-f849"]) {
  check(disposition.includes(advisory), `${advisory} has an explicit disposition`);
}
check(disposition.includes("@mdxeditor/editor@4.2.2") && disposition.includes("next@16.3.3"), "both qualified major fixes are documented");
check(disposition.includes("Slice 7A") && disposition.includes("zero vulnerable package records"), "the completed migration and clean final audits are explicit");
check(!/npm\s+audit\s+fix\s+--force|npm_config_audit\s*=\s*false|npm\s+audit[^&]*\|\|\s*true/.test(Object.values(packageJson.scripts).join("\n")), "package scripts contain no audit suppression or forced repair");

const qrDisposition = readFileSync(join(root, "docs/hc3/qr-disposition-slice6.md"), "utf8");
check(qrDisposition.includes("accept_pinned_dependency"), "QR has one explicit release disposition");
check(qrDisposition.includes("260ea4689bf8921a8585fe3926ec70f11de70fb6"), "QR package maps to the reviewed source commit");
check(qrDisposition.includes("00c3d080dc76adf5d3754d9ad7ff0f9263dee2e0"), "QR published tarball SHA-1 is frozen in the review record");
check(qrDisposition.includes("byte-identical") && qrDisposition.includes("19 files"), "source rebuild comparison is recorded without overstating tarball-byte reproducibility");
check(qrDisposition.includes("129,230 source bytes") && /1,843,281\s+bytes of minified JavaScript/.test(qrDisposition), "QR source boundary and complete optimized browser asset sizes are recorded exactly");

const rootImportSha256 = digest(join(qrRoot, "index.js"));
const decoderSha256 = digest(join(qrRoot, "decode.js"));
equal(rootImportSha256, "608e9a015454a99f8e08026b273b73a34acb25373ca3572431799647ff7dff6f", "reviewed QR encoder bytes remain exact");
equal(decoderSha256, "89127c12e70e446eea634c88f3e90d719b9f15ac56def386a8809e24e9f2ee61", "reviewed QR decoder bytes remain exact");

process.stdout.write(`${JSON.stringify({
  assertions,
  node: process.version,
  qr: { version: qrManifest.version, files: qrFiles(qrRoot).length, installed_bytes: directorySize(qrRoot), encoder_sha256: rootImportSha256, decoder_sha256: decoderSha256, disposition: "accept_pinned_dependency" },
  residual_packages: [],
  dependency_migration: "hc3_slice7a_closed",
  status: "ok"
}, null, 2)}\n`);

function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function qrFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...qrFiles(path)); else files.push(path);
  }
  return files.sort();
}
function directorySize(directory) { return qrFiles(directory).reduce((total, path) => total + statSync(path).size, 0); }
