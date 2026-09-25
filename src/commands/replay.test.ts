import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { CONFIG_FILE, RUNS_DIR, type Config } from "../config.js";

/**
 * A batch run with the fake agent from test/fixtures, then replayed from its events.jsonl. The
 * real `claude` is never run.
 */

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function fixture(name: string): string {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  if (name.endsWith(".sh")) chmodSync(path, 0o755);
  return path;
}

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: "test-key",
  FAKE_CLAUDE_STREAM: fixture("claude-stream.jsonl"),
  FAKE_CLAUDE_DUMP: join(tempDir("harnessbench-dump-"), "dump.txt"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "harnessbench",
  GIT_AUTHOR_EMAIL: "harnessbench@example.com",
  GIT_COMMITTER_NAME: "harnessbench",
  GIT_COMMITTER_EMAIL: "harnessbench@example.com",
};
delete ENV["GITHUB_STEP_SUMMARY"];

type Outcome = { status: number; stdout: string; stderr: string };

function cli(cwd: string, ...args: string[]): Outcome {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, env: ENV });
}

/** An initialised repository whose agent is the fake. */
function repo(): string {
  const root = tempDir("harnessbench-replay-");
  git(root, "init", "--quiet", "-b", "main");
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n", "utf8");
  assert.equal(cli(root, "init", "--test", "echo tests ok", "--agent", "claude-code").status, 0);
  const path = join(root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  config.agent = { ...config.agent, command: fixture("fake-claude.sh"), env: ["FAKE_CLAUDE_STREAM", "FAKE_CLAUDE_DUMP"] };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

function stampOf(root: string): string {
  const stamps = readdirSync(join(root, RUNS_DIR)).filter((name) => /^\d{8}-\d{6}$/.test(name));
  assert.equal(stamps.length, 1, stamps.join(", "));
  return stamps[0] as string;
}

test("replay --speed 0 prints the run's stderr lines again, then its summary", () => {
  const root = repo();
  const ran = cli(root, "run", "ttl-cache");
  assert.equal(ran.status, 0, ran.stderr);

  const replayed = cli(root, "replay", "--speed", "0");
  assert.equal(replayed.status, 0, replayed.stderr);
  // Same clocks too: each line is stamped with the event's recorded time, not the replay's.
  assert.equal(replayed.stderr, ran.stderr);
  assert.equal(replayed.stdout, ran.stdout);

  // Named by stamp, and --plain is the renderer it already uses.
  const named = cli(root, "replay", stampOf(root), "--speed=0", "--plain");
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.stderr, ran.stderr);
});

test("replay keeps the recorded spacing, divided by --speed", () => {
  const root = repo();
  assert.equal(cli(root, "run", "ttl-cache").status, 0);
  const path = join(root, RUNS_DIR, stampOf(root), "events.jsonl");
  // Stretch the recording so the batch ends at 2s: at --speed 10 that is 200ms, at 0 nothing.
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1) as string);
  writeFileSync(path, `${[...lines.slice(0, -1), JSON.stringify({ ...last, at: 2_000 })].join("\n")}\n`, "utf8");

  const timed = (...args: string[]): number => {
    const started = Date.now();
    assert.equal(cli(root, "replay", ...args).status, 0);
    return Date.now() - started;
  };
  const instant = timed("--speed", "0");
  assert.ok(timed("--speed", "10") - instant >= 150, "the spacing was replayed");
});

test("a batch without events.jsonl predates event recording, and replay says so", () => {
  const root = repo();
  assert.equal(cli(root, "run", "ttl-cache").status, 0);
  const stamp = stampOf(root);
  unlinkSync(join(root, RUNS_DIR, stamp, "events.jsonl"));

  const { status, stderr } = cli(root, "replay");
  assert.equal(status, 1);
  assert.match(stderr, new RegExp(`batch ${stamp} has no events\\.jsonl: it predates event recording`));
  assert.match(stderr, new RegExp(`harnessbench compare --stamp ${stamp}`));
});

test("replay with nothing to replay, or an unknown stamp, or a bad --speed, is refused", () => {
  const root = repo();
  const none = cli(root, "replay");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no runs in \.harnessbench\/runs - run `harnessbench run` first/);

  const unknown = cli(root, "replay", "20200101-000000");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no runs with stamp '20200101-000000'/);

  const speed = cli(root, "replay", "--speed", "fast");
  assert.equal(speed.status, 2);
  assert.match(speed.stderr, /--speed.*a number, 0 or more/);
});
