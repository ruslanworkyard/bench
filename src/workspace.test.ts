import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";

import { harnessSnapshot, type HarnessSnapshot } from "./detect/harness.js";
import { abortAll, createWorkspace, liveWorkspaces, withWorkspace, type Workspace } from "./workspace.js";

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

function write(root: string, path: string, content: string, mode?: number): void {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (mode !== undefined) chmodSync(target, mode);
}

function snapshot(root: string, ref: string): HarnessSnapshot {
  const found = harnessSnapshot(root, ref, []);
  assert.ok(found, `no commit at ${ref}`);
  return found;
}

/**
 * A host on a feature branch whose harness differs from main: CLAUDE.md edited, a hook script
 * and a rule added, a legacy rules file removed, and one unrelated code change.
 */
function hostWithBranch(): { root: string; mergeBase: string } {
  const root = host();
  write(root, "CLAUDE.md", "# House rules\n");
  write(root, ".claude/legacy.md", "old rule\n");
  write(root, ".claude/hooks/lint.sh", "#!/bin/sh\necho lint\n", 0o755);
  write(root, "src/app.txt", "code\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "harness on main");
  const mergeBase = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "--quiet", "-b", "feature");
  write(root, "CLAUDE.md", "# House rules, revised\n");
  write(root, ".claude/rules/new.md", "new rule\n");
  write(root, ".claude/hooks/lint.sh", "#!/bin/sh\necho lint harder\n", 0o755);
  rmSync(join(root, ".claude", "legacy.md"));
  write(root, "src/app.txt", "code, changed on the branch\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "harness on the branch");
  return { root, mergeBase };
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

/** A sleep duration no other process — another copy of this suite included — will be using. */
function sleeping(marker: number): string {
  return `sleep ${marker}.${process.pid}`;
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

test("two workspaces with the same run id get different directories", async () => {
  const root = host();
  const runId = `test-${process.pid}-${runIds++}`;

  const first = await createWorkspace({ repoRoot: root, ref: "main", runId });
  workspaces.push(first);
  const second = await createWorkspace({ repoRoot: root, ref: "main", runId });
  workspaces.push(second);

  assert.notEqual(first.dir, second.dir);
  assert.equal(dirname(first.dir), dirname(second.dir));
  for (const ws of [first, second]) {
    assert.equal(basename(ws.dir).startsWith(`${runId}-`), true, ws.dir);
    assert.equal(existsSync(join(ws.tree, "file.txt")), true);
  }
});

test("a command sees a TMPDIR of its own, inside the workspace", async () => {
  const ws = await workspace(host(), "main");

  const seen = await output(ws, 'echo "tmpdir=$TMPDIR"; echo "tmp=$TMP"; echo "temp=$TEMP"');

  for (const line of ["tmpdir", "tmp", "temp"]) {
    assert.match(seen, new RegExp(`^${line}=${ws.tmp}$`, "m"));
  }
  assert.equal(ws.tmp, join(ws.dir, "tmp"));
  assert.equal(existsSync(ws.tmp), true);
  // A file the command leaves there is inside the workspace, and goes with it.
  await output(ws, 'printf scratch > "$TMPDIR/note.txt"');
  assert.equal(readFileSync(join(ws.tmp, "note.txt"), "utf8"), "scratch");
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

  const result = await ws.exec(`${sleeping(3133)} & wait`, { timeoutMs: 500 });

  assert.equal(result.timedOut, true);
  assert.equal(running(sleeping(3133)), false);
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

test("overlayHarness puts the merge-base harness on the branch's code, touching nothing else", async () => {
  const { root, mergeBase } = hostWithBranch();
  const head = snapshot(root, "HEAD");
  const previous = snapshot(root, mergeBase);
  const hostRefs = git(root, "for-each-ref");
  const hostStatus = git(root, "status", "--porcelain");
  const ws = await workspace(root, "feature");
  mkdirSync(join(ws.tree, ".harnessbench"), { recursive: true });
  writeFileSync(join(ws.tree, ".harnessbench", "ours.txt"), "state\n");

  await ws.overlayHarness(root, head, previous);

  assert.equal(readFileSync(join(ws.tree, "CLAUDE.md"), "utf8"), "# House rules\n");
  assert.equal(existsSync(join(ws.tree, ".claude", "rules")), false, "candidate-only file and its directory");
  assert.equal(readFileSync(join(ws.tree, ".claude", "legacy.md"), "utf8"), "old rule\n");
  assert.equal(readFileSync(join(ws.tree, ".claude", "hooks", "lint.sh"), "utf8"), "#!/bin/sh\necho lint\n");
  assert.ok(statSync(join(ws.tree, ".claude", "hooks", "lint.sh")).mode & 0o100, "executable bit kept");
  assert.equal(readFileSync(join(ws.tree, "src", "app.txt"), "utf8"), "code, changed on the branch\n");
  assert.equal(readFileSync(join(ws.tree, ".harnessbench", "ours.txt"), "utf8"), "state\n");

  // Untrimmed: a status code can start with a space.
  const changed = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).harnessbench"],
    { cwd: ws.tree, env: GIT_ENV, encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3))
    .sort();
  assert.deepEqual(changed, [".claude/hooks/lint.sh", ".claude/legacy.md", ".claude/rules/new.md", "CLAUDE.md"]);

  // The host is only read.
  assert.equal(git(root, "for-each-ref"), hostRefs);
  assert.equal(git(root, "status", "--porcelain"), hostStatus);
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# House rules, revised\n");
});

test("overlayHarness with the same harness on both sides changes nothing", async () => {
  const { root } = hostWithBranch();
  const head = snapshot(root, "HEAD");
  const ws = await workspace(root, "feature");

  await ws.overlayHarness(root, head, head);

  assert.equal(git(ws.tree, "status", "--porcelain"), "");
});

test("rebaseline leaves one clean commit, so diff sees only what comes after", async () => {
  const { root, mergeBase } = hostWithBranch();
  const ws = await workspace(root, "feature");
  await ws.overlayHarness(root, snapshot(root, "HEAD"), snapshot(root, mergeBase));

  await ws.rebaseline();

  assert.equal(git(ws.tree, "status", "--porcelain"), "");
  assert.equal(git(ws.tree, "rev-list", "--count", "HEAD"), "1");
  assert.equal(git(ws.tree, "log", "-1", "--format=%s"), "harness on the branch");
  assert.equal(await ws.diff(), "");
  assert.equal(git(ws.tree, "show", "HEAD:CLAUDE.md"), "# House rules");

  writeFileSync(join(ws.tree, "src", "app.txt"), "agent edit\n");
  const diff = await ws.diff();
  assert.match(diff, /^\+\+\+ b\/src\/app\.txt$/m);
  assert.doesNotMatch(diff, /CLAUDE\.md/);
});

test("abortAll kills every running command's group and removes the live workspaces", async () => {
  const ws = await workspace(host(), "main");
  const command = ws.exec(`${sleeping(3139)} & wait`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(liveWorkspaces() >= 1);

  const paths = abortAll({ keep: false });

  assert.ok(paths.includes(ws.dir), paths.join(", "));
  assert.equal(existsSync(ws.dir), false);
  assert.equal(liveWorkspaces(), 0);
  const result = await command;
  assert.equal(result.exitCode, null);
  assert.equal(running(sleeping(3139)), false);
});

test("abortAll with keep kills the commands but leaves the directories", async () => {
  const ws = await workspace(host(), "main");
  const command = ws.exec(`${sleeping(3141)} & wait`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const paths = abortAll({ keep: true });

  assert.ok(paths.includes(ws.dir), paths.join(", "));
  assert.ok(existsSync(ws.dir));
  assert.equal(liveWorkspaces(), 0);
  assert.equal((await command).exitCode, null);
  assert.equal(running(sleeping(3141)), false);
});
