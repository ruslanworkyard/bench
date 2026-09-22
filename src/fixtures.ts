import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "./errors.js";
import type { FileOp } from "./plan.js";

export type Fixture = { id: string; dir: string };

/** What a fixture.json says. The whole fixture contract: a task, described. */
export type FixtureMeta = {
  id: string;
  kind: string;
  description: string;
  tags: string[];
};

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Checks a parsed fixture.json. `where` names the file in any error. */
export function validateFixture(value: unknown, where: string): FixtureMeta {
  const fail = (message: string): never => {
    throw new CliError(`${where}: ${message}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`expected a JSON object, found ${describe(value)}`);
  }
  const raw = value as Record<string, unknown>;

  const meta: FixtureMeta = { id: "", kind: "", description: "", tags: [] };
  for (const key of ["id", "kind", "description"] as const) {
    const field = raw[key];
    if (typeof field !== "string" || field === "") {
      fail(`"${key}" must be a non-empty string, found ${describe(field)}`);
    }
    meta[key] = field as string;
  }

  const tags = raw["tags"];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
      fail('"tags" must be an array of strings');
    }
    meta.tags = [...(tags as string[])];
  }

  return meta;
}

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

/**
 * The fixtures a `run` addresses: every one in `dir`; the named ids, in that order; those
 * carrying any of `tags`; or, with both, the named ids that also carry a tag. An unknown id
 * and an empty selection are both errors that say what was asked for and what exists.
 */
export function selectFixtures(dir: string, ids: readonly string[], tags: readonly string[]): Fixture[] {
  const all = listFixtures(dir);
  if (all.length === 0) {
    throw new CliError(`no fixtures in ${dir} - run \`harnessbench init\` first`, 1);
  }
  const available = `available fixtures:\n${all.map((each) => `  ${each.id}`).join("\n")}`;

  let chosen = all;
  if (ids.length > 0) {
    const byId = new Map(all.map((fixture) => [fixture.id, fixture]));
    chosen = [...new Set(ids)].map((id) => {
      const fixture = byId.get(id);
      if (fixture === undefined) throw new CliError(`unknown fixture '${id}'\n\n${available}`, 1);
      return fixture;
    });
  }
  if (tags.length === 0) return chosen;

  const tagged = chosen.filter((fixture) => fixtureTags(fixture).some((tag) => tags.includes(tag)));
  if (tagged.length > 0) return tagged;

  const known = [...new Set(all.flatMap(fixtureTags))].sort();
  const asked = ids.length > 0 ? `fixtures ${ids.join(", ")} with tags ${tags.join(", ")}` : `tags ${tags.join(", ")}`;
  const tagsLine = known.length === 0 ? "no fixture carries a tag" : `tags in use: ${known.join(", ")}`;
  throw new CliError(`no fixtures match ${asked}\n\n${available}\n${tagsLine}`, 1);
}

/** A fixture's tags from its fixture.json; none when the file is missing or malformed. */
function fixtureTags(fixture: Fixture): string[] {
  const path = join(fixture.dir, "fixture.json");
  if (!existsSync(path)) return [];
  try {
    return validateFixture(JSON.parse(readFileSync(path, "utf8")), path).tags;
  } catch {
    return [];
  }
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
