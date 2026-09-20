import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { git, gitRaw } from "./git.js";

/** A harness file, with an explanation of why it is part of the harness. */
export type HarnessEntry = { path: string; source: string };

/** Where harness detection reads from: a working tree, or a commit that is not checked out. */
export type FileSource = {
  /** Every file path, `/`-separated, relative to root. */
  list(): string[];
  /** File contents, or null when the path is not a file. */
  read(path: string): string | null;
};

/** The harness as committed at one ref: the files, and one hash over all of their contents. */
export type HarnessSnapshot = {
  /** As given: "HEAD", a branch, a sha. */
  ref: string;
  /** The commit `ref` resolved to. */
  sha: string;
  /** Sorted; only paths that exist at that commit. */
  files: string[];
  /** sha256 over `${path}\0${contents}\0` for every file, in order; equal means byte-identical. */
  hash: string;
};

/** Directories never worth walking: vendored code, git internals, our own state. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".harnessbench"]);
/** Conventional harness files, looked for at the repository root. */
const ROOT_FILES = [
  ".mcp.json",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".aider.conf.yml",
  "CONVENTIONS.md",
];
/** Conventional harness directories; every file below them counts. */
const ROOT_DIRS = [".claude/", ".cursor/rules/"];
/** `@relative/path` imports, as Claude Code resolves them. */
const IMPORT_PATTERN = /(?:^|[\s(])@([^\s()[\]<>"']+)/g;
/** `[text](relative/path)` markdown links, including image links. */
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function isSkipped(path: string): boolean {
  return path.split("/").some((segment) => SKIP_DIRS.has(segment));
}

/** Every file in the repository, as `/`-separated paths relative to root. */
function walk(root: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(rel === "" ? root : join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, path, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
}

/** The working tree under `root`. */
export function fileSystemSource(root: string): FileSource {
  return {
    list() {
      const out: string[] = [];
      walk(root, "", out);
      return out;
    },
    read(path) {
      try {
        return readFileSync(join(root, ...path.split("/")), "utf8"); // EISDIR for a directory.
      } catch {
        return null;
      }
    },
  };
}

/**
 * The tree committed at `ref`, read through git without checking it out. Only regular files
 * count, as in the working tree walk: a symlink is a path, not a file with contents.
 */
export function gitSource(root: string, ref: string): FileSource {
  let files: Set<string> | undefined;
  const list = (): Set<string> => {
    if (files === undefined) {
      files = new Set<string>();
      // -z keeps paths verbatim. Each entry is `<mode> <type> <sha>\t<path>`.
      const output = gitRaw(["ls-tree", "-r", "-z", ref], root) ?? "";
      for (const entry of output.split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab === -1) continue;
        const [mode, type] = entry.slice(0, tab).split(" ");
        if (type === "blob" && mode?.startsWith("100")) files.add(entry.slice(tab + 1));
      }
    }
    return files;
  };
  return {
    list: () => [...list()],
    read: (path) => (list().has(path) ? gitRaw(["show", `${ref}:${path}`], root) : null),
  };
}

function isConventional(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "CLAUDE.md") return true; // at any depth
  if (ROOT_FILES.includes(path)) return true;
  return ROOT_DIRS.some((dir) => path.startsWith(dir));
}

/** Repo-relative paths referenced by a markdown file that are files of the repository. */
function references(source: FileSource, exists: Set<string>, file: string): string[] {
  const text = source.read(file);
  if (text === null) return [];

  const dir = posix.dirname(file);
  const targets = [
    ...[...text.matchAll(IMPORT_PATTERN)].map((match) => match[1]),
    ...[...text.matchAll(LINK_PATTERN)].map((match) => match[1]),
  ];

  const found: string[] = [];
  for (const target of targets) {
    if (target === undefined) continue;
    const [withoutAnchor] = target.split("#");
    if (withoutAnchor === undefined || withoutAnchor === "") continue;
    // Absolute paths, home-relative paths and URLs are not repository files.
    if (withoutAnchor.startsWith("/") || withoutAnchor.startsWith("~")) continue;
    if (URL_PATTERN.test(withoutAnchor)) continue;

    const path = posix.normalize(posix.join(dir, withoutAnchor));
    if (path === "." || path === ".." || path.startsWith("../")) continue;
    if (!exists.has(path)) continue;
    found.push(path);
  }
  return found;
}

/**
 * The harness file set: conventional paths, plus everything the markdown files
 * in the set reference, followed transitively until the set stops growing.
 * Given a root, reads the working tree; given a source, reads whatever it is.
 */
export function harnessFiles(rootOrSource: string | FileSource): HarnessEntry[] {
  const source = typeof rootOrSource === "string" ? fileSystemSource(rootOrSource) : rootOrSource;
  const all = source.list().filter((path) => !isSkipped(path)).sort();
  const exists = new Set(all);

  const entries = new Map<string, HarnessEntry>();
  for (const path of all) {
    if (isConventional(path)) entries.set(path, { path, source: "convention" });
  }

  const queue = [...entries.keys()].filter(isMarkdown);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const path of references(source, exists, file)) {
      if (entries.has(path)) continue;
      entries.set(path, { path, source: `imported by ${file}` });
      if (isMarkdown(path)) queue.push(path);
    }
  }

  return [...entries.values()];
}

/** The harness as committed at `ref`, without checking it out. */
export function harnessFilesAt(root: string, ref: string): HarnessEntry[] {
  return harnessFiles(gitSource(root, ref));
}

/**
 * The harness at `ref` plus `extraPaths` (files, or directories taken whole), with one hash
 * over all of it. Extra paths that do not exist at the ref are skipped. Null when `ref` is
 * not a commit.
 */
export function harnessSnapshot(
  root: string,
  ref: string,
  extraPaths: readonly string[],
): HarnessSnapshot | null {
  const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  if (sha === null || sha === "") return null;

  const source = gitSource(root, sha);
  const all = source.list().filter((path) => !isSkipped(path));
  const files = new Set(harnessFiles(source).map((entry) => entry.path));
  for (const extra of extraPaths) {
    const dir = `${extra.replace(/\/+$/, "")}/`;
    for (const path of all) {
      if (path === extra || path.startsWith(dir)) files.add(path);
    }
  }

  const sorted = [...files].sort();
  const hash = createHash("sha256");
  for (const path of sorted) {
    hash.update(path);
    hash.update("\0");
    hash.update(source.read(path) ?? "");
    hash.update("\0");
  }
  return { ref, sha, files: sorted, hash: hash.digest("hex") };
}

/** Harness files with uncommitted changes. Callers decide whether that matters. */
export function dirtyHarnessFiles(root: string, harnessPaths: readonly string[]): string[] {
  if (harnessPaths.length === 0) return [];
  // -z keeps paths verbatim: no quoting, no escaping, no ambiguity about spaces.
  // Raw, because a status code can start with a space that slicing depends on.
  const output = gitRaw(["status", "--porcelain", "-z", "--", ...harnessPaths], root);
  if (output === null) return [];

  const entries = output.split("\0").filter((entry) => entry !== "");
  const dirty: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string;
    dirty.push(entry.slice(3));
    // A rename or copy is followed by its origin path, which is not a change of its own.
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return dirty.sort();
}
