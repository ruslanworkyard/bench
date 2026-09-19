import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createWorkspace, withWorkspace, type Workspace } from "./workspace.js";

const hosts: string[] = [];
const workspaces: Workspace[] = [];
let runIds = 0;

/** Isolated from the user's git config, so init.defaultBranch cannot change results. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "harnessbench",
  GIT_AUTHOR_EMAIL: "harnessbench@example.com",
  GIT_COMMITTER_NAME: "harnessbench",
  GIT_COMMITTER_EMAIL: "harnessbench@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

/** A repository on `main` with `commits` commits, each touching file.txt. */
function host(commits = 1): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-host-")));
  hosts.push(root);
  git(root, "init", "--quiet", "-b", "main");
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(root, "file.txt"), `version ${i}\n`);
    git(root, "add", "file.txt");
    git(root, "commit", "--quiet", "-m", `commit ${i}`);
  }
  return root;
}

async function workspace(repoRoot: string, ref: string, depth?: number): Promise<Workspace> {
  const created = await createWorkspace({
    repoRoot,
    ref,
    runId: `test-${process.pid}-${runIds++}`,
    ...(depth === undefined ? {} : { depth }),
  });
  workspaces.push(created);
  return created;
}

/** Collects everything the command writes to stdout. */
async function output(ws: Workspace, cmd: string): Promise<string> {
  let stdout = "";
  const result = await ws.exec(cmd, { onStdout: (chunk) => (stdout += chunk) });
  assert.equal(result.exitCode, 0, stdout);
  return stdout;
}

function running(pattern: string): boolean {
  try {
    execFileSync("pgrep", ["-f", pattern], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  for (const ws of workspaces) await ws.destroy();
  for (const root of hosts) rmSync(root, { recursive: true, force: true });
});

test("a shallow clone of HEAD, with the host left alone", async () => {
  const root = host(3);
  const refsBefore = git(root, "for-each-ref");

  const ws = await workspace(root, "main");

  assert.equal(existsSync(join(ws.tree, "file.txt")), true);
  assert.equal(existsSync(ws.home), true);
  assert.equal(ws.headSha, git(root, "rev-parse", "HEAD"));
  assert.equal(git(ws.tree, "remote", "-v"), "");
  assert.equal(git(ws.tree, "rev-list", "--count", "HEAD"), "1");

  assert.equal(git(root, "for-each-ref"), refsBefore);
  assert.equal(existsSync(join(root, ".git", "worktrees")), false);
  assert.equal(git(root, "worktree", "list").split("\n").length, 1);
});

test("depth 0 clones the whole history", async () => {
  const ws = await workspace(host(3), "main", 0);
  assert.equal(git(ws.tree, "rev-list", "--count", "HEAD"), "3");
});

test("an older sha is checked out detached", async () => {
  const root = host(3);
  const old = git(root, "rev-parse", "HEAD~2");

  const ws = await workspace(root, old);

  assert.equal(ws.headSha, old);
  assert.equal(git(ws.tree, "rev-parse", "HEAD"), old);
  assert.equal(readFileSync(join(ws.tree, "file.txt"), "utf8"), "version 1\n");
  assert.equal(git(ws.tree, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
});

test("exec propagates the exit code and hides the host environment", async () => {
  const ws = await workspace(host(), "main");

  const failed = await ws.exec("exit 3");
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.timedOut, false);

  process.env.HARNESSBENCH_LEAK = "leaked";
  const seen = await output(ws, 'echo "home=$HOME"; echo "leak=${HARNESSBENCH_LEAK-unset}"');
  delete process.env.HARNESSBENCH_LEAK;

  assert.match(seen, new RegExp(`^home=${ws.home}$`, "m"));
  assert.match(seen, /^leak=unset$/m);
  assert.notEqual(ws.home, process.env.HOME);
});

test("a timeout kills the whole process group", async () => {
  const ws = await workspace(host(), "main");

  const result = await ws.exec("sleep 3133 & wait", { timeoutMs: 500 });

  assert.equal(result.timedOut, true);
  assert.equal(running("sleep 3133"), false);
  assert.ok(result.durationMs < 10_000, `took ${result.durationMs}ms`);
});

test("diff covers tracked and untracked changes, but not .harnessbench", async () => {
  const ws = await workspace(host(), "main");
  writeFileSync(join(ws.tree, "file.txt"), "edited\n");
  writeFileSync(join(ws.tree, "added.txt"), "new\n");
  mkdirSync(join(ws.tree, ".harnessbench"), { recursive: true });
  writeFileSync(join(ws.tree, ".harnessbench", "notes.md"), "ours\n");

  const diff = await ws.diff();

  assert.match(diff, /^\+\+\+ b\/file\.txt$/m);
  assert.match(diff, /^\+\+\+ b\/added\.txt$/m);
  assert.doesNotMatch(diff, /harnessbench/);
});

test("destroy removes the directory and is idempotent", async () => {
  const ws = await workspace(host(), "main");
  await ws.destroy();
  assert.equal(existsSync(ws.dir), false);
  await ws.destroy();
});

test("withWorkspace destroys even when fn throws", async () => {
  let dir = "";
  await assert.rejects(
    withWorkspace({ repoRoot: host(), ref: "main", runId: `test-${process.pid}-${runIds++}` }, async (ws) => {
      dir = ws.dir;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.notEqual(dir, "");
  assert.equal(existsSync(dir), false);
});
