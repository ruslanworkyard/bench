import assert from "node:assert/strict";
import { test } from "node:test";

import type { Comparison, Row } from "./compare.js";
import type { Rollup } from "./compare.js";
import {
  NOISE_LINE,
  ROLLUP_LINE,
  formatBatch,
  formatBatchMarkdown,
  formatComparison,
  formatComparisonMarkdown,
  formatProgress,
  formatRollup,
  formatRun,
} from "./print.js";
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
      row({ id: "tests", label: "Tests", previous: "not configured", candidate: "passed", classification: "n/a", note: "no test command configured" }),
      row({ id: "tokens.total", label: "Tokens", previous: "1,203,000", candidate: "960,000", delta: "-21%", classification: "improved" }),
      row({ id: "toolCalls", label: "Tool calls", previous: "18", candidate: "15", delta: "-3", note: "within noise" }),
      row({ id: "durationMs", label: "Duration", previous: "3m48s", candidate: "1h02m", delta: "+1,532%", classification: "regressed" }),
    ],
    warnings,
    judged: null,
  };
}

/** The column at which `word` starts on each line that contains it. */
function columnOf(lines: string[], word: string): number[] {
  return lines.filter((line) => line.includes(word)).map((line) => line.indexOf(word));
}

test("formatComparison aligns every column to its widest value", () => {
  const text = formatComparison(comparison());
  const lines = text.split("\n");

  assert.equal(lines[0], "harnessbench compare  ttl-cache · code 0123456");
  assert.ok(lines.includes("Harness    previous 9c21e63 → candidate 0123456"));
  assert.ok(lines.includes("Model      previous claude-sonnet-4-5 → candidate not reported"));
  assert.ok(lines.includes("Runs       20260919-031455-ttl-cache-previous → 20260919-031455-ttl-cache-candidate"));
  assert.ok(lines.includes(NOISE_LINE));
  assert.ok(!text.includes("warning:"));

  const table = lines.slice(lines.indexOf(NOISE_LINE) + 2);
  assert.equal(table.length, 5);
  // Every column starts where it starts on the widest row: the arrow, the delta, the word.
  const arrows = table.map((line) => line.indexOf("→"));
  assert.equal(new Set(arrows).size, 1, `arrows at ${arrows.join(", ")}`);
  const words = table.map((line) => line.search(/unchanged|improved|regressed|n\/a/));
  assert.equal(new Set(words).size, 1, `classifications at ${words.join(", ")}`);
  assert.equal(columnOf(table, "-21%")[0], columnOf(table, "+1,532%")[0]);
  // The note sits after the classification, and lines carry no trailing padding.
  assert.match(table[3] as string, /Tool calls\s+18\s+→ 15\s+-3\s+unchanged\s+within noise$/);
  for (const line of table) assert.equal(line, line.trimEnd());
});

test("formatComparison prints warnings after the noise line, each prefixed", () => {
  const lines = formatComparison(comparison(["models differ", "same harness"])).split("\n");
  const at = lines.indexOf(NOISE_LINE);
  assert.equal(lines[at + 1], "warning: models differ");
  assert.equal(lines[at + 2], "warning: same harness");
  assert.equal(lines[at + 3], "");
});

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
  assert.equal(body[1], "| Tests | not configured | passed |  | n/a | no test command configured |");
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
    tests: { command: "npm test", exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: "Added a TTL cache.",
    ...patch,
  };
}

test("formatRun shows the setup command only when one ran", () => {
  const lines = formatRun(runRecord(), "/nonexistent/agent.stderr.log").split("\n");
  assert.ok(lines.includes("Setup      npm ci → ok in 24s"), lines.join("\n"));

  const failed = runRecord({ setup: { command: "npm ci", exitCode: 1, durationMs: 3000, timedOut: false } });
  assert.ok(formatRun(failed, "/nonexistent").includes("Setup      npm ci → failed (exit 1) in 3s"));

  const none = formatRun(runRecord({ setup: null }), "/nonexistent").split("\n");
  assert.equal(none.some((line) => line.startsWith("Setup")), false);
});

test("formatRun summarises threads and phases on one line each", () => {
  const lines = formatRun(runRecord(), "/nonexistent/agent.stderr.log").split("\n");

  assert.ok(lines.includes("Turns      23   Tool calls  41 (Read 18, Edit 9, Bash 14)   Tool failures 2"));
  assert.ok(lines.includes("Threads    main 20 turns / 30 calls · Explore on claude-haiku-4-5: 11 calls · Task on model not reported: 1 call"));
  assert.ok(lines.includes("Phases     exploring 1m02s · building 2m30s · verifying 40s"));

  const { telemetry: _dropped, ...earlier } = runRecord();
  const old = formatRun(earlier as RunRecord, "/nonexistent/agent.stderr.log").split("\n");
  assert.ok(old.includes("Threads    not recorded"));
  assert.ok(old.includes("Phases     not recorded"));
});

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

test("formatComparison puts the judge rows under their own heading, in the same columns, with the note wrapped", () => {
  const text = formatComparison(withJudges({ provider: "anthropic", model: "claude-sonnet-4-5" }, LONG_REASON));
  const lines = text.split("\n");

  const heading = lines.indexOf("judged by anthropic claude-sonnet-4-5");
  assert.notEqual(heading, -1);
  assert.equal(lines[heading - 1], "", "a blank line separates the judge rows from the mechanical ones");
  assert.match(lines[heading - 2] as string, /^Duration/);

  const codeQuality = lines[heading + 1] as string;
  assert.match(codeQuality, /^Code quality\s+candidate preferred\s+improved\s+B's TtlCache/);
  // Same columns as the mechanical rows: the classification word starts where it does above.
  const words = [...lines.slice(heading - 6, heading - 1), codeQuality].map((line) => line.search(/unchanged|improved|regressed|n\/a/));
  assert.equal(new Set(words).size, 1, `classifications at ${words.join(", ")}`);
  // A bare arrow is not printed for an empty candidate cell.
  assert.doesNotMatch(codeQuality, /→/);

  // The note wraps to 100 columns, or to a 40-wide note column when the other columns leave
  // less than that; continuation lines start at the note column.
  const noteAt = codeQuality.indexOf("B's TtlCache");
  const limit = Math.max(100, noteAt + 40);
  const noteLines = [codeQuality];
  for (let i = heading + 2; i < lines.length && lines[i]?.startsWith(" "); i++) noteLines.push(lines[i] as string);
  assert.ok(noteLines.length >= 3, `expected a wrapped note, got:\n${noteLines.join("\n")}`);
  for (const line of noteLines) assert.ok(line.length <= limit, `over ${limit} columns: ${line}`);
  assert.ok(noteLines.some((line) => line.length > limit - 12), "lines are filled, not wrapped early");
  for (const line of noteLines.slice(1)) {
    assert.equal(line.search(/\S/), noteAt, `continuation not aligned: ${JSON.stringify(line)}`);
  }
  assert.equal(noteLines.map((line) => line.slice(noteAt)).join(" "), LONG_REASON);

  const notJudged = lines[heading + 1 + noteLines.length] as string;
  assert.match(notJudged, /^Test quality\s+n\/a\s+not judged; run harnessbench judge$/);
  assert.equal(lines[heading + 2 + noteLines.length], `${" ".repeat(noteAt)}--fixture ttl-cache`);
  // The mechanical rows are not wrapped.
  assert.equal(lines.filter((line) => line.startsWith("Tool calls")).length, 1);
});

test("formatComparison says judges: not run when no verdict exists, and nothing at all without judge rows", () => {
  const text = formatComparison(withJudges(null, ""));
  assert.match(text, /\n\njudges: not run\nCode quality/);
  assert.doesNotMatch(formatComparison(comparison()), /judge/);
});

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
  const width = "holiday-api-client".length;
  const lines = [
    formatProgress(0, "ttl-cache", width, "previous", { kind: "started" }),
    formatProgress(1_200, "holiday-api-client", width, "candidate", { kind: "setup", result: ok }),
    formatProgress(1_200, "ttl-cache", width, "candidate", { kind: "setup", result: { ...failed, command: "npm ci" } }),
    formatProgress(301_000, "ttl-cache", width, "previous", { kind: "agent", outcome: "completed", turns: 30 }),
    formatProgress(346_000, "ttl-cache", width, "candidate", { kind: "agent", outcome: "max_turns", turns: 1 }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: { ...ok, command: "npm test", durationMs: 18_000 } }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: failed }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: { ...failed, exitCode: null, timedOut: true } }),
    formatProgress(319_000, "ttl-cache", width, "previous", { kind: "tests", result: null }),
    formatProgress(3_600_000, "ttl-cache", width, "previous", { kind: "recorded", runId: "20260922-101500-ttl-cache-previous" }),
  ];
  assert.deepEqual(lines, [
    "[00:00] ttl-cache           previous   started",
    "[00:01] holiday-api-client  candidate  setup ok (npm ci, 0.8s)",
    "[00:01] ttl-cache           candidate  setup failed (npm ci, exit 1, 18s)",
    "[05:01] ttl-cache           previous   agent completed (30 turns)",
    "[05:46] ttl-cache           candidate  agent max_turns (1 turn)",
    "[05:19] ttl-cache           previous   tests passed (18s)",
    "[05:19] ttl-cache           previous   tests failed (exit 1, 18s)",
    "[05:19] ttl-cache           previous   tests failed (timed out, 18s)",
    "[05:19] ttl-cache           previous   tests not configured",
    "[60:00] ttl-cache           previous   recorded .harnessbench/runs/20260922-101500-ttl-cache-previous",
  ]);
  // One fixture: the column is as wide as its id.
  assert.equal(formatProgress(0, "ttl-cache", 9, "previous", { kind: "started" }), "[00:00] ttl-cache  previous   started");
});

// --- roll-up ---

function rollupOf(): Rollup {
  return {
    fixtures: 3,
    rows: [
      { id: "turns", label: "Turns", improved: ["list-runs", "ttl-cache"], regressed: ["announcements"], unchanged: [], na: [] },
      { id: "readsBeforeFirstEdit", label: "Reads before first edit", improved: ["list-runs", "ttl-cache", "announcements"], regressed: [], unchanged: [], na: [] },
      { id: "costUsd", label: "Cost", improved: [], regressed: [], unchanged: ["list-runs"], na: ["ttl-cache", "announcements"] },
      { id: "judge.code-quality", label: "Code quality", improved: ["ttl-cache"], regressed: ["list-runs"], unchanged: ["announcements"], na: [] },
    ],
    warnings: [],
  };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("formatRollup aligns the criterion column and lists each fixture behind every count", () => {
  const lines = formatRollup(rollupOf(), SHA).split("\n");

  assert.deepEqual(lines.slice(0, 4), ["harnessbench rollup  3 fixtures · code 0123456", "", ROLLUP_LINE, ""]);
  assert.deepEqual(lines.slice(4), [
    "Turns                    improved 2 [list-runs, ttl-cache]   regressed 1 [announcements]",
    "Reads before first edit  improved 3 [list-runs, ttl-cache, announcements]",
    "Cost                     unchanged 1 [list-runs]   n/a 2 [ttl-cache, announcements]",
    "Code quality             candidate 1 [ttl-cache]   previous 1 [list-runs]   tie 1 [announcements]",
  ]);
  // Every first cell starts in the same column: the widest label plus two spaces.
  const cellAt = lines.slice(4).map((line) => line.search(/ {2}\S/) + 2);
  assert.equal(new Set(cellAt).size, 1, `cells at ${cellAt.join(", ")}`);
  assert.equal(cellAt[0], "Reads before first edit".length + 2);
});

test("formatRollup prints warnings under the noise line, and formatBatch puts the roll-up above each fixture's blocks", () => {
  const withWarnings = { ...rollupOf(), warnings: ["ttl-cache: models differ", "announcements: same harness"] };
  const lines = formatRollup(withWarnings, SHA).split("\n");
  const at = lines.indexOf(ROLLUP_LINE);
  assert.equal(lines[at + 1], "warning: ttl-cache: models differ");
  assert.equal(lines[at + 2], "warning: announcements: same harness");
  assert.equal(lines[at + 3], "");

  const text = formatBatch(
    rollupOf(),
    [
      { fixture: "ttl-cache", comparison: comparison(), error: null },
      { fixture: "holiday-api-client", comparison: null, error: "holiday-api-client: candidate side missing" },
    ],
    SHA,
  );
  assert.match(text, /^harnessbench rollup {2}3 fixtures/);
  assert.match(text, /\n\n── ttl-cache ──\n\nharnessbench compare {2}ttl-cache · code 0123456\n/);
  assert.match(text, /\n\n── holiday-api-client ──\n\nerror: holiday-api-client: candidate side missing$/);

  // One fixture: its blocks alone, no roll-up, no heading.
  const single = formatBatch(rollupOf(), [{ fixture: "ttl-cache", comparison: comparison(), error: null }], SHA);
  assert.equal(single, formatComparison(comparison()));
});

test("formatBatchMarkdown renders the roll-up as a table of fixture names, then each fixture's table inside <details>", () => {
  const text = formatBatchMarkdown(
    { ...rollupOf(), warnings: ["ttl-cache: models | differ"] },
    [
      { fixture: "ttl-cache", comparison: comparison(), error: null },
      { fixture: "holiday-api-client", comparison: null, error: "holiday-api-client: candidate side missing" },
    ],
    SHA,
  );
  const lines = text.split("\n");

  assert.equal(lines[0], "### harnessbench: 3 fixtures on code 0123456");
  assert.ok(lines.includes(`_${ROLLUP_LINE}_`));
  assert.ok(lines.includes("> **warning:** ttl-cache: models \\| differ"));
  const header = lines.indexOf("| Criterion | Improved | Regressed | Unchanged | n/a |");
  assert.notEqual(header, -1);
  assert.equal(lines[header + 1], "|---|---|---|---|---|");
  assert.equal(lines[header + 2], "| Turns | list-runs, ttl-cache | announcements |  |  |");
  assert.equal(lines[header + 4], "| Cost |  |  | list-runs | ttl-cache, announcements |");
  assert.equal(lines[header + 5], "| Code quality | ttl-cache | list-runs | announcements |  |");

  const details = lines.map((line, i) => [line, i] as const).filter(([line]) => line.startsWith("<details>"));
  assert.deepEqual(details.map(([line]) => line), ["<details><summary>ttl-cache</summary>", "<details><summary>holiday-api-client</summary>"]);
  const [first, second] = details.map(([, i]) => i) as [number, number];
  // A blank line on each side of the table, so GitHub renders markdown inside the block.
  assert.equal(lines[first - 1], "");
  assert.equal(lines[first + 1], "");
  assert.equal(lines[first + 2], "### harnessbench: `ttl-cache`");
  assert.equal(lines[second + 2], "> **error:** holiday-api-client: candidate side missing");
  assert.equal(lines.filter((line) => line === "</details>").length, 2);
  assert.equal(lines.at(-1), "</details>");
  assert.equal(lines.at(-2), "");
});
