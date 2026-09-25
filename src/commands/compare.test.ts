import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { Comparison } from "../compare.js";
import { CONFIG_FILE, JUDGES_DIR, RUNS_DIR, defaults } from "../config.js";
import { listJudges, packagedJudgesDir } from "../judges.js";
import * as print from "../print.js";
import type { BatchReport } from "../report.js";
import { RUN_ID, listBatches, writeRunRecord, type Environment, type RunRecord } from "../run-record.js";
import { latestPair } from "./compare.js";
import type { JudgeRecord, VerdictRecord } from "./judge.js";

/** Only fabricated run directories here: compare never runs an agent, and neither do its tests. */

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
// The suite may itself run under GitHub Actions; only the test that means to may append to a step summary.
delete ENV["GITHUB_STEP_SUMMARY"];

const roots: string[] = [];

/** An initialised repository with an empty runs directory: the default config and the packaged judges. */
function repo(judges = defaults().judges): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-compare-")));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: ENV });
  mkdirSync(join(root, RUNS_DIR), { recursive: true });
  writeFileSync(join(root, CONFIG_FILE), `${JSON.stringify({ ...defaults(), judges }, null, 2)}\n`, "utf8");
  cpSync(packagedJudgesDir(), join(root, JUDGES_DIR), { recursive: true });
  return root;
}

/** A verdict as `judge` would have written it for the catalogue in `root`; a judge not in the catalogue gets `patch`'s title and hash. */
function verdict(root: string, id: string, patch: Partial<VerdictRecord> = {}): VerdictRecord {
  const judge = listJudges(root).find((each) => each.meta.id === id);
  return {
    judge: id,
    title: judge?.meta.title ?? id,
    preference: "candidate",
    reason: `${id} reason`,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: { input: 100, output: 20, reasoning: null },
    upstream: null,
    durationMs: 12000,
    attempts: 1,
    rubricHash: judge?.hash ?? "no-such-judge",
    ...patch,
  };
}

/** Writes a `-judge` directory named by `stamp` whose judge.json names the given pair. */
function writeJudge(root: string, stamp: string, previous: string, candidate: string, verdicts: VerdictRecord[], fixture = "ttl-cache"): string {
  const name = `${stamp}-${fixture}-judge`;
  const record: JudgeRecord = {
    schema: 1,
    fixture,
    headSha: HEAD,
    previous: { runId: previous },
    candidate: { runId: candidate },
    mapping: { A: "previous", B: "candidate" },
    verdicts,
  };
  mkdirSync(join(root, RUNS_DIR, name), { recursive: true });
  writeFileSync(join(root, RUNS_DIR, name, "judge.json"), JSON.stringify(record), "utf8");
  return name;
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
    tests: { state: "passed", command: "npm test", files: [], exitCode: 0, durationMs: 12000, timedOut: false },
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
  return cliWith(ENV, cwd, ...args);
}

function cliWith(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Outcome {
  const result = spawnSync(process.execPath, [CLI, "compare", ...args], { cwd, env, encoding: "utf8" });
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

/** The report `--json` prints. */
function reportOf(cwd: string, ...args: string[]): BatchReport {
  return JSON.parse(ok(cwd, "--json", ...args).stdout) as BatchReport;
}

/** One fixture's comparison in a report; fails the test when it has none. */
function comparisonOf(report: BatchReport, fixture = "ttl-cache"): Comparison {
  const found = report.fixtures.find((each) => each.fixture === fixture)?.comparison;
  assert.ok(found, `no comparison for ${fixture}`);
  return found;
}

function readReport(root: string, stamp: string, name: "report.md" | "report.json"): string {
  return readFileSync(join(root, RUNS_DIR, stamp, name), "utf8");
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("compare prints the summary for two explicit run ids, in either order, and writes the batch's report", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-031455");

  const { stdout } = ok(root, candidate, previous);

  assert.deepEqual(stdout.split("\n"), [
    "harnessbench  1 fixture · code 0123456 · previous 9c21e63 → candidate 0123456 · claude-sonnet-4-5",
    "",
    "Outcome     unchanged 1",
    "Efficiency  improved: Turns 1",
    "Judges      candidate 0 · previous 0 · tie 0 · not judged 3",
    "",
    "ttl-cache  code quality not judged · engineering practices not judged · test quality not judged",
    "",
    "report  .harnessbench/runs/20260919-031455/report.md",
    "",
  ]);
  assert.ok(existsSync(join(root, RUNS_DIR, "20260919-031455", "report.md")));

  const comparison = comparisonOf(reportOf(root, candidate, previous));
  assert.deepEqual([comparison.previous.runId, comparison.candidate.runId], [previous, candidate]);
  assert.deepEqual(comparison.rows.find((row) => row.id === "turns"), {
    id: "turns",
    label: "Turns",
    previous: "30",
    candidate: "20",
    delta: "-10",
    classification: "improved",
  });
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

  const comparison = comparisonOf(reportOf(root, "--fixture", "ttl-cache"));

  assert.deepEqual([comparison.previous.runId, comparison.candidate.runId], [previous, candidate]);
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

test("compare takes two ids or none, one way of addressing at a time, and refuses --json with --markdown or --detail", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-100000");

  assert.match(fails(root, previous).stderr, /two run ids or none/);
  assert.match(fails(root, "--json", "--markdown", previous, candidate).stderr, /exclusive/);
  assert.match(fails(root, "--json", "--detail", previous, candidate).stderr, /--json and --detail are exclusive/);
  assert.match(fails(root, "--fixture", "ttl-cache", "--stamp", "20260919-100000").stderr, /--fixture and --stamp are exclusive/);
  assert.match(fails(root, previous, candidate, "--stamp", "20260919-100000").stderr, /two run ids and --stamp are exclusive/);
});

// --- batches ---

/** Two complete pairs (older), then a batch with one complete pair and one lone side (newer), then a lone candidate (newest). */
function batches(root: string): { older: string; newer: string; newest: string } {
  const older = "20260920-100000";
  writePair(root, older, "announcements");
  writePair(root, older, "ttl-cache");
  const newer = "20260921-100000";
  writePair(root, newer, "ttl-cache");
  write(root, record(newer, "previous", {}, "announcements"));
  const newest = "20260922-100000";
  write(root, record(newest, "candidate"));
  return { older, newer, newest };
}

test("bare compare addresses the latest batch with a complete pair, and lists its incomplete pairs", () => {
  const root = repo();
  const { newer } = batches(root);

  const report = reportOf(root);
  assert.equal(report.stamp, newer);
  assert.deepEqual(report.fixtures.map((each) => [each.fixture, each.error]), [
    ["announcements", "announcements: candidate side missing"],
    ["ttl-cache", null],
  ]);
  assert.equal(comparisonOf(report).previous.runId, `${newer}-ttl-cache-previous`);
  assert.deepEqual(report.rollup.rows.find((row) => row.id === "turns")?.improved, ["ttl-cache"]);

  const { stdout } = ok(root);
  assert.match(stdout, /^harnessbench {2}2 fixtures · code 0123456/);
  assert.match(stdout, /^Outcome {5}unchanged 1$/m);
  assert.match(stdout, /^announcements {2}error: announcements: candidate side missing$/m);
  assert.match(stdout, /^ttl-cache {6}code quality not judged/m);
  assert.match(stdout, new RegExp(`^report  \\.harnessbench/runs/${newer}/report\\.md$`, "m"));
});

test("--stamp addresses that batch; an unknown stamp lists the ones there are; a batch with no complete pair says what is missing", () => {
  const root = repo();
  const { older, newer, newest } = batches(root);

  const report = reportOf(root, "--stamp", older);
  assert.equal(report.stamp, older);
  assert.deepEqual(report.fixtures.map((each) => [each.fixture, each.error]), [
    ["announcements", null],
    ["ttl-cache", null],
  ]);
  assert.deepEqual(report.rollup.rows.find((row) => row.id === "turns")?.improved, ["announcements", "ttl-cache"]);
  assert.equal(comparisonOf(report, "announcements").previous.runId, `${older}-announcements-previous`);
  assert.doesNotMatch(ok(root, "--stamp", older).stdout, /error:/);

  const unknown = fails(root, "--stamp", "20260101-000000");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, new RegExp(`no runs with stamp '20260101-000000'\\n\\nstamps in \\.harnessbench/runs:\\n\\s+${newest}\\n\\s+${newer}\\n\\s+${older}`));

  const incomplete = fails(root, "--stamp", newest);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, new RegExp(`batch ${newest} has no complete previous/candidate pair:\\n\\s+ttl-cache: previous side missing`));
});

test("a batch side whose run.json cannot be read is listed as unreadable, not dropped", () => {
  const root = repo();
  const stamp = "20260920-100000";
  writePair(root, stamp, "ttl-cache");
  const [previous] = writePair(root, stamp, "announcements");
  writeFileSync(join(root, RUNS_DIR, previous, "run.json"), "{ nope", "utf8");

  const { stdout } = ok(root);

  assert.match(stdout, /^announcements {2}error: announcements: previous side unreadable \(no valid run\.json\)$/m);
  assert.match(stdout, /^ttl-cache {6}code quality not judged/m);
});

test("bare compare with no runs, or none complete, says so and points at run", () => {
  const empty = repo();
  const none = fails(empty);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no runs in \.harnessbench\/runs - run `harnessbench run` first/);

  write(empty, record("20260920-100000", "candidate"));
  assert.match(fails(empty).stderr, /no complete previous\/candidate pair in \.harnessbench\/runs/);
});

test("--fixture still picks the latest pair of that fixture, not the latest batch", () => {
  const root = repo();
  const { older } = batches(root);

  const report = reportOf(root, "--fixture", "announcements");

  assert.equal(report.stamp, older);
  assert.deepEqual(report.fixtures.map((each) => each.fixture), ["announcements"]);
  assert.equal(comparisonOf(report, "announcements").previous.runId, `${older}-announcements-previous`);
});

test("batch --json is the report, exactly as report.json holds it; --markdown and --detail print report.md", () => {
  const root = repo(["code-quality"]);
  const { older } = batches(root);
  const [previous, candidate] = [`${older}-ttl-cache-previous`, `${older}-ttl-cache-candidate`];
  writeJudge(root, older, previous, candidate, [verdict(root, "code-quality", { reason: "B is tidier." })]);

  const { stdout } = ok(root, "--json", "--stamp", older);
  assert.equal(stdout, readReport(root, older, "report.json"));
  const parsed = JSON.parse(stdout) as BatchReport;
  assert.deepEqual(Object.keys(parsed), ["schema", "stamp", "headSha", "harness", "agent", "judge", "rollup", "fixtures"]);
  assert.equal(parsed.stamp, older);
  assert.deepEqual(parsed.harness, { previous: "9c21e6389abcdef0123456789abcdef01234567", candidate: HEAD });
  assert.deepEqual(parsed.agent, { name: "claude-code", model: "claude-sonnet-4-5" });
  assert.deepEqual(parsed.judge, { provider: "anthropic", model: "claude-sonnet-4-5" });
  assert.deepEqual(parsed.fixtures.map((each) => [each.fixture, each.error, Object.keys(each)]), [
    ["announcements", null, ["fixture", "comparison", "sides", "error"]],
    ["ttl-cache", null, ["fixture", "comparison", "sides", "error"]],
  ]);
  assert.equal(parsed.fixtures[1]?.sides.candidate?.runId, candidate);
  assert.equal(parsed.fixtures[1]?.sides.candidate?.runDir, `${RUNS_DIR}/${candidate}`);
  const judged = parsed.rollup.rows.find((row) => row.id === "judge.code-quality");
  assert.deepEqual(judged, { id: "judge.code-quality", label: "Code quality", improved: ["ttl-cache"], regressed: [], unchanged: [], na: ["announcements"] });

  const markdown = ok(root, "--markdown", "--stamp", older).stdout;
  assert.equal(ok(root, "--detail", "--stamp", older).stdout, markdown);
  assert.equal(markdown, readReport(root, older, "report.md"));
  assert.match(markdown, /^### harnessbench {2}2 fixtures · code 0123456/);
  assert.match(markdown, /^- \*\*Judges\*\* candidate 1 · previous 0 · tie 0 · not judged 1$/m);
  assert.match(markdown, /^\| Criterion \| Improved \| Regressed \| Unchanged \| n\/a \|$/m);
  assert.match(markdown, /^\| Turns \| announcements, ttl-cache \|  \|  \|  \|$/m);
  assert.match(markdown, /^\| Code quality \| ttl-cache \|  \|  \| announcements \|$/m);
  assert.match(markdown, /<details><summary>announcements: code quality not judged<\/summary>\n\n### harnessbench: `announcements`/);
  assert.match(markdown, /<details><summary>ttl-cache: code quality candidate<\/summary>\n\n### harnessbench: `ttl-cache`[\s\S]*\| Code quality \|  \|  \| candidate preferred \| improved \| B is tidier\. \(judged in 12s\) \|\n/);
  assert.match(markdown, /\*\*candidate\*\* final message:\n\n> done\n[\s\S]*<\/details>\n$/);
});

test("compare rewrites the batch's report files, addressed by stamp or by one of its pairs, so they carry the latest verdicts", () => {
  const root = repo(["code-quality"]);
  const stamp = "20260920-100000";
  writePair(root, stamp, "announcements");
  const [previous, candidate] = writePair(root, stamp, "ttl-cache");

  ok(root, "--stamp", stamp);
  assert.equal((JSON.parse(readReport(root, stamp, "report.json")) as BatchReport).judge, null);

  writeJudge(root, stamp, previous, candidate, [verdict(root, "code-quality", { reason: "B is tidier." })]);
  const pair = reportOf(root, previous, candidate);
  assert.deepEqual(pair.fixtures.map((each) => each.fixture), ["ttl-cache"], "stdout has the addressed pair");
  const written = JSON.parse(readReport(root, stamp, "report.json")) as BatchReport;
  assert.deepEqual(written.fixtures.map((each) => each.fixture), ["announcements", "ttl-cache"], "the file has the whole batch");
  assert.deepEqual(written.judge, { provider: "anthropic", model: "claude-sonnet-4-5" });
  assert.match(readReport(root, stamp, "report.md"), /B is tidier\./);
  assert.deepEqual(readdirNames(join(root, RUNS_DIR, stamp)), ["report.json", "report.md"], "no temporary file left behind");
});

test("the <stamp> report directory is never taken for a run: batches, latest pairs and RUN_ID ignore it", () => {
  const root = repo();
  const stamp = "20260920-100000";
  const [previous, candidate] = writePair(root, stamp);
  ok(root);
  assert.ok(existsSync(join(root, RUNS_DIR, stamp, "report.md")));

  assert.equal(RUN_ID.test(stamp), false);
  assert.deepEqual(listBatches(join(root, RUNS_DIR)).map((batch) => [batch.stamp, batch.pairs.map((pair) => pair.fixture)]), [[stamp, ["ttl-cache"]]]);
  assert.deepEqual(latestPair(join(root, RUNS_DIR), "ttl-cache"), [previous, candidate]);
  // And compare, run again over it, still finds exactly the one pair.
  assert.deepEqual(reportOf(root).fixtures.map((each) => [each.fixture, each.error]), [["ttl-cache", null]]);
});

test("with GITHUB_STEP_SUMMARY set, the markdown report is appended to that file after report.md is written", () => {
  const root = repo();
  const stamp = "20260920-100000";
  writePair(root, stamp);
  const summary = join(root, "step-summary.md");
  writeFileSync(summary, "earlier step\n", "utf8");

  const result = cliWith({ ...ENV, GITHUB_STEP_SUMMARY: summary }, root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(summary, "utf8"), `earlier step\n${readReport(root, stamp, "report.md")}`);
  assert.doesNotMatch(result.stdout, /<details>/, "stdout still gets the summary");
});

test("compare needs a repository with a config", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-norepo-")));
  roots.push(root);
  assert.match(fails(root, "--fixture", "x").stderr, /inside a git repository/);

  const repoOnly = repo();
  rmSync(join(repoOnly, CONFIG_FILE));
  assert.match(fails(repoOnly, "--fixture", "x").stderr, /harnessbench init/);
});

test("for a pair, --json prints a one-fixture report; --markdown prints its markdown", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-031455");

  const parsed = reportOf(root, previous, candidate);
  assert.equal(parsed.stamp, "20260919-031455");
  assert.equal(parsed.headSha, HEAD);
  const comparison = comparisonOf(parsed);
  assert.equal(comparison.fixture, "ttl-cache");
  assert.deepEqual(comparison.previous, { runId: previous, harnessSha: "9c21e6389abcdef0123456789abcdef01234567", model: "claude-sonnet-4-5" });
  assert.deepEqual(comparison.candidate, { runId: candidate, harnessSha: HEAD, model: "claude-sonnet-4-5" });
  assert.deepEqual(comparison.warnings, []);

  const markdown = ok(root, "--markdown", previous, candidate).stdout;
  assert.match(markdown, /^### harnessbench {2}1 fixture/);
  assert.match(markdown, /### harnessbench: `ttl-cache`/);
  assert.match(markdown, /^\| Criterion \| Previous \| Candidate \| Delta \| Result \| Note \|$/m);
  assert.match(markdown, /^\| Turns \| 30 \| 20 \| -10 \| improved \| {2}\|$/m);
});

test("compare passes the record's warnings through with a warning: prefix", () => {
  const root = repo();
  const previous = write(root, record("20260919-031455", "previous", { outcome: "timeout" }));
  const candidate = write(root, record("20260919-031455", "candidate"));

  const { stdout } = ok(root, previous, candidate);

  assert.match(stdout, /^warning: ttl-cache: previous did not complete \(timeout\)/m);
  const turns = comparisonOf(reportOf(root, previous, candidate)).rows.find((row) => row.id === "turns");
  assert.equal(turns?.classification, "n/a");
  assert.equal(turns?.note, "previous did not complete");
});

// --- judge rows ---

test("compare finds the pair's judge.json by run ids, not by the directory stamp", () => {
  const root = repo(["code-quality"]);
  const [previous, candidate] = writePair(root, "20260919-031455");
  const [otherPrevious, otherCandidate] = writePair(root, "20260920-031455");
  // The directory stamped like our pair holds the other pair's verdicts, and vice versa.
  writeJudge(root, "20260919-031455", otherPrevious, otherCandidate, [verdict(root, "code-quality", { reason: "the other pair" })]);
  writeJudge(root, "20260920-031455", previous, candidate, [verdict(root, "code-quality", { reason: "ours" })]);
  // Garbage in a judge.json is skipped, not an error.
  mkdirSync(join(root, RUNS_DIR, "20260921-000000-ttl-cache-judge"));
  writeFileSync(join(root, RUNS_DIR, "20260921-000000-ttl-cache-judge", "judge.json"), "{}", "utf8");

  const parsed = comparisonOf(reportOf(root, previous, candidate));

  const rows = parsed.rows.filter((row) => row.id.startsWith("judge."));
  assert.deepEqual(rows, [
    { id: "judge.code-quality", label: "Code quality", previous: "", candidate: "", delta: "candidate preferred", classification: "improved", note: "ours", durationMs: 12000 },
  ]);
  assert.deepEqual(parsed.judged, { model: "claude-sonnet-4-5", provider: "anthropic" });
});

test("the table carries the judge rows: fresh, stale, not judged and no longer configured", () => {
  const root = repo(["code-quality", "engineering-practices", "test-quality"]);
  const [previous, candidate] = writePair(root, "20260919-031455");
  writeJudge(root, "20260919-031455", previous, candidate, [
    verdict(root, "vibes", { title: "Vibes", preference: "previous", reason: "A felt better." }),
    verdict(root, "test-quality", { preference: "tie", reason: "Both cover expiry.", rubricHash: "from-an-older-rubric" }),
    verdict(root, "code-quality", { reason: "B keeps the error type." }),
  ]);

  const { stdout } = ok(root, previous, candidate);

  // Config order, then the unconfigured verdict; the preference only, never the reason.
  assert.match(stdout, /^ttl-cache {2}code quality candidate · engineering practices not judged · test quality tie · vibes previous$/m);
  assert.match(stdout, /^Judges {6}candidate 1 · previous 1 · tie 1 · not judged 1$/m);
  assert.doesNotMatch(stdout, /B keeps the error type/);

  const markdown = ok(root, "--markdown", previous, candidate).stdout;
  assert.match(markdown, /^Judged by anthropic claude-sonnet-4-5\.$/m);
  assert.match(markdown, /^\| Code quality \|  \|  \| candidate preferred \| improved \| B keeps the error type\. \(judged in 12s\) \|$/m);
  assert.match(markdown, /^\| Engineering practices \|  \|  \|  \| n\/a \| not judged; run harnessbench judge --fixture ttl-cache \|$/m);
  assert.match(markdown, /^\| Test quality \|  \|  \| tie \| unchanged \| Both cover expiry\. — rubric changed since this verdict; run harnessbench judge --fixture ttl-cache \(judged in 12s\) \|$/m);
  assert.match(markdown, /^\| Vibes \|  \|  \| previous preferred \| regressed \| A felt better\. — no longer in config\.judges \(judged in 12s\) \|$/m);
});

test("with judges configured and no judge.json the rows say not judged; with none configured there are no rows", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-031455");
  const { stdout } = ok(root, previous, candidate);
  assert.match(stdout, /^ttl-cache {2}code quality not judged · engineering practices not judged · test quality not judged$/m);
  assert.match(ok(root, "--detail", previous, candidate).stdout, /^Judges: not run\.$/m);

  const none = repo([]);
  const pair = writePair(none, "20260919-031455");
  const bare = ok(none, ...pair).stdout;
  assert.match(bare, /^Judges {6}none configured$/m);
  assert.match(bare, /^ttl-cache {2}no judges configured$/m);
  const report = reportOf(none, ...pair);
  assert.equal(report.judge, null);
  assert.equal(comparisonOf(report).judged, null);
});

test("compare refuses a configured judge missing from the catalogue, as judge does", () => {
  const root = repo(["code-quality", "vibes"]);
  const [previous, candidate] = writePair(root, "20260919-031455");
  assert.match(fails(root, previous, candidate).stderr, /unknown judge 'vibes'[\s\S]*available judges:/);
});

test("formatVerdicts no longer exists: the table is the only rendering of a verdict", () => {
  assert.equal("formatVerdicts" in print, false);
});
