import { execFileSync } from "node:child_process";

import type { Detection } from "./types.js";

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const ORIGIN_PREFIX = "refs/remotes/origin/";

/** Runs git, returning stdout verbatim, or null if git is missing or the command fails. */
export function gitRaw(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Runs git, returning trimmed stdout, or null if git is missing or the command fails. */
export function git(args: string[], cwd: string): string | null {
  return gitRaw(args, cwd)?.trim() ?? null;
}

/** The work tree root containing cwd, or null when cwd is not in a git repository. */
export function repoRoot(cwd: string): string | null {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  return root === null || root === "" ? null : root;
}

/** The branch a run should compare against: origin/HEAD, then main, then master. */
export function baseBranch(root: string): Detection<string> | null {
  const head = git(["symbolic-ref", "--quiet", ORIGIN_HEAD], root);
  if (head !== null && head.startsWith(ORIGIN_PREFIX)) {
    const name = head.slice(ORIGIN_PREFIX.length);
    if (name !== "") return { value: name, source: "origin/HEAD" };
  }

  // A repository with no commits yet still has a branch name, on an unborn HEAD.
  const current = git(["symbolic-ref", "--quiet", "HEAD"], root);
  for (const name of ["main", "master"]) {
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], root) !== null) {
      return { value: name, source: `local branch ${name}` };
    }
    if (current === `refs/heads/${name}`) {
      return { value: name, source: `current branch ${name} (no commits yet)` };
    }
  }

  return null;
}
