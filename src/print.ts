import { relative } from "node:path";

import type { HarnessEntry } from "./detect/harness.js";
import type { Detection } from "./detect/types.js";
import type { FixtureMeta } from "./fixtures.js";
import type { OpStatus } from "./plan.js";

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

/** Everything `run` has established before it does any work. */
export type RunPlan = {
  root: string;
  head: string;
  baseBranch: string;
  baseSha: string;
  agent: string;
  agentPath: string;
  fixture: FixtureMeta;
  dirtyHarness: string[];
};

export function formatRunPlan(plan: RunPlan): string {
  const lines: string[] = [];
  lines.push(`harnessbench run  ${plan.fixture.id}`);

  lines.push("");
  lines.push(`${"Repo".padEnd(LABEL_WIDTH)}${plan.root}`);
  lines.push(`${"HEAD".padEnd(LABEL_WIDTH)}${plan.head}`);
  lines.push(`${"Base branch".padEnd(LABEL_WIDTH)}${plan.baseBranch.padEnd(24)}${plan.baseSha}`);
  lines.push(`${"Agent".padEnd(LABEL_WIDTH)}${plan.agent.padEnd(24)}${plan.agentPath}`);
  lines.push(`${"Fixture".padEnd(LABEL_WIDTH)}${plan.fixture.id.padEnd(24)}${plan.fixture.description}`);

  if (plan.dirtyHarness.length > 0) {
    lines.push("");
    lines.push("! these harness files have uncommitted changes; the run will use the");
    lines.push("! committed version of each:");
    for (const path of plan.dirtyHarness) lines.push(`!   ${path}`);
  }

  lines.push("");
  lines.push(`Next: nothing yet - run stops after preflight; the agent is not executed.`);
  return lines.join("\n");
}
