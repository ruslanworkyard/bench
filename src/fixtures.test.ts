import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CliError } from "./errors.js";
import { listFixtures, selectFixtures } from "./fixtures.js";

const dirs: string[] = [];

/** A fixtures directory with the given fixtures; `tags` undefined leaves the key out, null writes no fixture.json. */
function catalogue(fixtures: Record<string, string[] | undefined | null>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-fixtures-")));
  dirs.push(dir);
  for (const [id, tags] of Object.entries(fixtures)) {
    mkdirSync(join(dir, id));
    if (tags === null) continue;
    const meta = { id, kind: "feature", description: "d", ...(tags === undefined ? {} : { tags }) };
    writeFileSync(join(dir, id, "fixture.json"), JSON.stringify(meta), "utf8");
    writeFileSync(join(dir, id, "prompt.md"), "do it\n", "utf8");
  }
  return dir;
}

function ids(fixtures: ReturnType<typeof selectFixtures>): string[] {
  return fixtures.map((fixture) => fixture.id);
}

function refuses(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, pattern);
    return true;
  });
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CATALOGUE = { announcements: ["persistence"], "holiday-api-client": ["http", "integration"], "ttl-cache": ["performance"], untagged: undefined };

test("no ids and no tags selects every fixture, in id order", () => {
  const dir = catalogue(CATALOGUE);
  assert.deepEqual(ids(selectFixtures(dir, [], [])), ["announcements", "holiday-api-client", "ttl-cache", "untagged"]);
  assert.deepEqual(selectFixtures(dir, [], []), listFixtures(dir));
});

test("ids select those fixtures in the order given, once each; an unknown id lists what exists", () => {
  const dir = catalogue(CATALOGUE);
  assert.deepEqual(ids(selectFixtures(dir, ["ttl-cache", "announcements", "ttl-cache"], [])), ["ttl-cache", "announcements"]);
  refuses(() => selectFixtures(dir, ["ttl-cache", "nope"], []), /unknown fixture 'nope'\n\navailable fixtures:\n {2}announcements\n {2}holiday-api-client/);
});

test("tags select the fixtures carrying any of them; a fixture without a readable fixture.json carries none", () => {
  const dir = catalogue({ ...CATALOGUE, broken: null });
  assert.deepEqual(ids(selectFixtures(dir, [], ["http"])), ["holiday-api-client"]);
  assert.deepEqual(ids(selectFixtures(dir, [], ["performance", "persistence"])), ["announcements", "ttl-cache"]);
  assert.deepEqual(ids(selectFixtures(dir, [], ["integration", "http"])), ["holiday-api-client"]);
});

test("ids and tags together select the intersection, keeping the ids' order", () => {
  const dir = catalogue(CATALOGUE);
  assert.deepEqual(ids(selectFixtures(dir, ["ttl-cache", "announcements", "holiday-api-client"], ["persistence", "http"])), ["announcements", "holiday-api-client"]);
  assert.deepEqual(ids(selectFixtures(dir, ["ttl-cache"], ["performance"])), ["ttl-cache"]);
});

test("no match is an error naming what was asked for, the fixtures there are and the tags in use", () => {
  const dir = catalogue(CATALOGUE);
  refuses(
    () => selectFixtures(dir, [], ["nope"]),
    /^no fixtures match tags nope\n\navailable fixtures:\n {2}announcements\n {2}holiday-api-client\n {2}ttl-cache\n {2}untagged\ntags in use: http, integration, performance, persistence$/,
  );
  refuses(() => selectFixtures(dir, ["announcements", "ttl-cache"], ["http"]), /^no fixtures match fixtures announcements, ttl-cache with tags http\n/);

  const plain = catalogue({ a: undefined });
  refuses(() => selectFixtures(plain, [], ["x"]), /no fixture carries a tag$/);
});

test("an empty or missing fixtures directory points at init", () => {
  const empty = catalogue({});
  refuses(() => selectFixtures(empty, [], []), /no fixtures in .* - run `harnessbench init` first/);
  refuses(() => selectFixtures(join(empty, "nowhere"), ["a"], []), /no fixtures in/);
});
