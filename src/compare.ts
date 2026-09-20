import { formatCount, formatDuration, formatUsd } from "./print.js";
import type { RunRecord } from "./run-record.js";

/**
 * Two runs of one fixture on the same code, one per environment, turned into a table of
 * per-criterion deltas. Pure: the command loads and validates the pair, print.ts renders.
 * Rows are never rolled into a score; the classification word is the whole verdict.
 */

export type Classification = "improved" | "regressed" | "unchanged" | "n/a";

export type Row = {
  /** Stable machine id: "outcome", "tests", "turns", ... Judges add their own later. */
  id: string;
  /** What the table prints. */
  label: string;
  /** Already formatted for display. */
  previous: string;
  candidate: string;
  /** "" when a delta is meaningless. */
  delta: string;
  classification: Classification;
  /** Why n/a, or "within noise". */
  note?: string;
};

export type Comparison = {
  fixture: string;
  headSha: string;
  previous: { runId: string; harnessSha: string; model: string | null };
  candidate: { runId: string; harnessSha: string; model: string | null };
  rows: Row[];
  /** Things the reader must know before trusting the rows. */
  warnings: string[];
};

type Side = "previous" | "candidate";

/**
 * A numeric row: lower is better for all of them. A delta counts as signal only when it
 * clears both the relative threshold and the absolute floor, so 2 → 3 turns is never a
 * regression. `delta` picks how the change is shown: a signed count or a percentage.
 */
type NumericSpec = {
  id: string;
  label: string;
  /** Null when this side does not have the value (cost not reported). */
  value: (record: RunRecord) => number | null;
  format: (n: number) => string;
  delta: "count" | "percent";
  relative: number;
  floor: number;
  /** The note when `value` is null; only rows that can be null need one. */
  missing?: string;
};

const NUMERIC_ROWS: NumericSpec[] = [
  {
    id: "diff.files",
    label: "Files changed",
    value: (r) => r.diff.files,
    format: formatCount,
    delta: "count",
    relative: 0.2,
    floor: 1,
  },
  {
    id: "diff.lines",
    label: "Lines changed",
    value: (r) => r.diff.added + r.diff.removed,
    format: formatCount,
    delta: "percent",
    relative: 0.2,
    floor: 20,
  },
  {
    id: "turns",
    label: "Turns",
    value: (r) => r.turns,
    format: formatCount,
    delta: "count",
    relative: 0.15,
    floor: 3,
  },
  {
    id: "toolCalls",
    label: "Tool calls",
    value: (r) => Object.values(r.toolCalls).reduce((sum, n) => sum + n, 0),
    format: formatCount,
    delta: "count",
    relative: 0.15,
    floor: 3,
  },
  {
    id: "toolFailures",
    label: "Tool failures",
    value: (r) => r.toolFailures,
    format: formatCount,
    delta: "count",
    relative: 0.15,
    floor: 1,
  },
  {
    id: "tokens.total",
    label: "Tokens",
    value: (r) => r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite,
    format: formatCount,
    delta: "percent",
    relative: 0.15,
    floor: 0,
  },
  {
    id: "tokens.output",
    label: "Output tokens",
    value: (r) => r.tokens.output,
    format: formatCount,
    delta: "percent",
    relative: 0.15,
    floor: 0,
  },
  {
    id: "costUsd",
    label: "Cost",
    value: (r) => r.costUsd,
    format: formatUsd,
    delta: "percent",
    relative: 0.15,
    floor: 0,
    missing: "cost not reported",
  },
  {
    id: "durationMs",
    label: "Duration",
    value: (r) => r.durationMs,
    format: formatDuration,
    delta: "percent",
    relative: 0.15,
    floor: 0,
  },
];

/** Rows from this one down measure effort, which a run that was cut off did not finish spending. */
const FIRST_EFFORT_ROW = "turns";

export function compare(previous: RunRecord, candidate: RunRecord): Comparison {
  const warnings: string[] = [];
  const incomplete: Side[] = [];
  for (const [side, record] of [
    ["previous", previous],
    ["candidate", candidate],
  ] as const) {
    if (record.outcome !== "completed") {
      incomplete.push(side);
      warnings.push(
        `${side} did not complete (${record.outcome}); its effort rows are not comparable`,
      );
    }
  }
  if (previous.agent.model !== candidate.agent.model) {
    warnings.push(
      `models differ: previous ${modelName(previous)}, candidate ${modelName(candidate)}`,
    );
  }
  if (previous.harness.hash === candidate.harness.hash) {
    warnings.push(
      `both sides ran the same harness (hash ${previous.harness.hash.slice(0, 12)}); ` +
        "any delta is noise, not the effect of a change",
    );
  }
  if (invocation(previous) !== invocation(candidate)) {
    warnings.push(
      `the runs come from different \`run\` invocations (${previous.runId}, ${candidate.runId})`,
    );
  }

  const rows: Row[] = [outcomeRow(previous, candidate), testsRow(previous, candidate)];
  let effort = false;
  for (const spec of NUMERIC_ROWS) {
    if (spec.id === FIRST_EFFORT_ROW) effort = true;
    if (effort && incomplete.length > 0) {
      rows.push({
        ...displayOnly(spec, previous, candidate),
        classification: "n/a",
        note: incomplete.map((side) => `${side} did not complete`).join("; "),
      });
    } else {
      rows.push(numericRow(spec, previous, candidate));
    }
  }

  return {
    fixture: candidate.fixture,
    headSha: candidate.headSha,
    previous: sideSummary(previous),
    candidate: sideSummary(candidate),
    rows,
    warnings,
  };
}

function sideSummary(record: RunRecord): Comparison["previous"] {
  return { runId: record.runId, harnessSha: record.harness.sha, model: record.agent.model };
}

function modelName(record: RunRecord): string {
  return record.agent.model ?? "not reported";
}

/** The `run` invocation a record came from: its run id without `-<fixture>-<environment>`. */
function invocation(record: RunRecord): string {
  const suffix = `-${record.fixture}-${record.environment}`;
  return record.runId.endsWith(suffix) ? record.runId.slice(0, -suffix.length) : record.runId;
}

/** Best-is-a-state rows: improved when only the candidate reached the best state. */
function stateClassification(previousBest: boolean, candidateBest: boolean): Classification {
  if (candidateBest && !previousBest) return "improved";
  if (previousBest && !candidateBest) return "regressed";
  return "unchanged";
}

function outcomeRow(previous: RunRecord, candidate: RunRecord): Row {
  return {
    id: "outcome",
    label: "Outcome",
    previous: previous.outcome,
    candidate: candidate.outcome,
    delta: "",
    classification: stateClassification(
      previous.outcome === "completed",
      candidate.outcome === "completed",
    ),
  };
}

function testsState(record: RunRecord): "passed" | "failed" | "not configured" {
  if (record.tests === null) return "not configured";
  return record.tests.exitCode === 0 && !record.tests.timedOut ? "passed" : "failed";
}

function testsRow(previous: RunRecord, candidate: RunRecord): Row {
  const before = testsState(previous);
  const after = testsState(candidate);
  const row: Row = {
    id: "tests",
    label: "Tests",
    previous: before,
    candidate: after,
    delta: "",
    classification: "n/a",
  };
  if (before === "not configured" || after === "not configured") {
    return { ...row, note: "no test command configured" };
  }
  return { ...row, classification: stateClassification(before === "passed", after === "passed") };
}

/** The row with both values shown and no judgement; the caller fills in the rest. */
function displayOnly(spec: NumericSpec, previous: RunRecord, candidate: RunRecord) {
  const before = spec.value(previous);
  const after = spec.value(candidate);
  return {
    id: spec.id,
    label: spec.label,
    previous: before === null ? "n/a" : spec.format(before),
    candidate: after === null ? "n/a" : spec.format(after),
    delta: "",
  };
}

function numericRow(spec: NumericSpec, previous: RunRecord, candidate: RunRecord): Row {
  const row = displayOnly(spec, previous, candidate);
  const before = spec.value(previous);
  const after = spec.value(candidate);
  if (before === null || after === null) {
    return { ...row, classification: "n/a", note: spec.missing };
  }

  const change = after - before;
  if (change === 0) return { ...row, classification: "unchanged" };

  const delta = spec.delta === "count" || before === 0 ? signedCount(change) : percent(change, before);
  const relative = before === 0 ? Infinity : Math.abs(change) / before;
  const significant = Math.abs(change) >= spec.floor && relative >= spec.relative;
  if (!significant) return { ...row, delta, classification: "unchanged", note: "within noise" };
  return { ...row, delta, classification: change < 0 ? "improved" : "regressed" };
}

function signedCount(change: number): string {
  return `${change < 0 ? "-" : "+"}${formatCount(Math.abs(change))}`;
}

function percent(change: number, base: number): string {
  const pct = Math.round((Math.abs(change) / base) * 100);
  return `${change < 0 ? "-" : "+"}${pct < 1 ? "<1" : String(pct)}%`;
}
