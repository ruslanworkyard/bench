import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { CONFIG_FILE, type Config } from "../config.js";
import { listFixtures, packagedFixturesDir } from "../fixtures.js";
import type { Report } from "../print.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const roots: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-init-")));
  roots.push(dir);
  return dir;
}

/** A git repository whose only harness file is a CLAUDE.md. */
function repo(): string {
  const root = tempDir();
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n", "utf8");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");
  return root;
}

function run(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, "init", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    // Piped, not echoed: a test that expects a failure should not print it to the terminal.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runJson(cwd: string, ...args: string[]): Report {
  return JSON.parse(run(cwd, "--json", ...args)) as Report;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("init sets up a repository, and a second run changes nothing", () => {
  const root = repo();
  const fixtureIds = listFixtures(packagedFixturesDir()).map((fixture) => fixture.id);
  assert.ok(fixtureIds.length > 0, "the package should ship fixtures");

  const first = runJson(root, "--test", "npm test", "--agent", "claude-code");

  assert.deepEqual(first.harness, [{ path: "CLAUDE.md", source: "convention" }]);
  assert.deepEqual(first.testCommand, { value: "npm test", source: "--test flag" });
  assert.deepEqual(first.agent, { value: "claude-code", source: "--agent flag" });
  assert.deepEqual(first.baseBranch, {
    value: "main",
    source: "current branch main (no commits yet)",
  });
  assert.deepEqual(first.fixtures, { added: fixtureIds, present: [] });
  assert.deepEqual(first.files, [
    { path: ".harnessbench", status: "created" },
    { path: ".harnessbench/fixtures", status: "created" },
    { path: CONFIG_FILE, status: "created" },
    { path: ".gitignore", status: "appended" },
  ]);
  assert.equal(first.dryRun, false);

  const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as Config;
  assert.deepEqual(config, {
    baseBranch: "main",
    testCommand: "npm test",
    agent: {
      name: "claude-code",
      command: "claude",
      model: null,
      maxTurns: null,
      timeoutMinutes: 20,
      args: [],
      env: [],
    },
    harness: { extraPaths: [] },
  });

  for (const id of fixtureIds) {
    const copied = join(root, ".harnessbench", "fixtures", id, "fixture.json");
    const packaged = join(packagedFixturesDir(), id, "fixture.json");
    assert.equal(readFileSync(copied, "utf8"), readFileSync(packaged, "utf8"));
  }

  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\n.harnessbench/runs/\n");

  const second = runJson(root, "--test", "npm test", "--agent", "claude-code");

  assert.deepEqual(second.fixtures, { added: [], present: fixtureIds });
  assert.deepEqual(second.files, [
    { path: ".harnessbench", status: "present" },
    { path: ".harnessbench/fixtures", status: "present" },
    { path: CONFIG_FILE, status: "skipped" },
    { path: ".gitignore", status: "present" },
  ]);
});

test("--dry-run writes nothing", () => {
  const root = repo();

  const report = runJson(root, "--dry-run");

  assert.equal(report.dryRun, true);
  assert.ok(report.fixtures.added.length > 0);
  assert.ok(!existsSync(join(root, ".harnessbench")));
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\n");
});

test("a repository with nothing to detect warns instead of failing", () => {
  const root = repo();

  const report = runJson(root);

  assert.equal(report.testCommand, null);
  assert.ok(
    report.warnings.some((warning) => warning.startsWith("no test command detected")),
    `expected a test command warning, got ${JSON.stringify(report.warnings)}`,
  );
  // Whether an agent is installed depends on the machine; either way init succeeds.
  if (report.agent === null) {
    assert.ok(report.warnings.some((warning) => warning.startsWith("no agent found on PATH")));
  } else {
    assert.equal(report.agent.source, "PATH");
  }
});

test("the human summary reports what was found and what to do next", () => {
  const output = run(repo(), "--test", "npm test", "--agent", "claude-code");

  assert.match(output, /CLAUDE\.md\s+convention/);
  assert.match(output, /Test command\s+npm test\s+--test flag/);
  assert.match(output, /Base branch\s+main\s+current branch main/);
  assert.match(output, /Next: harnessbench run/);
});

test("an unknown --agent is refused, so no config that cannot run is written", () => {
  const root = repo();

  assert.throws(
    () => run(root, "--agent", "clod"),
    (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /unknown agent 'clod' - known agents: claude-code/);
      return true;
    },
  );
  assert.ok(!existsSync(join(root, CONFIG_FILE)));
});

test("outside a git repository init fails with exit code 1", () => {
  const root = tempDir();

  assert.throws(
    () => run(root),
    (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /inside a git repository/);
      return true;
    },
  );
});

test("an unusable config is reported clearly", () => {
  const root = repo();
  run(root);
  writeFileSync(join(root, CONFIG_FILE), '{"agent": {"timeoutMinutes": "soon"}}', "utf8");

  assert.throws(
    () => run(root),
    (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /"agent\.timeoutMinutes" must be a positive number/);
      return true;
    },
  );
});
