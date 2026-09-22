import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

// Type-only, so compare.ts importing the value formatters below is not a cycle.
import type { JudgeRecord } from "./commands/judge.js";
import type { Comparison } from "./compare.js";
import { ENV_FILE, RUNS_DIR } from "./config.js";
import type { HarnessEntry } from "./detect/harness.js";
import type { Detection } from "./detect/types.js";
import type { OpStatus } from "./plan.js";
import type { CommandResult, RunRecord } from "./run-record.js";
import type { Telemetry } from "./telemetry.js";

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

const STDERR_TAIL_LINES = 5;
const FINAL_MESSAGE_LINES = 3;

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

function testsLine(tests: RunRecord["tests"]): string {
  if (tests === null) return "not configured";
  if (tests.timedOut) return `${tests.command} → timed out after ${formatDuration(tests.durationMs)}`;
  if (tests.exitCode === 0) return `${tests.command} → passed in ${formatDuration(tests.durationMs)}`;
  const how = tests.exitCode === null ? "killed" : `exit ${tests.exitCode}`;
  return `${tests.command} → failed, ${how}`;
}

/** `main 23 turns / 41 calls · Explore on claude-haiku-4-5: 12 calls`. */
function threadsLine(t: Telemetry | undefined): string {
  if (t === undefined) return "not recorded";
  const main = `main ${plural(t.main.turns, "turn")} / ${plural(t.main.toolCalls, "call")}`;
  const subs = t.subAgents.map(
    (sub) => `${sub.tool} on ${sub.model ?? "model not reported"}: ${plural(sub.toolCalls, "call")}`,
  );
  return [main, ...subs].join(" · ");
}

function phasesLine(t: Telemetry | undefined): string {
  if (t === undefined) return "not recorded";
  const { exploringMs, buildingMs, verifyingMs } = t.phases;
  return (
    `exploring ${formatDuration(exploringMs)} · building ${formatDuration(buildingMs)} · ` +
    `verifying ${formatDuration(verifyingMs)}`
  );
}

function lastLines(text: string, n: number): string[] {
  return text.trimEnd().split("\n").filter((line) => line !== "").slice(-n);
}

/** One run, summarised. `agentStderrPath` is read only when the outcome is an error. */
export function formatRun(record: RunRecord, agentStderrPath: string): string {
  const lines: string[] = [];
  const when = record.outcome === "completed" ? "in" : "after";
  lines.push(
    `harnessbench run  ${record.fixture} · ${record.environment}  → ` +
      `${record.outcome} ${when} ${formatDuration(record.durationMs)}`,
  );

  const calls = Object.entries(record.toolCalls);
  const total = calls.reduce((sum, [, n]) => sum + n, 0);
  const byTool = calls.length === 0 ? "" : ` (${calls.map(([tool, n]) => `${tool} ${n}`).join(", ")})`;
  const { tokens } = record;

  lines.push("");
  const { harness } = record;
  lines.push(
    `${"Harness".padEnd(11)}${plural(harness.files.length, "file")} at ${harness.sha.slice(0, 7)} ` +
      `(${harness.ref === harness.sha ? "merge base" : harness.ref}) · hash ${harness.hash.slice(0, 12)}`,
  );
  lines.push(`${"Agent".padEnd(11)}${record.agent.name} · ${record.agent.model ?? "model not reported"}`);
  // Records written before the setup step have no such key at all: nothing to show either way.
  if (record.setup) lines.push(`${"Setup".padEnd(11)}${setupLine(record.setup)}`);
  lines.push(
    `${"Turns".padEnd(11)}${String(record.turns).padEnd(5)}Tool calls  ${total}${byTool}   ` +
      `Tool failures ${record.toolFailures}`,
  );
  lines.push(`${"Threads".padEnd(11)}${threadsLine(record.telemetry)}`);
  lines.push(`${"Phases".padEnd(11)}${phasesLine(record.telemetry)}`);
  lines.push(
    `${"Tokens".padEnd(11)}in ${formatCount(tokens.input)}  out ${formatCount(tokens.output)}  ` +
      `cache read ${formatCount(tokens.cacheRead)}  cache write ${formatCount(tokens.cacheWrite)}`,
  );
  lines.push(`${"Cost".padEnd(11)}${record.costUsd === null ? "not reported" : formatUsd(record.costUsd)}`);
  lines.push(
    `${"Changes".padEnd(11)}${plural(record.diff.files, "file")}, +${record.diff.added} / -${record.diff.removed}`,
  );
  lines.push(`${"Tests".padEnd(11)}${testsLine(record.tests)}`);
  lines.push(`${"Run dir".padEnd(11)}${RUNS_DIR}/${record.runId}`);

  lines.push("");
  const message = lastLines(record.finalMessage, Infinity).slice(0, FINAL_MESSAGE_LINES);
  if (message.length === 0) lines.push("Final message: (none)");
  else {
    lines.push(`Final message: ${message[0]}`);
    for (const line of message.slice(1)) lines.push(`${" ".repeat(15)}${line}`);
  }

  if (record.outcome === "error") {
    const stderr = existsSync(agentStderrPath) ? readFileSync(agentStderrPath, "utf8") : "";
    const tail = lastLines(stderr, STDERR_TAIL_LINES);
    lines.push("");
    lines.push(tail.length === 0 ? "Agent stderr: (empty)" : `Agent stderr (last ${tail.length} lines):`);
    for (const line of tail) lines.push(`  ${line}`);
  }

  return lines.join("\n");
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

/** The delta table for one fixture: header, the fixed noise line, warnings, then the rows. */
export function formatComparison(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`harnessbench compare  ${c.fixture} · code ${short(c.headSha)}`);
  lines.push("");
  lines.push(
    `${"Harness".padEnd(11)}previous ${short(c.previous.harnessSha)} → candidate ${short(c.candidate.harnessSha)}`,
  );
  lines.push(`${"Model".padEnd(11)}${models(c)}`);
  lines.push(`${"Runs".padEnd(11)}${c.previous.runId} → ${c.candidate.runId}`);

  lines.push("");
  lines.push(NOISE_LINE);
  for (const warning of c.warnings) lines.push(`warning: ${warning}`);

  lines.push("");
  const cells = c.rows.map((row) => [
    row.label,
    row.previous,
    `→ ${row.candidate}`,
    row.delta,
    row.classification,
    row.note ?? "",
  ]);
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((row) => row[i]?.length ?? 0))) ?? [];
  for (const row of cells) {
    lines.push(
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    );
  }
  return lines.join("\n");
}

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
  lines.push("");
  lines.push("| Criterion | Previous | Candidate | Delta | Result | Note |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of c.rows) {
    const cells = [row.label, row.previous, row.candidate, row.delta, row.classification, row.note ?? ""];
    lines.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  return lines.join("\n");
}

/** `candidate preferred`, `previous preferred` or `tie`: the verdict, in the reader's words. */
function preferenceLabel(preference: JudgeRecord["verdicts"][number]["preference"]): string {
  return preference === "tie" ? "tie" : `${preference} preferred`;
}

/** The verdicts of one judge run: a header naming the pair, then one line per judge. */
export function formatVerdicts(record: JudgeRecord): string {
  const lines: string[] = [];
  lines.push(`harnessbench judge  ${record.fixture} · code ${short(record.headSha)}`);
  lines.push("");
  lines.push(`${"Runs".padEnd(11)}${record.previous.runId} → ${record.candidate.runId}`);
  lines.push(`${"Shown as".padEnd(11)}A = ${record.mapping.A}, B = ${record.mapping.B}`);
  lines.push("");
  if (record.verdicts.length === 0) {
    lines.push("no verdicts");
    return lines.join("\n");
  }
  const titleWidth = Math.max(...record.verdicts.map((verdict) => verdict.title.length));
  const labelWidth = Math.max(...record.verdicts.map((verdict) => preferenceLabel(verdict.preference).length));
  for (const verdict of record.verdicts) {
    const reason = verdict.reason.replace(/\s*\n\s*/g, " ").trim();
    lines.push(
      `${verdict.title.padEnd(titleWidth)}  ${preferenceLabel(verdict.preference).padEnd(labelWidth)}   ${reason}`.trimEnd(),
    );
  }
  return lines.join("\n");
}
