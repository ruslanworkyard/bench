// Type-only: commands/judge.ts imports commands/compare.ts, which imports this file.
import type { JudgeRecord, VerdictRecord } from "./commands/judge.js";
import { formatCount, formatDuration, formatUsd } from "./print.js";
import type { RunRecord } from "./run-record.js";
import type { Telemetry } from "./telemetry.js";

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
  /** Who judged, from the first verdict; null when no verdict exists (or no judges are configured). */
  judged: { model: string; provider: string } | null;
};

/** What the judge rows are built from: the pair's judge.json, if any, and the judges the config names. */
export type JudgeInput = {
  record: JudgeRecord | null;
  /** In config order, each with the hash of its rubric as it is now. */
  configured: Array<{ id: string; title: string; hash: string }>;
};

/** Judge rows are `judge.<judge-id>`; print.ts sets them apart from the mechanical rows by this. */
export const JUDGE_ROW_PREFIX = "judge.";

/**
 * One criterion across a batch: which fixtures improved, regressed, stayed put or had no
 * verdict. Names, not just counts, so a "2 regressed" always says which two. Nothing here
 * sums across criteria.
 */
export type RollupRow = {
  id: string;
  label: string;
  improved: string[];
  regressed: string[];
  unchanged: string[];
  na: string[];
};

export type Rollup = {
  fixtures: number;
  rows: RollupRow[];
  /** Every fixture's warnings, each prefixed with its fixture id. */
  warnings: string[];
};

const BUCKETS: Record<Classification, keyof Omit<RollupRow, "id" | "label">> = {
  improved: "improved",
  regressed: "regressed",
  unchanged: "unchanged",
  "n/a": "na",
};

/**
 * The per-fixture comparisons of one batch folded into one row per criterion. Rows keep the
 * order of the first comparison that has them, mechanical rows before judge rows whichever
 * comparison introduced them, so a fixture without judge rows never reorders the rest.
 */
export function rollup(comparisons: Comparison[]): Rollup {
  const rows = new Map<string, RollupRow>();
  for (const judge of [false, true]) {
    for (const comparison of comparisons) {
      for (const row of comparison.rows) {
        if (row.id.startsWith(JUDGE_ROW_PREFIX) !== judge) continue;
        const entry = rows.get(row.id) ?? { id: row.id, label: row.label, improved: [], regressed: [], unchanged: [], na: [] };
        rows.set(row.id, entry);
        entry[BUCKETS[row.classification]].push(comparison.fixture);
      }
    }
  }
  return {
    fixtures: comparisons.length,
    rows: [...rows.values()],
    warnings: comparisons.flatMap((c) => c.warnings.map((warning) => `${c.fixture}: ${warning}`)),
  };
}

type Side = "previous" | "candidate";

/**
 * A numeric row: lower is better for all of them but the `neutral` ones. A delta counts as
 * signal only when it clears both the relative threshold and the absolute floor, so 2 → 3
 * turns is never a regression. `delta` picks how the change is shown: a signed count or a
 * percentage.
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
  /** Neither direction is better: always `unchanged`, with the delta shown. */
  neutral?: true;
  /** A note for a row both sides have a value for. */
  note?: (previous: RunRecord, candidate: RunRecord) => string | undefined;
};

/** Rows read from `telemetry` are n/a on a record from before it was recorded. */
const EARLIER_VERSION = "recorded by an earlier version";

function fromTelemetry(pick: (t: Telemetry) => number): NumericSpec["value"] {
  return (record) => (record.telemetry === undefined ? null : pick(record.telemetry));
}

function subAgentCalls(t: Telemetry): number {
  return t.subAgents.reduce((sum, sub) => sum + sub.toolCalls, 0);
}

/** `Explore on claude-haiku-4-5, Task on claude-sonnet-5`, or "none". */
function subAgentModels(record: RunRecord): string {
  const subs = record.telemetry?.subAgents ?? [];
  if (subs.length === 0) return "none";
  return subs.map((sub) => `${sub.tool} on ${sub.model ?? "model not reported"}`).join(", ");
}

function subAgentsNote(previous: RunRecord, candidate: RunRecord): string | undefined {
  const before = subAgentModels(previous);
  const after = subAgentModels(candidate);
  if (before === after) return before === "none" ? undefined : before;
  return `previous ${before} → candidate ${after}`;
}

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
    id: "toolCalls.main",
    label: "Tool calls (main)",
    value: fromTelemetry((t) => t.main.toolCalls),
    format: formatCount,
    delta: "count",
    relative: 0.15,
    floor: 3,
    missing: EARLIER_VERSION,
  },
  {
    id: "toolCalls.sub",
    label: "Tool calls (sub-agents)",
    value: fromTelemetry(subAgentCalls),
    format: formatCount,
    delta: "count",
    relative: 0.15,
    floor: 3,
    missing: EARLIER_VERSION,
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
    id: "subAgents",
    label: "Sub-agents",
    value: fromTelemetry((t) => t.subAgents.length),
    format: formatCount,
    delta: "count",
    relative: 0,
    floor: 0,
    missing: EARLIER_VERSION,
    neutral: true,
    note: subAgentsNote,
  },
  {
    id: "readsBeforeFirstEdit",
    label: "Reads before first edit",
    value: fromTelemetry((t) => t.readsBeforeFirstEdit),
    format: formatCount,
    delta: "count",
    relative: 0.2,
    floor: 3,
    missing: EARLIER_VERSION,
  },
  {
    id: "duplicateReads",
    label: "Duplicate reads",
    value: fromTelemetry((t) => t.duplicateReads),
    format: formatCount,
    delta: "count",
    relative: 0.2,
    floor: 2,
    missing: EARLIER_VERSION,
  },
  {
    id: "tokens.mainCacheRead",
    label: "Main-thread cache read",
    value: fromTelemetry((t) => t.main.tokens.cacheRead),
    format: formatCount,
    delta: "percent",
    relative: 0.15,
    floor: 0,
    missing: EARLIER_VERSION,
  },
  {
    id: "phases.exploringMs",
    label: "Exploring",
    value: fromTelemetry((t) => t.phases.exploringMs),
    format: formatDuration,
    delta: "percent",
    relative: 0.15,
    floor: 0,
    missing: EARLIER_VERSION,
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

export function compare(previous: RunRecord, candidate: RunRecord, judgement: JudgeInput | null): Comparison {
  const warnings: string[] = [];
  const incomplete: Side[] = [];
  for (const [side, record] of [
    ["previous", previous],
    ["candidate", candidate],
  ] as const) {
    if (record.outcome !== "completed") {
      incomplete.push(side);
      const what =
        record.outcome === "max_turns"
          ? `hit the turn limit (${formatCount(record.turns)} turns)`
          : `did not complete (${record.outcome})`;
      warnings.push(`${side} ${what}; its effort rows are not comparable`);
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

  let judged: Comparison["judged"] = null;
  if (judgement !== null) {
    rows.push(...judgeRows(judgement, candidate.fixture));
    judged = judgedBy(judgement.record?.verdicts ?? [], warnings);
  }

  return {
    fixture: candidate.fixture,
    headSha: candidate.headSha,
    previous: sideSummary(previous),
    candidate: sideSummary(candidate),
    rows,
    warnings,
    judged,
  };
}

/**
 * One row per configured judge, in config order, then one per verdict in the file for a judge
 * the config no longer names. A verdict is fresh only when its rubric hash matches the rubric
 * as it is now; a verdict from before hashes existed has none and is stale.
 */
function judgeRows(judgement: JudgeInput, fixture: string): Row[] {
  const verdicts = judgement.record?.verdicts ?? [];
  const byJudge = new Map(verdicts.map((verdict) => [verdict.judge, verdict]));
  const rerun = `run harnessbench judge --fixture ${fixture}`;
  const rows: Row[] = [];
  for (const configured of judgement.configured) {
    const verdict = byJudge.get(configured.id);
    if (verdict === undefined) {
      rows.push({
        id: `${JUDGE_ROW_PREFIX}${configured.id}`,
        label: configured.title,
        previous: "",
        candidate: "",
        delta: "",
        classification: "n/a",
        note: `not judged; ${rerun}`,
      });
    } else if (verdict.rubricHash === configured.hash) {
      rows.push(verdictRow(verdict, configured.title, verdict.reason));
    } else {
      rows.push(verdictRow(verdict, configured.title, `${verdict.reason} — rubric changed since this verdict; ${rerun}`));
    }
  }
  const configuredIds = new Set(judgement.configured.map((each) => each.id));
  for (const verdict of verdicts) {
    if (configuredIds.has(verdict.judge)) continue;
    rows.push(verdictRow(verdict, verdict.title, `${verdict.reason} — no longer in config.judges`));
  }
  return rows;
}

function verdictRow(verdict: VerdictRecord, label: string, note: string): Row {
  const classification: Classification =
    verdict.preference === "candidate" ? "improved" : verdict.preference === "previous" ? "regressed" : "unchanged";
  return {
    id: `${JUDGE_ROW_PREFIX}${verdict.judge}`,
    label,
    previous: "",
    candidate: "",
    delta: verdict.preference === "tie" ? "tie" : `${verdict.preference} preferred`,
    classification,
    note: note.replace(/\s*\n\s*/g, " ").trim(),
  };
}

/** The first verdict's model; a warning when the file's verdicts do not agree on one. */
function judgedBy(verdicts: VerdictRecord[], warnings: string[]): Comparison["judged"] {
  const first = verdicts[0];
  if (first === undefined) return null;
  const name = (verdict: VerdictRecord): string => `${verdict.provider} ${verdict.model}`;
  const others = [...new Set(verdicts.map(name))].filter((each) => each !== name(first));
  if (others.length > 0) {
    warnings.push(`judges disagree on the model: ${name(first)} is shown; also ${others.join(", ")}`);
  }
  return { model: first.model, provider: first.provider };
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

  // A note only when there is one: a `note: undefined` key would not survive --json.
  const noted = spec.note?.(previous, candidate);
  const note = noted === undefined ? {} : { note: noted };
  const change = after - before;
  if (change === 0) return { ...row, classification: "unchanged", ...note };

  const delta = spec.delta === "count" || before === 0 ? signedCount(change) : percent(change, before);
  if (spec.neutral) return { ...row, delta, classification: "unchanged", ...note };
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
