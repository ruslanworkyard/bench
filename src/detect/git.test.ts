import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { baseBranch, repoRoot } from "./git.js";

const roots: string[] = [];

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

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, env: GIT_ENV, stdio: "ignore" });
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-git-")));
  roots.push(dir);
  return dir;
}

/** A repository whose initial branch is `branch`, with one empty commit. */
function repo(branch: string): string {
  const root = tempDir();
  git(root, "init", "--quiet", "-b", branch);
  git(root, "commit", "--allow-empty", "--quiet", "-m", "initial");
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("repoRoot finds the work tree, and is null outside one", () => {
  const root = repo("main");
  assert.equal(repoRoot(root), root);
  assert.equal(repoRoot(tempDir()), null);
});

test("origin/HEAD is preferred over local branches", () => {
  const root = repo("main");
  git(root, "branch", "master");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  assert.deepEqual(baseBranch(root), { value: "develop", source: "origin/HEAD" });
});

test("main is preferred over master", () => {
  const root = repo("main");
  git(root, "branch", "master");
  assert.deepEqual(baseBranch(root), { value: "main", source: "local branch main" });
});

test("master is used when there is no main", () => {
  const root = repo("master");
  assert.deepEqual(baseBranch(root), { value: "master", source: "local branch master" });
});

test("a repository with no commits still reports its branch", () => {
  const root = tempDir();
  git(root, "init", "--quiet", "-b", "main");
  assert.deepEqual(baseBranch(root), {
    value: "main",
    source: "current branch main (no commits yet)",
  });
});

test("neither main nor master", () => {
  assert.equal(baseBranch(repo("trunk")), null);
  const unborn = tempDir();
  git(unborn, "init", "--quiet", "-b", "trunk");
  assert.equal(baseBranch(unborn), null);
});
