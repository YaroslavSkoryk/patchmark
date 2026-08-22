import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Test-only read boundary. Production source capture belongs to Slice 8. */
export async function readFixtureMarkdown(
  fixtureRoot: string,
  relativePath: string
): Promise<Uint8Array> {
  return Uint8Array.from(await readFile(path.join(fixtureRoot, relativePath)));
}

export async function snapshotFixtureBytes(
  fixtureRoot: string
): Promise<ReadonlyMap<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  await walk(fixtureRoot, fixtureRoot, entries);
  return entries;
}

export function fixtureSnapshotsEqual(
  left: ReadonlyMap<string, Uint8Array>,
  right: ReadonlyMap<string, Uint8Array>
): boolean {
  if (left.size !== right.size) return false;
  for (const [name, bytes] of left) {
    const candidate = right.get(name);
    if (
      candidate === undefined ||
      candidate.length !== bytes.length ||
      !candidate.every((byte, index) => byte === bytes[index])
    ) {
      return false;
    }
  }
  return true;
}

async function walk(
  root: string,
  directory: string,
  output: Map<string, Uint8Array>
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, output);
    } else if (entry.isFile()) {
      output.set(path.relative(root, absolute), Uint8Array.from(await readFile(absolute)));
    }
  }
}
