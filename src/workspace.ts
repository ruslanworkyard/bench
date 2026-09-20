import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";

import type { HarnessSnapshot } from "./detect/harness.js";
import { CliError } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Diffs and git output are held in memory once; 64 MiB is far more than a run should produce. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** The overlay never writes here: git internals, and our own state. */
const OVERLAY_SKIP = new Set([".git", ".harnessbench"]);

export type WorkspaceOptions = {
  /** Absolute path to the repository being copied. It is only ever read. */
  repoRoot: string;
  /** A branch name, or any commit-ish (a sha, a tag) to check out detached. */
  ref: string;
  /** Names the workspace directory under $TMPDIR/harnessbench, so runs never collide. */
  runId: string;
  /** Commits to clone; 0 means the whole history, hardlinked from the host. */
  depth?: number;
};

export type ExecOptions = {
  /** Added to the fixed, minimal environment; nothing else from the host is visible. */
  env?: Record<string, string>;
  /** Written to the command's stdin. Absent means an immediately closed, empty stdin. */
  stdin?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ExecResult = {
  /** Null when the command was killed by a signal, including on timeout. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
};

/** A throwaway clone of the host repository, plus an empty HOME, for one run. */
export class Workspace {
  readonly dir: string;
  readonly tree: string;
  readonly home: string;
  readonly headSha: string;

  constructor(dir: string, headSha: string) {
    this.dir = dir;
    this.tree = join(dir, "tree");
    this.home = join(dir, "home");
    this.headSha = headSha;
  }

  /** Runs `cmd` in the tree. Output is streamed to the callbacks, never buffered. */
  exec(cmd: string, options: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", cmd], {
        cwd: this.tree,
        env: { ...runEnv(this.home), ...options.env },
        // Its own process group, so a timeout can take the whole tree of children with it.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // A command that exits without reading its input is its own business, not an error.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin ?? "");

      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, options.timeoutMs);
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      // The listeners also keep the pipes draining when a caller wants no output.
      child.stdout.on("data", (chunk: string) => options.onStdout?.(chunk));
      child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, timedOut, durationMs: Date.now() - started });
      });
    });
  }

  /**
   * Replaces the harness in the tree (`head`, as cloned) with `previous`, read from the host
   * repository at `previous.sha`: the clone is shallow, so the host is the only source. Every
   * path of `head` goes first, so a file only the candidate has does not survive; directories
   * left empty go with it. `.git/` and `.harnessbench/` are never touched, and nothing is
   * written to the host.
   */
  async overlayHarness(repoRoot: string, head: HarnessSnapshot, previous: HarnessSnapshot): Promise<void> {
    for (const path of head.files.filter(overlayable)) {
      await rm(join(this.tree, ...path.split("/")), { force: true });
      await removeEmptyParents(this.tree, path);
    }

    const files = previous.files.filter(overlayable);
    if (files.length === 0) return;
    // One ls-tree for every file's mode, then one show per file for its bytes.
    const listing = await git(["ls-tree", "-r", "-z", previous.sha, "--", ...files], repoRoot);
    for (const entry of listing.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const mode = entry.slice(0, tab).split(" ")[0];
      const path = entry.slice(tab + 1);
      const target = join(this.tree, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await gitBytes(["show", `${previous.sha}:${path}`], repoRoot));
      await chmod(target, mode === "100755" ? 0o755 : 0o644);
    }
  }

  /**
   * Folds everything currently in the tree into its one commit, so the agent finds a clean
   * checkout with a single commit either way, and `diff()` measures only what happens next.
   * The commit sha changes; `headSha` keeps naming the host commit the code came from.
   */
  async rebaseline(): Promise<void> {
    await git(["add", "-A", "--", ".", ":(exclude).harnessbench"], this.tree);
    await git(["commit", "--quiet", "--amend", "--no-edit", "--allow-empty"], this.tree);
  }

  /** Everything the run changed in the tree, tracked or not, except our own state directory. */
  async diff(): Promise<string> {
    await git(["add", "-N", "."], this.tree);
    return await git(["diff", "HEAD", "--", ".", ":(exclude).harnessbench"], this.tree);
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** Clones the host repository at `ref` into a fresh temp directory. */
export async function createWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const { repoRoot, ref, runId, depth = 1 } = options;

  // Resolved, because on macOS $TMPDIR is a symlink and a process's own cwd is not.
  const dir = join(await realpath(tmpdir()), "harnessbench", runId);
  const tree = join(dir, "tree");
  const home = join(dir, "home");
  const hooks = join(dir, "no-hooks");
  if (existsSync(dir)) {
    throw new CliError(
      `workspace ${dir} already exists (left by --keep, or a run started this second?) - ` +
        `remove it, or run again`,
    );
  }
  await mkdir(home, { recursive: true });
  await mkdir(hooks, { recursive: true });

  const branch = await localBranch(repoRoot, ref);
  await clone(repoRoot, tree, branch ?? (await currentBranch(repoRoot)), depth);
  if (branch === null) await checkoutDetached(repoRoot, tree, ref);

  // No origin: nothing the run does can reach, or write to, the host repository.
  await git(["remote", "remove", "origin"], tree);
  await git(["config", "user.name", "harnessbench"], tree);
  await git(["config", "user.email", "harnessbench@invalid"], tree);
  // An empty hooks directory, so the host's hooks never run against the clone.
  await git(["config", "core.hooksPath", hooks], tree);

  return new Workspace(dir, (await git(["rev-parse", "HEAD"], tree)).trim());
}

/** Creates a workspace, runs `fn`, and destroys it unless `keep` is set. */
export async function withWorkspace<T>(
  options: WorkspaceOptions & { keep?: boolean },
  fn: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  const workspace = await createWorkspace(options);
  try {
    return await fn(workspace);
  } finally {
    if (options.keep === true) {
      process.stderr.write(`workspace kept at ${workspace.dir}\n`);
    } else {
      await workspace.destroy();
    }
  }
}

/** A path the overlay may delete or write: not git's, not ours, and inside the tree. */
function overlayable(path: string): boolean {
  const segments = path.split("/");
  return !segments.some((segment) => OVERLAY_SKIP.has(segment) || segment === "..");
}

/** Removes the directories above `path` that its deletion left empty, stopping at the tree root. */
async function removeEmptyParents(tree: string, path: string): Promise<void> {
  for (let dir = posix.dirname(path); dir !== "." && dir !== ""; dir = posix.dirname(dir)) {
    const absolute = join(tree, ...dir.split("/"));
    try {
      if ((await readdir(absolute)).length > 0) return;
      await rmdir(absolute);
    } catch {
      return; // Already gone, or not a directory.
    }
  }
}

function runEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: "dumb",
  };
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG;
  return env;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function clone(repoRoot: string, tree: string, branch: string | null, depth: number): Promise<void> {
  const args = ["clone", "--quiet", "--single-branch", "--no-tags"];
  if (branch !== null) args.push("--branch", branch);
  if (depth > 0) {
    // file:// forces the transport that honours --depth; a plain path would be a local clone.
    args.push("--depth", String(depth), `file://${repoRoot}`);
  } else {
    args.push("--local", repoRoot);
  }
  await git([...args, tree], repoRoot);
}

/** The ref as a local branch of the host, or null when it is a sha, a tag, or unknown. */
async function localBranch(repoRoot: string, ref: string): Promise<string | null> {
  const found = await gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${ref}`], repoRoot);
  return found ? ref : null;
}

/** The branch the host has checked out, or null when its HEAD is detached. */
async function currentBranch(repoRoot: string): Promise<string | null> {
  const name = (await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim();
  return name === "HEAD" ? null : name;
}

/**
 * A shallow clone cannot `--branch` a sha, so we clone a branch and check the sha out here.
 * The sha is only in the clone if it is within `depth` of that branch's tip; when it is not,
 * the history is filled in first, which is the price of asking for an older commit.
 */
async function checkoutDetached(repoRoot: string, tree: string, ref: string): Promise<void> {
  const sha = (await git(["rev-parse", "--verify", `${ref}^{commit}`], repoRoot)).trim();
  if (!(await gitOk(["cat-file", "-e", `${sha}^{commit}`], tree))) {
    const shallow = (await git(["rev-parse", "--is-shallow-repository"], tree)).trim();
    if (shallow !== "true") {
      throw new CliError(`commit ${sha} is not reachable from the cloned branch`);
    }
    await git(["fetch", "--quiet", "--unshallow"], tree);
  }
  await git(["checkout", "--quiet", "--detach", sha], tree);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    throw new CliError(`git ${args.join(" ")}: ${gitMessage(error)}`);
  }
}

/** As `git`, with stdout as bytes: for file contents, which need not be text. */
async function gitBytes(args: string[], cwd: string): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
    throw new CliError(`git ${args.join(" ")}: ${gitMessage(error)}`);
  }
}

/** Whether git exited zero; for the questions where failure is an answer, not an error. */
async function gitOk(args: string[], cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}

function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}
