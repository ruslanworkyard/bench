import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { apply, type FileOp } from "./plan.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-plan-")));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("apply performs every kind of op", () => {
  const root = tempDir();
  const ops: FileOp[] = [
    { kind: "mkdir", path: join(root, "state", "fixtures") },
    { kind: "write", path: join(root, "state", "config.json"), content: "{}\n" },
    { kind: "appendLine", path: join(root, ".gitignore"), line: "state/runs/" },
  ];

  const applied = apply(ops, { dryRun: false });

  assert.deepEqual(
    applied.map((entry) => entry.status),
    ["created", "created", "appended"],
  );
  assert.ok(existsSync(join(root, "state", "fixtures")));
  assert.equal(readFileSync(join(root, "state", "config.json"), "utf8"), "{}\n");
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "state/runs/\n");
});

test("write never clobbers an existing file", () => {
  const root = tempDir();
  const path = join(root, "config.json");
  writeFileSync(path, "mine\n", "utf8");

  const applied = apply([{ kind: "write", path, content: "theirs\n" }], { dryRun: false });

  assert.equal(applied[0]?.status, "skipped");
  assert.equal(readFileSync(path, "utf8"), "mine\n");
});

test("mkdir and appendLine are idempotent", () => {
  const root = tempDir();
  const ops: FileOp[] = [
    { kind: "mkdir", path: join(root, "state") },
    { kind: "appendLine", path: join(root, ".gitignore"), line: "state/runs/" },
  ];
  apply(ops, { dryRun: false });

  const second = apply(ops, { dryRun: false });

  assert.deepEqual(
    second.map((entry) => entry.status),
    ["present", "present"],
  );
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "state/runs/\n");
});

test("appendLine adds the missing newline of a file that lacks one", () => {
  const root = tempDir();
  const path = join(root, ".gitignore");
  writeFileSync(path, "node_modules/\ndist/", "utf8");

  apply([{ kind: "appendLine", path, line: "state/runs/" }], { dryRun: false });

  assert.equal(readFileSync(path, "utf8"), "node_modules/\ndist/\nstate/runs/\n");
});

test("dryRun reports the same statuses but writes nothing", () => {
  const root = tempDir();
  const ops: FileOp[] = [
    { kind: "mkdir", path: join(root, "state") },
    { kind: "write", path: join(root, "state", "config.json"), content: "{}\n" },
    { kind: "appendLine", path: join(root, ".gitignore"), line: "state/runs/" },
  ];

  const applied = apply(ops, { dryRun: true });

  assert.deepEqual(
    applied.map((entry) => entry.status),
    ["created", "created", "appended"],
  );
  assert.deepEqual(readdirSync(root), []);
});
