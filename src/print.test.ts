import assert from "node:assert/strict";
import { test } from "node:test";

import type { Comparison, Row } from "./compare.js";
import { rollup } from "./compare.js";
import {
  NOISE_LINE,
  ROLLUP_LINE,
  formatComparisonMarkdown,
  formatProgress,
  formatReportMarkdown,
  formatRunsFinished,
  formatSummaryReport,
} from "./print.js";
import { buildReport } from "./report.js";
import type { RunRecord } from "./run-record.js";

function row(patch: Partial<Row> & { id: string; label: string }): Row {
  return { previous: "1", candidate: "1", delta: "", classification: "unchanged", ...patch };
}

/** A comparison with one very wide value in each column, to exercise the alignment. */
function comparison(warnings: string[] = []): Comparison {
  return {
    fixture: "ttl-cache",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    previous: { runId: "20260919-031455-ttl-cache-previous", harnessSha: "9c21e6389abcdef0123456789abcdef01234567", model: "claude-sonnet-4-5" },
    candidate: { runId: "20260919-031455-ttl-cache-candidate", harnessSha: "0123456789abcdef0123456789abcdef01234567", model: null },
    rows: [
      row({ id: "outcome", label: "Outcome", previous: "completed", candidate: "completed" }),
      row({ id: "tests", label: "Tests", previous: "not run", candidate: "passed", classification: "n/a", note: "not run in this environment" }),
      row({ id: "tokens.total", label: "Tokens", previous: "1,203,000", candidate: "960,000", delta: "-21%", classification: "improved" }),
      row({ id: "toolCalls", label: "Tool calls", previous: "18", candidate: "15", delta: "-3", note: "within noise" }),
      row({ id: "durationMs", label: "Duration", previous: "3m48s", candidate: "1h02m", delta: "+1,532%", classification: "regressed" }),
    ],
    warnings,
    judged: null,
  };
}

/** The column at which `word` starts on each line that contains it. */

test("formatComparisonMarkdown renders a valid GitHub table with the same content", () => {
  const text = formatComparisonMarkdown(comparison(["models | differ"]));
  const lines = text.split("\n");

  assert.equal(lines[0], "### harnessbench: `ttl-cache`");
  assert.match(text, /Harness `previous` 9c21e63 → `candidate` 0123456, both on code 0123456\./);
  assert.match(text, /Model: previous claude-sonnet-4-5 → candidate not reported\./);
  assert.match(text, /Runs `20260919-031455-ttl-cache-previous` and `20260919-031455-ttl-cache-candidate`\./);
  assert.ok(lines.includes(`_${NOISE_LINE}_`));
  assert.ok(lines.includes("> **warning:** models \\| differ"));

  const header = lines.indexOf("| Criterion | Previous | Candidate | Delta | Result | Note |");
  assert.notEqual(header, -1);
  assert.equal(lines[header + 1], "|---|---|---|---|---|---|");
  const body = lines.slice(header + 2);
  assert.equal(body.length, 5);
  for (const line of body) {
    assert.match(line, /^\| .* \|$/);
    assert.equal(line.split(" | ").length, 6, line);
  }
  assert.equal(body[1], "| Tests | not run | passed |  | n/a | not run in this environment |");
  assert.equal(body[2], "| Tokens | 1,203,000 | 960,000 | -21% | improved |  |");
  // A blank line separates every block, so the table is not glued to the paragraph above it.
  assert.equal(lines[header - 1], "");
});

function runRecord(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: 2,
    runId: "20260919-031455-ttl-cache-candidate",
    fixture: "ttl-cache",
    environment: "candidate",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    baseBranch: "main",
    harness: { ref: "HEAD", sha: "0123456789abcdef0123456789abcdef01234567", files: ["CLAUDE.md"], hash: "candidate-hash" },
    agent: { name: "claude-code", command: "claude", model: "claude-sonnet-4-5" },
    outcome: "completed",
    exitCode: 0,
    setup: { command: "npm ci", exitCode: 0, durationMs: 24000, timedOut: false },
    startedAt: "2026-09-19T03:14:55.000Z",
    finishedAt: "2026-09-19T03:19:07.000Z",
    tokens: { input: 1203, output: 18940, cacheRead: 402113, cacheWrite: 10004 },
    costUsd: 0.38,
    durationMs: 252000,
    turns: 23,
    toolCalls: { Read: 18, Edit: 9, Bash: 14 },
    toolFailures: 2,
    telemetry: {
      main: { turns: 20, toolCalls: 30, toolFailures: 2, tokens: { input: 1000, output: 16000, cacheRead: 300000, cacheWrite: 9000 } },
      subAgents: [
        { id: "toolu_01", tool: "Explore", model: "claude-haiku-4-5", turns: 3, toolCalls: 11, toolFailures: 0, tokens: { input: 203, output: 2940, cacheRead: 102113, cacheWrite: 1004 } },
        { id: "toolu_02", tool: "Task", model: null, turns: 1, toolCalls: 1, toolFailures: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
      readsBeforeFirstEdit: 6,
      turnsBeforeFirstEdit: 4,
      filesRead: 9,
      repeatReads: 1,
      duplicateReads: 2,
      filesWritten: 5,
      phases: { exploringMs: 62000, buildingMs: 150000, verifyingMs: 40000 },
    },
    diff: { files: 5, added: 212, removed: 7 },
    tests: { state: "passed", command: "npm test", files: [], exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: "Added a TTL cache.",
    ...patch,
  };
}

/** The mechanical rows above plus two judge rows, one with a long note. */
function withJudges(judged: Comparison["judged"], note: string): Comparison {
  const c = comparison();
  return {
    ...c,
    judged,
    rows: [
      ...c.rows,
      row({ id: "judge.code-quality", label: "Code quality", previous: "", candidate: "", delta: "candidate preferred", classification: "improved", note }),
      row({ id: "judge.test-quality", label: "Test quality", previous: "", candidate: "", delta: "", classification: "n/a", note: "not judged; run harnessbench judge --fixture ttl-cache" }),
    ],
  };
}

const LONG_REASON =
  "B's TtlCache keeps the existing error type in read.ts while A introduces a second one; " +
  "B's eviction test covers expiry through the public get/set — rubric changed since this verdict; run harnessbench judge --fixture ttl-cache";


test("formatComparisonMarkdown puts the judge rows in the same table with the whole reason, under a sentence", () => {
  const text = formatComparisonMarkdown(withJudges({ provider: "anthropic", model: "claude-sonnet-4-5" }, LONG_REASON));
  const lines = text.split("\n");

  const header = lines.indexOf("| Criterion | Previous | Candidate | Delta | Result | Note |");
  assert.equal(lines[header - 2], "Judged by anthropic claude-sonnet-4-5.");
  assert.equal(lines[header - 1], "");
  assert.equal(lines.slice(header + 2).length, 7, "every row, mechanical and judge, in one table");
  assert.equal(lines.at(-2), `| Code quality |  |  | candidate preferred | improved | ${LONG_REASON} |`);
  assert.equal(lines.at(-1), "| Test quality |  |  |  | n/a | not judged; run harnessbench judge --fixture ttl-cache |");

  assert.match(formatComparisonMarkdown(withJudges(null, "")), /\nJudges: not run\.\n\n\| Criterion/);
  assert.doesNotMatch(formatComparisonMarkdown(comparison()), /[Jj]udge/);
});

test("formatProgress puts one clock, an aligned fixture column and an aligned environment column before every event", () => {
  const ok = { command: "npm ci", exitCode: 0, durationMs: 800, timedOut: false };
  const failed = { command: "npm test", exitCode: 1, durationMs: 18_400, timedOut: false };
  const files = ["src/a.test.ts", "src/b.test.ts"];
  const ran = { state: "passed" as const, command: "npm test", files, exitCode: 0, durationMs: 18_000, timedOut: false };
  const idle = { command: null, files: [], exitCode: null, durationMs: 0, timedOut: false };
  const width = "holiday-api-client".length;
  const lines = [
    formatProgress(0, "ttl-cache", width, "previous", { kind: "started" }),
    formatProgress(1_200, "holiday-api-client", width, "candidate", { kind: "setup", result: ok }),
    formatProgress(1_200, "ttl-cache", width, "candidate", { kind: "setup", result: { ...failed, command: "npm ci" } }),
    formatProgress(301_000, "ttl-cache", width, "previous", { kind: "agent", outcome: "completed", turns: 30 }),
    formatProgress(346_000, "ttl-cache", width, "candidate", { kind: "agent", outcome: "max_turns", turns: 1 }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: ran }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: { ...ran, state: "failed", exitCode: 1, files: ["src/a.test.ts"] } }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: { ...ran, state: "failed", exitCode: null, timedOut: true } }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: { ...idle, state: "none written" } }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: { ...idle, state: "not run" } }),
    formatProgress(3_600_000, "ttl-cache", width, "previous", { kind: "recorded", runId: "20260922-101500-ttl-cache-previous" }),
  ];
  assert.deepEqual(lines, [
    "[00:00] ttl-cache           previous   started",
    "[00:01] holiday-api-client  candidate  setup ok (npm ci, 0.8s)",
    "[00:01] ttl-cache           candidate  setup failed (npm ci, exit 1, 18s)",
    "[05:01] ttl-cache           previous   agent completed (30 turns)",
    "[05:46] ttl-cache           candidate  agent max_turns (1 turn)",
    "[05:19] ttl-cache           previous   tests passed (2 files, 18s)",
    "[05:19] ttl-cache           previous   tests failed (1 file, exit 1, 18s)",
    "[05:19] ttl-cache           previous   tests failed (2 files, timed out, 18s)",
    "[05:19] ttl-cache           previous   tests: none written",
    "[05:19] ttl-cache           previous   tests not run",
    "[60:00] ttl-cache           previous   recorded .harnessbench/runs/20260922-101500-ttl-cache-previous",
  ]);
  // One fixture: the column is as wide as its id.
  assert.equal(formatProgress(0, "ttl-cache", 9, "previous", { kind: "started" }), "[00:00] ttl-cache  previous   started");
});


// --- the batch report ---

const STAMP = "20260924-052122";
const PREVIOUS_SHA = "9c21e6389abcdef0123456789abcdef01234567";

function pairOf(fixture: string): { previous: RunRecord; candidate: RunRecord } {
  return {
    previous: runRecord({
      fixture,
      environment: "previous",
      runId: `${STAMP}-${fixture}-previous`,
      harness: { ref: PREVIOUS_SHA, sha: PREVIOUS_SHA, files: ["CLAUDE.md"], hash: "previous-hash" },
      finalMessage: "Wrote the client.\nTests pass.",
    }),
    candidate: runRecord({ fixture, runId: `${STAMP}-${fixture}-candidate` }),
  };
}

/** A comparison of `fixture` with the given mechanical and judge classifications, in table order. */
function judgedComparison(fixture: string, rows: Array<[string, string, Row["classification"]]>, warnings: string[] = []): Comparison {
  return {
    ...comparison(warnings),
    fixture,
    judged: { provider: "anthropic", model: "claude-sonnet-4-5" },
    rows: rows.map(([id, label, classification]) =>
      row({ id, label, classification, ...(id.startsWith("judge.") ? { previous: "", candidate: "", note: id === "judge.code-quality" ? LONG_REASON : "short" } : {}) }),
    ),
  };
}

function batch(warnings: string[] = []) {
  const holiday = judgedComparison("holiday-api-client", [
    ["outcome", "Outcome", "unchanged"],
    ["tests", "Tests", "unchanged"],
    ["turns", "Turns", "regressed"],
    ["phases.exploringMs", "Exploring", "improved"],
    ["costUsd", "Cost", "unchanged"],
    ["judge.code-quality", "Code quality", "improved"],
    ["judge.test-quality", "Test quality", "improved"],
  ]);
  const list = judgedComparison(
    "list-runs",
    [
      ["outcome", "Outcome", "unchanged"],
      ["tests", "Tests", "n/a"],
      ["turns", "Turns", "regressed"],
      ["phases.exploringMs", "Exploring", "unchanged"],
      ["costUsd", "Cost", "regressed"],
      ["judge.code-quality", "Code quality", "regressed"],
      ["judge.test-quality", "Test quality", "improved"],
    ],
    warnings,
  );
  return buildReport(STAMP, [
    { fixture: "broken", previous: null, candidate: null, comparison: null, error: "broken: previous: setup command `npm ci` exited with code 1; the agent was not started.\nIts output is in setup.log." },
    { fixture: "holiday-api-client", ...pairOf("holiday-api-client"), comparison: holiday, error: null },
    { fixture: "list-runs", ...pairOf("list-runs"), comparison: list, error: null },
  ]);
}

test("formatSummaryReport: header, three verdict lines, one aligned line per fixture, the report path last", () => {
  assert.deepEqual(formatSummaryReport(batch()).split("\n"), [
    "harnessbench  3 fixtures · code 0123456 · previous 9c21e63 → candidate 0123456 · claude-sonnet-4-5",
    "",
    "Outcome     unchanged 2",
    "Efficiency  regressed: Turns 2, Cost 1 · improved: Exploring 1",
    "Judges      candidate 3 · previous 1 · tie 0",
    "",
    "broken              error: broken: previous: setup command `npm ci` exited with code 1; the agent was not started.",
    "holiday-api-client  code quality candidate · test quality candidate",
    "list-runs           code quality previous  · test quality candidate",
    "",
    `report  .harnessbench/runs/${STAMP}/report.md`,
  ]);
});

test("formatSummaryReport puts warnings above the verdict lines, never reasons; the worse of outcome and tests counts", () => {
  const report = batch(["models differ"]);
  const regressed = report.fixtures[2]?.comparison?.rows.find((each) => each.id === "tests");
  if (regressed !== undefined) regressed.classification = "regressed";
  const lines = formatSummaryReport({ ...report, rollup: rollup(report.fixtures.flatMap((each) => (each.comparison === null ? [] : [each.comparison]))) }).split("\n");

  assert.equal(lines[2], "warning: list-runs: models differ");
  assert.equal(lines[3], "Outcome     regressed 1 · unchanged 1");
  assert.ok(!lines.some((line) => line.includes("short") || line.includes("TtlCache")), "no judge reason on the terminal");
});

test("formatSummaryReport with nothing that moved and no judges says so in one word each", () => {
  const quiet = { ...comparison(), rows: comparison().rows.map((each) => ({ ...each, classification: "unchanged" as const })) };
  const report = buildReport(STAMP, [{ fixture: "ttl-cache", ...pairOf("ttl-cache"), comparison: quiet, error: null }]);
  const lines = formatSummaryReport(report).split("\n");
  assert.equal(lines[3], "Efficiency  unchanged");
  assert.equal(lines[4], "Judges      none configured");
  assert.equal(lines[6], "ttl-cache  no judges configured");
});

test("formatReportMarkdown: verdict list, roll-up table, one <details> per fixture with full reasons, sides and final messages", () => {
  const text = formatReportMarkdown(batch(["models | differ"]));
  const lines = text.split("\n");

  assert.equal(lines[0], "### harnessbench  3 fixtures · code 0123456 · previous 9c21e63 → candidate 0123456 · claude-sonnet-4-5");
  assert.deepEqual(lines.slice(2, 5), [
    "- **Outcome** unchanged 2",
    "- **Efficiency** regressed: Turns 2, Cost 1 · improved: Exploring 1",
    "- **Judges** candidate 3 · previous 1 · tie 0",
  ]);
  assert.ok(lines.includes("> **warning:** list-runs: models \\| differ"));
  assert.ok(lines.includes(`_${ROLLUP_LINE}_`));
  assert.ok(lines.includes("| Criterion | Improved | Regressed | Unchanged | n/a |"));
  assert.ok(lines.includes("| Turns |  | holiday-api-client, list-runs |  |  |"));
  assert.ok(lines.indexOf("| Criterion | Improved | Regressed | Unchanged | n/a |") < lines.findIndex((line) => line.startsWith("<details>")));

  assert.deepEqual(lines.filter((line) => line.startsWith("<details>")), [
    "<details><summary>broken: error: broken: previous: setup command `npm ci` exited with code 1; the agent was not started.</summary>",
    "<details><summary>holiday-api-client: code quality candidate · test quality candidate</summary>",
    "<details><summary>list-runs: code quality previous · test quality candidate</summary>",
  ]);
  assert.equal(lines.filter((line) => line === "</details>").length, 3);
  assert.ok(lines.includes(`| Code quality |  |  |  | improved | ${LONG_REASON} |`), "the whole reason, in the note column");
  assert.ok(lines.includes("| Side | Outcome | Duration | Turns | Tool calls | Tokens | Cost | Setup | Tests | Changes |"));
  assert.ok(
    lines.includes(
      "| previous | completed | 4m12s | 23 | 41 (Read 18, Edit 9, Bash 14), 2 failed | in 1,203, out 18,940, cache read 402,113, cache write 10,004 | $0.38 | npm ci → ok in 24s | npm test → passed in 12s | 5 files, +212 / -7 |",
    ),
  );
  assert.match(text, /\*\*previous\*\* final message:\n\n> Wrote the client\.\n> Tests pass\.\n/);
  assert.match(text, /\*\*candidate\*\* final message:\n\n> Added a TTL cache\.\n/);
  assert.ok(lines.includes(`- candidate: \`.harnessbench/runs/${STAMP}-list-runs-candidate\``));
  assert.ok(lines.includes("> **error:** broken: previous: setup command `npm ci` exited with code 1; the agent was not started. Its output is in setup.log."));
});

test("formatRunsFinished is one line with the count and the wall clock", () => {
  assert.equal(formatRunsFinished(6, 312_400), "6 runs finished in 05:12");
  assert.equal(formatRunsFinished(1, 4_000), "1 run finished in 00:04");
});
