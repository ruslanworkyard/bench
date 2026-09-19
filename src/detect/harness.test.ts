import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { dirtyHarnessFiles, harnessFiles } from "./harness.js";

const roots: string[] = [];

/** A repository tree; keys are `/`-separated paths relative to the root. */
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-harness-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

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

/** A repository on `main` with a committed CLAUDE.md and one unrelated file. */
function repo(): string {
  const root = tree({ "CLAUDE.md": "# House rules\n", "src.txt": "code\n" });
  git(root, "init", "--quiet", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

function write(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content, "utf8");
}

function paths(root: string): string[] {
  return harnessFiles(root).map((entry) => entry.path);
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("conventional paths are found", () => {
  const root = tree({
    "CLAUDE.md": "",
    "packages/api/CLAUDE.md": "",
    ".claude/settings.json": "{}",
    ".claude/commands/review.md": "",
    ".mcp.json": "{}",
    "AGENTS.md": "",
    "GEMINI.md": "",
    ".cursorrules": "",
    ".cursor/rules/style.mdc": "",
    ".aider.conf.yml": "",
    "CONVENTIONS.md": "",
    "README.md": "",
    "src/index.ts": "",
  });

  assert.deepEqual(paths(root).sort(), [
    ".aider.conf.yml",
    ".claude/commands/review.md",
    ".claude/settings.json",
    ".cursor/rules/style.mdc",
    ".cursorrules",
    ".mcp.json",
    "AGENTS.md",
    "CLAUDE.md",
    "CONVENTIONS.md",
    "GEMINI.md",
    "packages/api/CLAUDE.md",
  ]);

  for (const entry of harnessFiles(root)) assert.equal(entry.source, "convention");
});

test("@imports and markdown links are followed, transitively", () => {
  const root = tree({
    "CLAUDE.md": "See @docs/style.md and [testing](docs/testing.md).\n",
    "docs/style.md": "Further: @./naming.md\n",
    "docs/naming.md": "",
    "docs/testing.md": "",
  });

  assert.deepEqual(harnessFiles(root), [
    { path: "CLAUDE.md", source: "convention" },
    { path: "docs/style.md", source: "imported by CLAUDE.md" },
    { path: "docs/testing.md", source: "imported by CLAUDE.md" },
    { path: "docs/naming.md", source: "imported by docs/style.md" },
  ]);
});

test("references that do not resolve to a repository file are ignored", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-harness-parent-")));
  roots.push(parent);
  const root = join(parent, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(parent, "outside.md"), "", "utf8");
  writeFileSync(
    join(root, "CLAUDE.md"),
    [
      "Missing: @docs/gone.md",
      "Also missing: [gone](docs/gone.md)",
      "Outside: [escape](../outside.md)",
      "Absolute: @/etc/hosts",
      "Home: @~/notes.md",
      "A URL: [site](https://example.com/page.md)",
      "An email: write to someone@example.com",
      "An anchor: [section](#heading)",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(paths(root), ["CLAUDE.md"]);
});

test("node_modules, .git and .harnessbench are skipped", () => {
  const root = tree({
    "CLAUDE.md": "Vendored: @node_modules/pkg/CLAUDE.md\n",
    "node_modules/pkg/CLAUDE.md": "",
    ".git/CLAUDE.md": "",
    ".harnessbench/fixtures/ttl-cache/CLAUDE.md": "",
  });

  assert.deepEqual(paths(root), ["CLAUDE.md"]);
});

test("a repository with no harness files", () => {
  assert.deepEqual(harnessFiles(tree({ "src/index.ts": "" })), []);
});

test("dirtyHarnessFiles only reports harness files that changed", () => {
  const root = repo();
  const harness = ["CLAUDE.md"];

  assert.deepEqual(dirtyHarnessFiles(root, harness), []);

  write(root, "src.txt", "changed code\n");
  assert.deepEqual(dirtyHarnessFiles(root, harness), []);

  write(root, "CLAUDE.md", "# House rules, revised\n");
  assert.deepEqual(dirtyHarnessFiles(root, harness), ["CLAUDE.md"]);
});

test("dirtyHarnessFiles reports untracked and renamed harness files", () => {
  const root = repo();
  mkdirSync(join(root, ".claude"), { recursive: true });
  write(root, ".claude/rules.md", "be careful\n");

  assert.deepEqual(dirtyHarnessFiles(root, [".claude/rules.md"]), [".claude/rules.md"]);

  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "rules");
  git(root, "mv", ".claude/rules.md", ".claude/guidelines.md");

  assert.deepEqual(dirtyHarnessFiles(root, [".claude/"]), [".claude/guidelines.md"]);
});

test("dirtyHarnessFiles with no harness paths asks git nothing", () => {
  const root = repo();
  write(root, "src.txt", "changed code\n");

  assert.deepEqual(dirtyHarnessFiles(root, []), []);
});
