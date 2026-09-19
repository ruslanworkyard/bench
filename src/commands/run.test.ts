import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** A PATH with one fake agent executable on it, so requireAgent can resolve. */
const AGENT = "fake-agent";
const AGENT_BIN = (() => {
  const bin = tempDir("harnessbench-bin-");
  const path = join(bin, AGENT);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
  return bin;
})();

const ENV = {
  ...process.env,
  PATH: `${AGENT_BIN}${delimiter}${process.env["PATH"] ?? ""}`,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "harnessbench",
  GIT_AUTHOR_EMAIL: "harnessbench@example.com",
  GIT_COMMITTER_NAME: "harnessbench",
  GIT_COMMITTER_EMAIL: "harnessbench@example.com",
};

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, env: ENV, stdio: "ignore" });
}

function cli(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: "utf8" });
}

/** An initialised repository with one commit, ready to run. */
function repo(): string {
  const root = tempDir("harnessbench-run-");
  git(root, "init", "--quiet", "-b", "main");
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n", "utf8");
  cli(root, "init", "--test", "npm test", "--agent", AGENT);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

function fails(cwd: string, ...args: string[]): { status: number; stderr: string } {
  try {
    cli(cwd, ...args);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number; stderr?: string };
    return { status: failure.status ?? 0, stderr: String(failure.stderr) };
  }
  return assert.fail("expected the command to fail");
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("run prints the plan for a fixture", () => {
  const root = repo();

  const output = cli(root, "run", "ttl-cache");

  assert.match(output, /harnessbench run {2}ttl-cache/);
  assert.match(output, new RegExp(`Repo\\s+${root}`));
  assert.match(output, /HEAD\s+[0-9a-f]{40}/);
  assert.match(output, /Base branch\s+main\s+[0-9a-f]{40}/);
  assert.match(output, new RegExp(`Agent\\s+${AGENT}\\s+${join(AGENT_BIN, AGENT)}`));
  assert.match(output, /Fixture\s+ttl-cache\s+\S/);
  assert.doesNotMatch(output, /uncommitted changes/);
});

test("run warns about harness files with uncommitted changes", () => {
  const root = repo();
  writeFileSync(join(root, "CLAUDE.md"), "# House rules, revised\n", "utf8");

  const output = cli(root, "run", "ttl-cache");

  assert.match(output, /uncommitted changes/);
  assert.match(output, /committed version/);
  assert.match(output, /!\s+CLAUDE\.md/);
});

test("run without a config points at init", () => {
  const root = tempDir("harnessbench-run-bare-");
  git(root, "init", "--quiet", "-b", "main");

  const { status, stderr } = fails(root, "run", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /no \.harnessbench\/config\.json/);
  assert.match(stderr, /harnessbench init/);
});

test("run with an unknown fixture lists the ones that exist", () => {
  const { status, stderr } = fails(repo(), "run", "nope");

  assert.equal(status, 1);
  assert.match(stderr, /unknown fixture 'nope'/);
  assert.match(stderr, /available fixtures:/);
  assert.match(stderr, /ttl-cache/);
});

test("run with a missing base branch names it", () => {
  const { status, stderr } = fails(repo(), "run", "ttl-cache", "--base", "release/4.2");

  assert.equal(status, 1);
  assert.match(stderr, /base branch 'release\/4\.2' not found/);
});

test("run needs a fixture id", () => {
  const { status, stderr } = fails(repo(), "run");

  assert.equal(status, 2);
  assert.match(stderr, /run needs a fixture id/);
});
