import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_FIXTURE_IDS = Object.freeze({
  legacyCore: "core-legacy",
  multiDocumentCore: "core-multidoc"
});

const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/projects/", import.meta.url)
);
const knownFixtureNames = new Set(Object.values(PROJECT_FIXTURE_IDS));
const treeDigestDomain = "patchmark-project-fixture-tree";
const treeDigestVersion = 1;

export function getProjectFixtureRoot(fixtureId) {
  if (!knownFixtureNames.has(fixtureId)) {
    throw new Error(`Unknown project fixture: ${String(fixtureId)}.`);
  }
  const fixtureRoot = resolve(fixtureDirectory, fixtureId);
  assertPathInside(fixtureDirectory, fixtureRoot);
  const fixtureStats = lstatSync(fixtureRoot);
  if (!fixtureStats.isDirectory() || fixtureStats.isSymbolicLink()) {
    throw new Error(`Project fixture ${fixtureId} is not a regular directory.`);
  }
  const canonicalFixtureDirectory = realpathSync(fixtureDirectory);
  const canonicalFixtureRoot = realpathSync(fixtureRoot);
  assertPathInside(canonicalFixtureDirectory, canonicalFixtureRoot);
  return canonicalFixtureRoot;
}

export function createProjectFixtureCopy(
  fixtureId,
  { copyTree = copyProjectTree } = {}
) {
  if (typeof copyTree !== "function") {
    throw new TypeError("copyTree must be a function.");
  }
  const sourceRoot = getProjectFixtureRoot(fixtureId);
  const sourceDigest = digestProjectTree(sourceRoot);
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), `patchmark-project-fixture-${fixtureId}-`)
  );
  const projectRoot = join(temporaryRoot, fixtureId);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return false;
    }
    cleaned = true;
    rmSync(temporaryRoot, { force: true, recursive: true });
    return true;
  };

  try {
    copyTree(sourceRoot, projectRoot);
    const copiedDigest = digestProjectTree(projectRoot);
    if (copiedDigest.digest !== sourceDigest.digest) {
      throw new Error(`Project fixture copy digest mismatch for ${fixtureId}.`);
    }
    return {
      cleanup,
      fixtureId,
      projectRoot,
      sourceRoot,
      temporaryRoot,
      treeDigest: copiedDigest
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function digestProjectTree(root) {
  const absoluteRoot = resolve(root);
  const rootStats = lstatSync(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Project tree root must be a regular directory.");
  }
  const entries = [];
  const normalizedPaths = new Set();
  collectTreeEntries(absoluteRoot, absoluteRoot, entries, normalizedPaths);
  entries.sort((first, second) =>
    first.path === second.path
      ? first.kind.localeCompare(second.kind)
      : first.path.localeCompare(second.path)
  );
  const composite = createHash("sha256");
  composite.update(`${treeDigestDomain}\0v${treeDigestVersion}\0`);
  for (const entry of entries) {
    if (entry.kind === "directory") {
      composite.update(`directory\0${entry.path}\0`);
    } else {
      composite.update(
        `file\0${entry.path}\0${entry.bytes}\0${entry.sha256}\0`
      );
    }
  }
  return {
    algorithm: "sha256",
    digest: composite.digest("hex"),
    domain: treeDigestDomain,
    entries,
    version: treeDigestVersion
  };
}

export function prepareProjectFixtureDestination(destinationRoot) {
  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) {
    throw new TypeError("destinationRoot must be a non-empty string.");
  }
  const absoluteRoot = resolve(destinationRoot);
  const stats = lstatSync(absoluteRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Performance fixture destination must be a regular directory.");
  }
  if (readdirSync(absoluteRoot).length > 0) {
    throw new Error("Performance fixture destination must be empty.");
  }
  return absoluteRoot;
}

export function writeProjectFixtureText(root, relativePath, contents) {
  if (typeof contents !== "string") {
    throw new TypeError("Fixture file contents must be a string.");
  }
  const target = resolveFixtureOutputPath(root, relativePath);
  mkdirSync(dirname(target), { mode: 0o700, recursive: true });
  writeFileSync(target, contents, { mode: 0o600 });
}

export function writeProjectFixtureJson(root, relativePath, value) {
  writeProjectFixtureText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function createFixtureSeedToken(seed) {
  if (typeof seed !== "string" || seed.length < 1 || seed.length > 64) {
    throw new Error("seed must contain between 1 and 64 characters.");
  }
  return createHash("sha256").update(`patchmark-fixture-seed\0${seed}`).digest("hex").slice(0, 12);
}

export function validateFixtureInteger(name, value, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function collectTreeEntries(root, current, entries, normalizedPaths) {
  const children = readdirSync(current, { withFileTypes: true }).sort(
    (first, second) => first.name.localeCompare(second.name)
  );
  for (const child of children) {
    const absolutePath = join(current, child.name);
    const stats = lstatSync(absolutePath);
    const normalizedPath = normalizeRelativePath(relative(root, absolutePath));
    if (normalizedPaths.has(normalizedPath)) {
      throw new Error(`Project tree contains a normalized path collision: ${normalizedPath}.`);
    }
    normalizedPaths.add(normalizedPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Project trees must not contain symbolic links: ${normalizedPath}.`);
    }
    if (stats.isDirectory()) {
      entries.push({ kind: "directory", path: normalizedPath });
      collectTreeEntries(root, absolutePath, entries, normalizedPaths);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Project trees must contain only files and directories: ${normalizedPath}.`);
    }
    const contents = readFileSync(absolutePath);
    entries.push({
      bytes: contents.byteLength,
      kind: "file",
      path: normalizedPath,
      sha256: createHash("sha256").update(contents).digest("hex")
    });
  }
}

function copyProjectTree(sourceRoot, destinationRoot) {
  if (existsSync(destinationRoot)) {
    throw new Error("Fixture copy destination already exists.");
  }
  mkdirSync(destinationRoot, { mode: 0o700 });
  copyDirectoryContents(sourceRoot, destinationRoot);
}

function copyDirectoryContents(sourceRoot, destinationRoot) {
  const children = readdirSync(sourceRoot, { withFileTypes: true }).sort(
    (first, second) => first.name.localeCompare(second.name)
  );
  for (const child of children) {
    const source = join(sourceRoot, child.name);
    const destination = join(destinationRoot, child.name);
    const stats = lstatSync(source);
    if (stats.isSymbolicLink()) {
      throw new Error(`Project fixtures must not contain symbolic links: ${child.name}.`);
    }
    if (stats.isDirectory()) {
      mkdirSync(destination, { mode: 0o700 });
      copyDirectoryContents(source, destination);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Unsupported project fixture entry: ${child.name}.`);
    }
    writeFileSync(destination, readFileSync(source), { mode: 0o600 });
  }
}

function resolveFixtureOutputPath(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw new Error("Fixture output paths must be non-empty relative POSIX paths.");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0")
    )
  ) {
    throw new Error("Fixture output path contains an unsafe segment.");
  }
  const target = resolve(root, ...segments);
  assertPathInside(resolve(root), target);
  return target;
}

function assertPathInside(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    if (relativePath === "") {
      return;
    }
    throw new Error("Project fixture path escapes its authorized root.");
  }
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(sep).join("/").normalize("NFC");
}
