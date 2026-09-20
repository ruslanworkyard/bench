import assert from "node:assert/strict";
import { test } from "node:test";

import type { Comparison, Row } from "./compare.js";
import { NOISE_LINE, formatComparison, formatComparisonMarkdown, formatRun } from "./print.js";
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
