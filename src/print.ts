import { relative } from "node:path";

import { JUDGE_ROW_PREFIX, type Classification, type Comparison, type Rollup, type RollupRow } from "./compare.js";
import { DEFAULT_TEST_LABEL, ENV_FILE, RUNS_DIR } from "./config.js";
import type { HarnessEntry } from "./detect/harness.js";
import type { Detection } from "./detect/types.js";
import type { ProgressEvent } from "./commands/run.js";
import type { OpStatus } from "./plan.js";
import type { BatchReport, ReportFixture, SideSummary } from "./report.js";
import { REPORT_MARKDOWN, reportDir, type CommandResult, type TestResult } from "./run-record.js";

export type FileReport = { path: string; status: OpStatus };

/** Everything init found and did. Also the shape printed by --json. */
export type Report = {
  root: string;
  dryRun: boolean;
  harness: HarnessEntry[];
  testCommand: Detection<string> | null;
  setupCommand: Detection<string> | null;
  agent: Detection<string> | null;
  agentsOnPath: string[];
  baseBranch: Detection<string> | null;
  fixtures: { added: string[]; present: string[] };
  judges: { added: string[]; present: string[] };
  files: FileReport[];
  warnings: string[];
  next: string;
};

const LABEL_WIDTH = 14;

function field(label: string, detection: Detection<string> | null, fallback: string): string {
  if (detection === null) return `${label.padEnd(LABEL_WIDTH)}${fallback}`;
  return `${label.padEnd(LABEL_WIDTH)}${detection.value.padEnd(24)}${detection.source}`;
}

function statusLabel(status: OpStatus, dryRun: boolean): string {
  switch (status) {
    case "created":
      return dryRun ? "would create" : "created";
    case "appended":
      return dryRun ? "would append" : "appended";
    case "skipped":
      return "already exists";
    case "present":
      return "already present";
  }
}

export function formatJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

export function formatSummary(report: Report): string {
  const lines: string[] = [];
  const where = relative(process.cwd(), report.root) || ".";
  lines.push(`harnessbench init  ${where}${report.dryRun ? "  (dry run, nothing written)" : ""}`);

  lines.push("");
  lines.push(`Harness files (${report.harness.length})`);
  if (report.harness.length === 0) {
    lines.push("  none found");
  } else {
    const width = Math.max(...report.harness.map((entry) => entry.path.length));
    for (const entry of report.harness) {
      lines.push(`  ${entry.path.padEnd(width)}  ${entry.source}`);
    }
  }

  lines.push("");
  lines.push(field("Test command", report.testCommand, "none detected"));
  lines.push(
    field(
      "Setup command",
      report.setupCommand,
      "none detected (set setupCommand if the agent needs dependencies installed)",
    ),
  );
  lines.push(field("Agent", report.agent, "none found on PATH"));
  lines.push(field("Base branch", report.baseBranch, "none detected"));

  lines.push("");
  const verb = report.dryRun ? "would add" : "added";
  for (const [label, { added, present }] of [
    ["Fixtures", report.fixtures],
    ["Judges", report.judges],
  ] as const) {
    lines.push(
      `${label.padEnd(LABEL_WIDTH)}${added.length > 0 ? `${verb}: ${added.join(", ")}` : `${verb}: none`}`,
    );
    if (present.length > 0) {
      lines.push(`${" ".repeat(LABEL_WIDTH)}already present: ${present.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Files");
  for (const file of report.files) {
    lines.push(`  ${statusLabel(file.status, report.dryRun).padEnd(16)}${file.path}`);
  }
  lines.push("");
  lines.push(`credentials: ${ENV_FILE} (gitignored; see .env.example)`);

  if (report.warnings.length > 0) {
    lines.push("");
    for (const warning of report.warnings) lines.push(`! ${warning}`);
  }

  lines.push("");
  lines.push(`Next: ${report.next}`);
  return lines.join("\n");
}

/** The warning `run` prints before it starts, when the harness on disk is not what will run. */
export function formatDirtyHarness(paths: string[]): string {
  const lines = [
    "! these harness files have uncommitted changes; the run will use the",
    "! committed version of each:",
    ...paths.map((path) => `!   ${path}`),
  ];
  return lines.join("\n");
}

/** The warning `run` prints when both sides would use the same harness: any delta is noise. */
export function formatSameHarness(sha: string): string {
  return [
    `! the harness is identical at HEAD and at the merge base (${sha.slice(0, 7)}):`,
    "! previous and candidate will run the same harness, so any difference",
    "! between them is noise, not the effect of a change",
  ].join("\n");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `npm ci → ok in 24s`, or how it failed. Only a success ever reaches a record, but a failed
 * one is still formatted for anyone showing the result another way. */
function setupLine(setup: CommandResult): string {
  const took = formatDuration(setup.durationMs);
  if (setup.timedOut) return `${setup.command} → timed out after ${took}`;
  if (setup.exitCode === 0) return `${setup.command} → ok in ${took}`;
  const how = setup.exitCode === null ? "killed" : `exit ${setup.exitCode}`;
  return `${setup.command} → failed (${how}) in ${took}`;
}

/** `node --test dist/a.test.js → passed in 3s (1 file)`, `none written`, or `not run in this environment`. */
function testsLine(tests: TestResult): string {
  if (tests.state === "not run") return "not run in this environment";
  if (tests.state === "none written" || tests.command === null) return tests.state;
  const files = tests.files.length === 0 ? "" : ` (${plural(tests.files.length, "file")})`;
  const took = formatDuration(tests.durationMs);
  if (tests.timedOut) return `${tests.command} → timed out after ${took}${files}`;
  if (tests.state === "passed") return `${tests.command} → passed in ${took}${files}`;
  const how = tests.exitCode === null ? "killed" : `exit ${tests.exitCode}`;
  return `${tests.command} → failed, ${how}${files}`;
}

/** `0.8s` for anything under ten seconds, then as `formatDuration`. */
function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** How a setup or test command ended: `exit 1`, `killed`, or `timed out`. */
function ended(result: Pick<CommandResult, "exitCode" | "timedOut">): string {
  if (result.timedOut) return "timed out";
  return result.exitCode === null ? "killed" : `exit ${result.exitCode}`;
}

/** `05:01`: minutes and seconds, the minutes never wrapping into hours. */
function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One line of progress while a run is in flight, for stderr:
 * `[05:01] ttl-cache  previous   agent completed (30 turns)`. Elapsed counts from the `run`
 * invocation, the same clock for every side, so the lines read as one timeline. The fixture
 * column is `fixtureWidth` wide: the longest id in the batch.
 */
export function formatProgress(
  elapsedMs: number,
  fixture: string,
  fixtureWidth: number,
  environment: string,
  event: ProgressEvent,
): string {
  return `[${clock(elapsedMs)}] ${fixture.padEnd(fixtureWidth)}  ${environment.padEnd(11)}${progressText(event)}`;
}

/** What `run` says on stderr before any side starts: how much it is about to do. */
export function formatBatchPlan(fixtures: string[]): string {
  const n = fixtures.length;
  return `running ${n} fixture${n === 1 ? "" : "s"} × 2 sides = ${n * 2} runs: ${fixtures.join(", ")}`;
}

/** What `run` says on stderr once every side is done, before the summary: `6 runs finished in 05:12`. */
export function formatRunsFinished(runs: number, elapsedMs: number): string {
  return `${plural(runs, "run")} finished in ${clock(elapsedMs)}`;
}

function progressText(event: ProgressEvent): string {
  switch (event.kind) {
    case "started":
      return "started";
    case "setup": {
      const { result } = event;
      if (result.exitCode === 0 && !result.timedOut) return `setup ok (${result.command}, ${seconds(result.durationMs)})`;
      return `setup failed (${result.command}, ${ended(result)}, ${seconds(result.durationMs)})`;
    }
    case "agent":
      return `agent ${event.outcome} (${plural(event.turns, "turn")})`;
    case "tests": {
      const { result } = event;
      if (result.state === "not run") return "tests not run";
      if (result.state === "none written") return "tests: none written";
      const files = result.files.length === 0 ? "" : `${plural(result.files.length, "file")}, `;
      if (result.state === "passed") return `tests passed (${files}${seconds(result.durationMs)})`;
      return `tests failed (${files}${ended(result)}, ${seconds(result.durationMs)})`;
    }
    case "recorded":
      return `recorded ${RUNS_DIR}/${event.runId}`;
  }
}

/** Printed above every comparison table. Not a warning: it is true of every comparison. */
export const NOISE_LINE =
  "one run per side; deltas below the noise threshold are reported as unchanged";

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** One model when both sides agree, otherwise both, named by side. */
function models(c: Comparison): string {
  const previous = c.previous.model ?? "not reported";
  const candidate = c.candidate.model ?? "not reported";
  return previous === candidate ? previous : `previous ${previous} → candidate ${candidate}`;
}

function isJudgeRow(row: { id: string }): boolean {
  return row.id.startsWith(JUDGE_ROW_PREFIX);
}

/** `judged by anthropic claude-sonnet-4-5`, or `judges: not run` when no verdict exists. */
function judgedLine(c: Comparison): string {
  return c.judged === null ? "judges: not run" : `judged by ${c.judged.provider} ${c.judged.model}`;
}

/** Printed above every roll-up. Its counts are fixtures, and every count names them. */
export const ROLLUP_LINE = "one run per side per fixture; counts are fixtures, names in brackets";

/** Pipes and newlines would break the table; nothing else in a cell needs escaping. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The same table as GitHub-flavoured markdown, self-contained enough to be a PR comment. */
export function formatComparisonMarkdown(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`### harnessbench: \`${c.fixture}\``);
  lines.push("");
  lines.push(
    `Harness \`previous\` ${short(c.previous.harnessSha)} → \`candidate\` ${short(c.candidate.harnessSha)}, ` +
      `both on code ${short(c.headSha)}. Model: ${models(c)}. ` +
      `Runs \`${c.previous.runId}\` and \`${c.candidate.runId}\`.`,
  );
  lines.push("");
  lines.push(`_${NOISE_LINE}_`);
  if (c.warnings.length > 0) {
    lines.push("");
    for (const warning of c.warnings) lines.push(`> **warning:** ${cell(warning)}`);
  }
  if (c.rows.some(isJudgeRow)) {
    lines.push("");
    const sentence = judgedLine(c);
    lines.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  lines.push("");
  lines.push("| Criterion | Previous | Candidate | Delta | Result | Note |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of c.rows) {
    const cells = [row.label, row.previous, row.candidate, row.delta, row.classification, row.note ?? ""];
    lines.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  return lines.join("\n");
}

// --- the batch report ---

/** The rows the Outcome verdict line is made of; every other mechanical row is Efficiency. */
const OUTCOME_ROWS = new Set(["outcome", "tests"]);

/** The worst classification first: a fixture's Outcome is the worst of its outcome and tests rows. */
const SEVERITY: Classification[] = ["regressed", "improved", "unchanged", "n/a"];

/** `harnessbench  2 fixtures · code 9c4c5e2 · previous cca3e7c → candidate 9c4c5e2 · claude-sonnet-5`. */
function reportHeader(report: BatchReport): string {
  return (
    `harnessbench  ${plural(report.fixtures.length, "fixture")} · code ${short(report.headSha)} · ` +
    `previous ${short(report.harness.previous)} → candidate ${short(report.harness.candidate)} · ` +
    `${report.agent.model ?? "model not reported"}`
  );
}

/** `unchanged 2`, or `regressed 1 · unchanged 1`: per compared fixture, the worse of outcome and tests. */
function outcomeVerdict(report: BatchReport): string {
  const counts = new Map<Classification, number>();
  for (const { comparison } of report.fixtures) {
    if (comparison === null) continue;
    const found = comparison.rows.filter((row) => OUTCOME_ROWS.has(row.id)).map((row) => row.classification);
    const worst = SEVERITY.find((each) => found.includes(each)) ?? "n/a";
    counts.set(worst, (counts.get(worst) ?? 0) + 1);
  }
  if (counts.size === 0) return "nothing compared";
  return SEVERITY.filter((each) => counts.has(each))
    .map((each) => `${each} ${counts.get(each)}`)
    .join(" · ");
}

/** `regressed: Turns 2, Cost 2 · improved: Exploring 1`; only rows that moved, `unchanged` when none did. */
function efficiencyVerdict(rollup: Rollup): string {
  const rows = rollup.rows.filter((row) => !isJudgeRow(row) && !OUTCOME_ROWS.has(row.id));
  const moved = (pick: (row: RollupRow) => string[]): string =>
    rows
      .filter((row) => pick(row).length > 0)
      .map((row) => `${row.label} ${pick(row).length}`)
      .join(", ");
  const parts = [
    ["regressed", moved((row) => row.regressed)],
    ["improved", moved((row) => row.improved)],
  ].filter(([, list]) => list !== "");
  if (parts.length === 0) return rows.length === 0 ? "nothing compared" : "unchanged";
  return parts.map(([word, list]) => `${word}: ${list}`).join(" · ");
}

/** `candidate 5 · previous 1 · tie 0`, counted over every fixture and judge; unjudged rows only when there are some. */
function judgesVerdict(rollup: Rollup): string {
  const rows = rollup.rows.filter(isJudgeRow);
  if (rows.length === 0) return "none configured";
  const sum = (pick: (row: RollupRow) => string[]): number => rows.reduce((total, row) => total + pick(row).length, 0);
  const counts = `candidate ${sum((row) => row.improved)} · previous ${sum((row) => row.regressed)} · tie ${sum((row) => row.unchanged)}`;
  const unjudged = sum((row) => row.na);
  return unjudged === 0 ? counts : `${counts} · not judged ${unjudged}`;
}

function verdictLines(report: BatchReport): Array<[string, string]> {
  return [
    ["Outcome", outcomeVerdict(report)],
    ["Efficiency", efficiencyVerdict(report.rollup)],
    ["Judges", judgesVerdict(report.rollup)],
  ];
}

/** The word a judge row's classification stands for: which side it preferred. */
const PREFERENCE: Record<Classification, string> = {
  improved: "candidate",
  regressed: "previous",
  unchanged: "tie",
  "n/a": "not judged",
};

/** `code quality candidate`, one per judge row of the fixture; none when it has no table or no judges. */
function verdictCells(fixture: ReportFixture): string[] {
  const rows = fixture.comparison?.rows.filter(isJudgeRow) ?? [];
  return rows.map((row) => `${row.label.toLowerCase()} ${PREFERENCE[row.classification]}`);
}

/** What a fixture line says instead of verdicts: its error's first line, or why there are none. */
function fixtureStatus(fixture: ReportFixture): string | null {
  if (fixture.error !== null) return `error: ${fixture.error.split("\n")[0] ?? ""}`;
  if (fixture.comparison === null) return "not compared";
  if (verdictCells(fixture).length === 0) return "no judges configured";
  return null;
}

/**
 * What `run`, `compare` and `judge` print by default, one screen at most: the header, any
 * warnings, the three verdict lines, one line per fixture with each judge's preference, and
 * where the full report is (`path`; no line when null). No reasons, no per-side detail.
 */
export function formatSummaryReport(
  report: BatchReport,
  path: string | null = `${reportDir(report.stamp)}/${REPORT_MARKDOWN}`,
): string {
  const lines: string[] = [reportHeader(report), ""];
  for (const warning of report.rollup.warnings) lines.push(`warning: ${warning}`);
  for (const [label, text] of verdictLines(report)) lines.push(`${label.padEnd(12)}${text}`);

  lines.push("");
  const nameWidth = Math.max(0, ...report.fixtures.map((each) => each.fixture.length));
  const cells = report.fixtures.map(verdictCells);
  // Each judge's column as wide as its widest cell, so the preferences line up across fixtures.
  const widths: number[] = [];
  for (const row of cells) row.forEach((text, i) => (widths[i] = Math.max(widths[i] ?? 0, text.length)));
  report.fixtures.forEach((fixture, i) => {
    const text = fixtureStatus(fixture) ?? (cells[i] ?? []).map((each, j) => each.padEnd(widths[j] ?? 0)).join(" · ");
    lines.push(`${fixture.fixture.padEnd(nameWidth)}  ${text}`.trimEnd());
  });

  if (path !== null) {
    lines.push("");
    lines.push(`report  ${path}`);
  }
  return lines.join("\n");
}

/** The report as `--json` prints it and `report.json` holds it. */
export function formatReportJson(report: BatchReport): string {
  return JSON.stringify(report, null, 2);
}

/** The roll-up as a table with fixture names in the cells. */
function rollupMarkdown(rollup: Rollup): string[] {
  const lines: string[] = [];
  lines.push(`_${ROLLUP_LINE}_`);
  lines.push("");
  lines.push("| Criterion | Improved | Regressed | Unchanged | n/a |");
  lines.push("|---|---|---|---|---|");
  for (const row of rollup.rows) {
    const cells = [row.label, row.improved, row.regressed, row.unchanged, row.na].map((each) =>
      cell(Array.isArray(each) ? each.join(", ") : each),
    );
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines;
}

/** `30 (Read 20, Edit 10), 2 failed`. */
function toolCallsText(side: SideSummary): string {
  const byTool = Object.entries(side.toolCalls.byTool).map(([tool, n]) => `${tool} ${n}`);
  const detail = byTool.length === 0 ? "" : ` (${byTool.join(", ")})`;
  return `${side.toolCalls.total}${detail}, ${side.toolFailures} failed`;
}

function tokensText(side: SideSummary): string {
  const { tokens } = side;
  return (
    `in ${formatCount(tokens.input)}, out ${formatCount(tokens.output)}, ` +
    `cache read ${formatCount(tokens.cacheRead)}, cache write ${formatCount(tokens.cacheWrite)}`
  );
}

/**
 * The per-side table: one row per side that finished, previous first. `testLabel` heads the
 * tests column: the comparison's tests row label, which is `config.testLabel`.
 */
function sidesMarkdown(sides: Array<[string, SideSummary]>, testLabel: string): string[] {
  const lines = [
    `| Side | Outcome | Duration | Turns | Tool calls | Tokens | Cost | Setup | ${cell(testLabel)} | Changes |`,
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, side] of sides) {
    const cells = [
      name,
      side.outcome,
      formatDuration(side.durationMs),
      formatCount(side.turns),
      toolCallsText(side),
      tokensText(side),
      side.costUsd === null ? "not reported" : formatUsd(side.costUsd),
      side.setup === null ? "none" : setupLine(side.setup),
      testsLine(side.tests),
      `${plural(side.diff.files, "file")}, +${side.diff.added} / -${side.diff.removed}`,
    ];
    lines.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  return lines;
}

/** One fixture folded into `<details>`: its table, its sides, their final messages, their directories. */
function fixtureMarkdown(fixture: ReportFixture): string[] {
  const verdicts = fixtureStatus(fixture) ?? verdictCells(fixture).join(" · ");
  const lines: string[] = [`<details><summary>${fixture.fixture}: ${verdicts}</summary>`, ""];
  if (fixture.error !== null) {
    lines.push(`> **error:** ${cell(fixture.error)}`);
    lines.push("");
  }
  if (fixture.comparison !== null) {
    lines.push(formatComparisonMarkdown(fixture.comparison));
    lines.push("");
  }
  const sides = (["previous", "candidate"] as const).flatMap((name): Array<[string, SideSummary]> => {
    const side = fixture.sides[name];
    return side === null ? [] : [[name, side]];
  });
  if (sides.length > 0) {
    const testLabel = fixture.comparison?.rows.find((row) => row.id === "tests")?.label ?? DEFAULT_TEST_LABEL;
    lines.push(...sidesMarkdown(sides, testLabel));
    lines.push("");
    for (const [name, side] of sides) {
      lines.push(`**${name}** final message:`);
      lines.push("");
      const message = side.finalMessage.trimEnd();
      lines.push(...(message === "" ? ["_(none)_"] : message.split("\n").map((line) => `> ${line}`.trimEnd())));
      lines.push("");
    }
    lines.push("Run directories:");
    lines.push("");
    for (const [name, side] of sides) lines.push(`- ${name}: \`${side.runDir}\``);
    lines.push("");
  }
  lines.push("</details>");
  return lines;
}

/**
 * The whole report as GitHub-flavoured markdown, for `report.md`, `--detail`, `compare
 * --markdown` and a PR comment: the header, the three verdict lines, warnings, the roll-up
 * table, then each fixture folded into `<details>` with the judges' reasons in full.
 */
export function formatReportMarkdown(report: BatchReport): string {
  const lines: string[] = [`### ${reportHeader(report)}`, ""];
  for (const [label, text] of verdictLines(report)) lines.push(`- **${label}** ${text}`);
  if (report.rollup.warnings.length > 0) {
    lines.push("");
    for (const warning of report.rollup.warnings) lines.push(`> **warning:** ${cell(warning)}`);
  }
  if (report.rollup.rows.length > 0) {
    lines.push("");
    lines.push(...rollupMarkdown(report.rollup));
  }
  for (const fixture of report.fixtures) {
    lines.push("");
    lines.push(...fixtureMarkdown(fixture));
  }
  return lines.join("\n");
}
