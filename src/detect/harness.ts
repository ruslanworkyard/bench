import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { gitRaw } from "./git.js";

/** A harness file, with an explanation of why it is part of the harness. */
export type HarnessEntry = { path: string; source: string };

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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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

function isConventional(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "CLAUDE.md") return true; // at any depth
  if (ROOT_FILES.includes(path)) return true;
  return ROOT_DIRS.some((dir) => path.startsWith(dir));
}

/** Repo-relative paths referenced by a markdown file that exist inside the repo. */
function references(root: string, file: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    return [];
  }

  const dir = dirname(file);
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

    const absolute = resolve(root, dir === "." ? withoutAnchor : `${dir}/${withoutAnchor}`);
    const path = relative(root, absolute).split(sep).join("/");
    if (path === "" || path.startsWith("..")) continue;
    if (path.split("/").some((segment) => SKIP_DIRS.has(segment))) continue;
    if (!isFile(absolute)) continue;
    found.push(path);
  }
  return found;
}

/**
 * The harness file set: conventional paths, plus everything the markdown files
 * in the set reference, followed transitively until the set stops growing.
 */
export function harnessFiles(root: string): HarnessEntry[] {
  const all: string[] = [];
  walk(root, "", all);

  const entries = new Map<string, HarnessEntry>();
  for (const path of all.sort()) {
    if (isConventional(path)) entries.set(path, { path, source: "convention" });
  }

  const queue = [...entries.keys()].filter(isMarkdown);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const path of references(root, file)) {
      if (entries.has(path)) continue;
      entries.set(path, { path, source: `imported by ${file}` });
      if (isMarkdown(path)) queue.push(path);
    }
  }

  return [...entries.values()];
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
