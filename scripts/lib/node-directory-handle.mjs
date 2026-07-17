import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class NodeDirectoryHandle {
  constructor(directoryPath, controller = createNodeHandleController()) {
    this.path = path.resolve(directoryPath);
    this.name = path.basename(this.path);
    this.kind = "directory";
    this.controller = controller;
  }

  async getFileHandle(name, options = {}) {
    validateEntryName(name);
    const filePath = path.join(this.path, name);

    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        throw createNotFoundError(filePath);
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      if (!options.create) {
        throw createNotFoundError(filePath);
      }
      fs.mkdirSync(this.path, { recursive: true });
      fs.closeSync(fs.openSync(filePath, "a"));
    }

    return new NodeFileHandle(filePath, this.controller);
  }

  async getDirectoryHandle(name, options = {}) {
    validateEntryName(name);
    const directoryPath = path.join(this.path, name);

    try {
      const stats = fs.statSync(directoryPath);
      if (!stats.isDirectory()) {
        throw createNotFoundError(directoryPath);
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      if (!options.create) {
        throw createNotFoundError(directoryPath);
      }
      fs.mkdirSync(directoryPath, { recursive: true });
    }

    return new NodeDirectoryHandle(directoryPath, this.controller);
  }

  async removeEntry(name, options = {}) {
    validateEntryName(name);
    const entryPath = path.join(this.path, name);

    try {
      const stats = fs.statSync(entryPath);
      if (stats.isDirectory()) {
        fs.rmSync(entryPath, { recursive: options.recursive === true });
      } else {
        fs.unlinkSync(entryPath);
      }
    } catch (error) {
      if (isMissing(error)) {
        throw createNotFoundError(entryPath);
      }
      throw error;
    }
  }

  async *entries() {
    for (const entry of fs.readdirSync(this.path, { withFileTypes: true })) {
      yield [
        entry.name,
        { kind: entry.isDirectory() ? "directory" : "file" }
      ];
    }
  }

  async resolve(possibleDescendant) {
    if (!possibleDescendant?.path) {
      return null;
    }
    const relativePath = path.relative(this.path, possibleDescendant.path);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return relativePath === "" ? [] : null;
    }
    return relativePath.split(path.sep);
  }
}

class NodeFileHandle {
  constructor(filePath, controller) {
    this.path = filePath;
    this.name = path.basename(filePath);
    this.kind = "file";
    this.controller = controller;
  }

  async isSymbolicLink() {
    return fs.lstatSync(this.path).isSymbolicLink();
  }

  async getFile() {
    const filePath = this.path;
    const stats = fs.statSync(filePath);

    return {
      name: this.name,
      size: stats.size,
      lastModified: stats.mtimeMs,
      type: "",
      async text() {
        return fs.readFileSync(filePath, "utf8");
      }
    };
  }

  async createWritable() {
    const chunks = [];
    const targetPath = this.path;
    const controller = this.controller;

    return {
      async write(data) {
        chunks.push(toBuffer(data));
      },
      async close() {
        const contents = Buffer.concat(chunks);
        controller.beforeWrite?.(targetPath, contents);
        const temporaryPath = `${targetPath}.node-write-${process.pid}-${crypto.randomUUID()}`;
        let descriptor;

        try {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          descriptor = fs.openSync(temporaryPath, "wx", 0o600);
          fs.writeFileSync(descriptor, contents);
          fs.fsyncSync(descriptor);
          fs.closeSync(descriptor);
          descriptor = undefined;
          controller.beforeRename?.(temporaryPath, targetPath);
          fs.renameSync(temporaryPath, targetPath);
          fsyncDirectory(path.dirname(targetPath));
        } catch (error) {
          if (descriptor !== undefined) {
            fs.closeSync(descriptor);
          }
          fs.rmSync(temporaryPath, { force: true });
          throw error;
        }
      }
    };
  }
}

export function createNodeHandleController(overrides = {}) {
  return {
    beforeWrite: overrides.beforeWrite,
    beforeRename: overrides.beforeRename
  };
}

function toBuffer(value) {
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  throw new TypeError("Node Patchmark file handles accept string or byte writes.");
}

function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function validateEntryName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new TypeError(`Invalid filesystem entry name: ${String(name)}`);
  }
}

function createNotFoundError(entryPath) {
  return new DOMException(`Not found: ${entryPath}`, "NotFoundError");
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.name === "NotFoundError";
}
