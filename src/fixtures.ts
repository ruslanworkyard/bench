import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FileOp } from "./plan.js";

export type Fixture = { id: string; dir: string };

/** The fixtures/ directory shipped with the package, next to dist/. */
export function packagedFixturesDir(): string {
  return fileURLToPath(new URL("../fixtures", import.meta.url));
}

/** Fixture directories in dir, by id. Missing or unreadable dir yields none. */
export function listFixtures(dir: string): Fixture[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, dir: join(dir, entry.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Ops that reproduce the fixture directory `from` at `to`, contents unchanged. */
export function copyOps(from: string, to: string): FileOp[] {
  const ops: FileOp[] = [{ kind: "mkdir", path: to }];
  const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) ops.push(...copyOps(source, target));
    else if (entry.isFile()) {
      ops.push({ kind: "write", path: target, content: readFileSync(source, "utf8") });
    }
  }
  return ops;
}
