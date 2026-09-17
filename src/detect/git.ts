import { execFileSync } from "node:child_process";

import type { Detection } from "./types.js";

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const ORIGIN_PREFIX = "refs/remotes/origin/";

/** Runs git, returning trimmed stdout, or null if git is missing or the command fails. */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
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

  for (const name of ["main", "master"]) {
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], root) !== null) {
      return { value: name, source: `local branch ${name}` };
    }
  }

  return null;
}
