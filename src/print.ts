import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

import { RUNS_DIR } from "./config.js";
import type { HarnessEntry } from "./detect/harness.js";
import type { Detection } from "./detect/types.js";
import type { OpStatus } from "./plan.js";
import type { RunRecord } from "./run-record.js";

export type FileReport = { path: string; status: OpStatus };

/** Everything init found and did. Also the shape printed by --json. */
export type Report = {
  root: string;
  dryRun: boolean;
  harness: HarnessEntry[];
  testCommand: Detection<string> | null;
  agent: Detection<string> | null;
  agentsOnPath: string[];
  baseBranch: Detection<string> | null;
  fixtures: { added: string[]; present: string[] };
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
  lines.push(field("Agent", report.agent, "none found on PATH"));
  lines.push(field("Base branch", report.baseBranch, "none detected"));

  lines.push("");
  const { added, present } = report.fixtures;
  const verb = report.dryRun ? "would add" : "added";
  lines.push(
    `Fixtures      ${added.length > 0 ? `${verb}: ${added.join(", ")}` : `${verb}: none`}`,
  );
  if (present.length > 0) {
    lines.push(`${" ".repeat(LABEL_WIDTH)}already present: ${present.join(", ")}`);
  }

  lines.push("");
  lines.push("Files");
  for (const file of report.files) {
    lines.push(`  ${statusLabel(file.status, report.dryRun).padEnd(16)}${file.path}`);
  }

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

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function testsLine(tests: RunRecord["tests"]): string {
  if (tests === null) return "not configured";
  if (tests.timedOut) return `${tests.command} → timed out after ${duration(tests.durationMs)}`;
  if (tests.exitCode === 0) return `${tests.command} → passed in ${duration(tests.durationMs)}`;
  const how = tests.exitCode === null ? "killed" : `exit ${tests.exitCode}`;
  return `${tests.command} → failed, ${how}`;
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
      `${record.outcome} ${when} ${duration(record.durationMs)}`,
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
  lines.push(
    `${"Turns".padEnd(11)}${String(record.turns).padEnd(5)}Tool calls  ${total}${byTool}   ` +
      `Tool failures ${record.toolFailures}`,
  );
  lines.push(
    `${"Tokens".padEnd(11)}in ${count(tokens.input)}  out ${count(tokens.output)}  ` +
      `cache read ${count(tokens.cacheRead)}  cache write ${count(tokens.cacheWrite)}`,
  );
  lines.push(`${"Cost".padEnd(11)}${record.costUsd === null ? "not reported" : `$${record.costUsd.toFixed(2)}`}`);
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
