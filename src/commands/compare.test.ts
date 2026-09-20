import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { Comparison } from "../compare.js";
import { CONFIG_FILE, RUNS_DIR, defaults } from "../config.js";
import { NOISE_LINE } from "../print.js";
import { writeRunRecord, type Environment, type RunRecord } from "../run-record.js";

/** Only fabricated run directories here: compare never runs an agent, and neither do its tests. */

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const roots: string[] = [];

/** An initialised repository with an empty runs directory. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-compare-")));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: ENV });
  mkdirSync(join(root, RUNS_DIR), { recursive: true });
  writeFileSync(join(root, CONFIG_FILE), `${JSON.stringify(defaults(), null, 2)}\n`, "utf8");
  return root;
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** A run record; its id follows `run`'s naming unless the patch says otherwise. */
function record(
  stamp: string,
  environment: Environment,
  patch: Partial<RunRecord> = {},
  fixture = "ttl-cache",
): RunRecord {
  const sha = environment === "previous" ? "9c21e6389abcdef0123456789abcdef01234567" : HEAD;
  return {
    schema: 2,
    runId: `${stamp}-${fixture}-${environment}`,
    fixture,
    environment,
    headSha: HEAD,
    baseBranch: "main",
    harness: { ref: sha, sha, files: ["CLAUDE.md"], hash: `${environment}-hash` },
    agent: { name: "claude-code", command: "claude", model: "claude-sonnet-4-5" },
    outcome: "completed",
    exitCode: 0,
    setup: null,
    startedAt: "2026-09-19T03:14:55.000Z",
    finishedAt: "2026-09-19T03:19:07.000Z",
    tokens: { input: 1000, output: 20000, cacheRead: 400000, cacheWrite: 10000 },
    costUsd: 0.4,
    durationMs: 240000,
    turns: environment === "previous" ? 30 : 20,
    toolCalls: { Read: 20, Edit: 10 },
    toolFailures: 2,
    diff: { files: 5, added: 200, removed: 20 },
    tests: { command: "npm test", exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: "done",
    ...patch,
  };
}

/** Writes the record's run directory and returns its id. */
function write(root: string, r: RunRecord): string {
  const dir = join(root, RUNS_DIR, r.runId);
  mkdirSync(dir, { recursive: true });
  writeRunRecord(dir, r);
  return r.runId;
}

/** A complete pair from one `run` invocation; returns both ids. */
function writePair(root: string, stamp: string, fixture = "ttl-cache"): [string, string] {
  return [
    write(root, record(stamp, "previous", {}, fixture)),
    write(root, record(stamp, "candidate", {}, fixture)),
  ];
}

type Outcome = { status: number; stdout: string; stderr: string };

function cli(cwd: string, ...args: string[]): Outcome {
  const result = spawnSync(process.execPath, [CLI, "compare", ...args], { cwd, env: ENV, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function ok(cwd: string, ...args: string[]): Outcome {
  const result = cli(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function fails(cwd: string, ...args: string[]): Outcome {
  const result = cli(cwd, ...args);
  assert.notEqual(result.status, 0, "expected compare to fail");
  return result;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("compare prints the delta table for two explicit run ids, in either order", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-031455");

  const { stdout } = ok(root, candidate, previous);

  assert.match(stdout, /^harnessbench compare {2}ttl-cache · code 0123456/);
  assert.match(stdout, /Harness\s+previous 9c21e63 → candidate 0123456/);
  assert.match(stdout, /Model\s+claude-sonnet-4-5/);
  assert.match(stdout, new RegExp(`Runs\\s+${previous} → ${candidate}`));
  assert.ok(stdout.includes(NOISE_LINE));
  assert.doesNotMatch(stdout, /warning:/);
  assert.match(stdout, /Turns\s+30\s+→ 20\s+-10\s+improved/);
  assert.match(stdout, /Outcome\s+completed\s+→ completed\s+unchanged/);
  assert.match(stdout, /Cost\s+\$0\.40\s+→ \$0\.40\s+unchanged/);
});

test("with --fixture, compare picks the newest invocation that has both sides", () => {
  const root = repo();
  writePair(root, "20260918-100000");
  const [previous, candidate] = writePair(root, "20260919-100000");
  // A lone, newer candidate is not a pair.
  write(root, record("20260920-100000", "candidate"));
  // Another fixture's newer pair is not this fixture's.
  writePair(root, "20260921-100000", "announcements");
  // Not a run directory at all.
  writeFileSync(join(root, RUNS_DIR, "20260922-100000-ttl-cache-previous"), "", "utf8");

  const { stdout } = ok(root, "--fixture", "ttl-cache");

  assert.match(stdout, new RegExp(`Runs\\s+${previous} → ${candidate}`));
});

test("with --fixture and no pair, compare names the fixture and suggests running it", () => {
  const root = repo();
  write(root, record("20260920-100000", "candidate"));

  const { status, stderr } = fails(root, "--fixture", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /no previous\/candidate run pair for fixture 'ttl-cache'/);
  assert.match(stderr, /harnessbench run ttl-cache/);
});

test("compare refuses two runs of the same environment, naming both", () => {
  const root = repo();
  const a = write(root, record("20260918-100000", "candidate"));
  const b = write(root, record("20260919-100000", "candidate"));

  const { status, stderr } = fails(root, a, b);

  assert.equal(status, 1);
  assert.match(stderr, /one previous and one candidate run/);
  assert.match(stderr, new RegExp(`${a} is candidate, ${b} is candidate`));
});

test("compare refuses runs of different fixtures, naming both", () => {
  const root = repo();
  const a = write(root, record("20260919-100000", "previous", {}, "ttl-cache"));
  const b = write(root, record("20260919-100000", "candidate", {}, "announcements"));

  const { stderr } = fails(root, a, b);

  assert.match(stderr, new RegExp(`runs ${a} and ${b} are of different fixtures \\(ttl-cache vs announcements\\)`));
});

test("compare refuses runs on different code, naming both", () => {
  const root = repo();
  const a = write(root, record("20260919-100000", "previous"));
  const b = write(root, record("20260919-100000", "candidate", { headSha: "fedcba9876543210fedcba9876543210fedcba98" }));

  const { stderr } = fails(root, a, b);

  assert.match(stderr, new RegExp(`runs ${a} and ${b} ran on different code \\(0123456 vs fedcba9\\)`));
});

test("compare refuses an unreadable run, naming it", () => {
  const root = repo();
  const a = write(root, record("20260919-100000", "previous"));
  const missing = "20260919-100000-ttl-cache-candidate";
  const bad = "20260919-100000-ttl-cache-candidate-bad";
  mkdirSync(join(root, RUNS_DIR, bad));
  writeFileSync(join(root, RUNS_DIR, bad, "run.json"), "{ nope", "utf8");

  assert.match(fails(root, a, missing).stderr, new RegExp(`cannot read run '${missing}': no run\\.json`));
  assert.match(fails(root, a, bad).stderr, new RegExp(`cannot read run '${bad}': .*not valid JSON`));
});

test("compare needs two ids or --fixture, and refuses --json with --markdown", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-100000");

  assert.equal(fails(root).status, 2);
  assert.match(fails(root, previous).stderr, /two run ids or none/);
  assert.match(fails(root, "--json", "--markdown", previous, candidate).stderr, /exclusive/);
});

test("compare needs a repository with a config", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-norepo-")));
  roots.push(root);
  assert.match(fails(root, "--fixture", "x").stderr, /inside a git repository/);

  const repoOnly = repo();
  rmSync(join(repoOnly, CONFIG_FILE));
  assert.match(fails(repoOnly, "--fixture", "x").stderr, /harnessbench init/);
});

test("--json prints the Comparison object; --markdown prints a table", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-031455");

  const { stdout } = ok(root, "--json", previous, candidate);
  const parsed = JSON.parse(stdout) as Comparison;
  assert.equal(parsed.fixture, "ttl-cache");
  assert.equal(parsed.headSha, HEAD);
  assert.deepEqual(parsed.previous, { runId: previous, harnessSha: "9c21e6389abcdef0123456789abcdef01234567", model: "claude-sonnet-4-5" });
  assert.deepEqual(parsed.candidate, { runId: candidate, harnessSha: HEAD, model: "claude-sonnet-4-5" });
  assert.deepEqual(parsed.warnings, []);
  const turns = parsed.rows.find((row) => row.id === "turns");
  assert.deepEqual(turns, {
    id: "turns",
    label: "Turns",
    previous: "30",
    candidate: "20",
    delta: "-10",
    classification: "improved",
  });

  const markdown = ok(root, "--markdown", previous, candidate).stdout;
  assert.match(markdown, /^### harnessbench: `ttl-cache`/);
  assert.match(markdown, /^\| Criterion \| Previous \| Candidate \| Delta \| Result \| Note \|$/m);
  assert.match(markdown, /^\| Turns \| 30 \| 20 \| -10 \| improved \| {2}\|$/m);
});

test("compare passes the record's warnings through with a warning: prefix", () => {
  const root = repo();
  const previous = write(root, record("20260919-031455", "previous", { outcome: "timeout" }));
  const candidate = write(root, record("20260919-031455", "candidate"));

  const { stdout } = ok(root, previous, candidate);

  assert.match(stdout, /^warning: previous did not complete \(timeout\)/m);
  assert.match(stdout, /Turns\s+30\s+→ 20\s+n\/a\s+previous did not complete/);
});
