import type { Usage } from "./agents/types.js";
import { rollup, type Comparison, type Rollup } from "./compare.js";
import { RUNS_DIR } from "./config.js";
import type { CommandResult, RunOutcome, RunRecord } from "./run-record.js";

/**
 * One batch as one object: what `run`, `compare` and `judge` print (summary, markdown or JSON)
 * and what
 * `report.md` / `report.json` under `.harnessbench/runs/<stamp>/` hold (`run-record.ts` writes them). Pure: records
 * and comparisons in, the report out; the commands write it and print.ts renders it.
 */

export const REPORT_SCHEMA = 1;

/** One side of one fixture, as data: what the per-run summary used to print. */
export type SideSummary = {
  runId: string;
  outcome: RunOutcome;
  durationMs: number;
  turns: number;
  toolCalls: { total: number; byTool: Record<string, number> };
  toolFailures: number;
  tokens: Usage;
  /** Null when the agent does not report cost. */
  costUsd: number | null;
  /** Null when no setup command is configured. */
  setup: CommandResult | null;
  /** Null when no test command is configured. */
  tests: CommandResult | null;
  diff: RunRecord["diff"];
  finalMessage: string;
  /** Relative to the repository root. */
  runDir: string;
};

export type ReportFixture = {
  fixture: string;
  comparison: Comparison | null;
  sides: { previous: SideSummary | null; candidate: SideSummary | null };
  /** Why there is no comparison, or what went wrong beside one. */
  error: string | null;
};

export type BatchReport = {
  schema: typeof REPORT_SCHEMA;
  stamp: string;
  headSha: string;
  /** The two harness commits. */
  harness: { previous: string; candidate: string };
  agent: { name: string; model: string | null };
  /** Who judged, from the first judged comparison; null when nothing was judged. */
  judge: { provider: string; model: string } | null;
  rollup: Rollup;
  fixtures: ReportFixture[];
};

/** What one fixture brings to a report: the sides that exist, the table if there is one. */
export type ReportInput = {
  fixture: string;
  previous: RunRecord | null;
  candidate: RunRecord | null;
  comparison: Comparison | null;
  error: string | null;
};

/**
 * What the records cannot say when no fixture has a side of that kind: `run` knows the shas
 * and the agent before any side finishes, `compare` and `judge` only have the records.
 */
export type ReportFallback = {
  headSha: string;
  harness: { previous: string; candidate: string };
  agent: { name: string; model: string | null };
};

export function sideSummary(record: RunRecord): SideSummary {
  return {
    runId: record.runId,
    outcome: record.outcome,
    durationMs: record.durationMs,
    turns: record.turns,
    toolCalls: { total: Object.values(record.toolCalls).reduce((sum, n) => sum + n, 0), byTool: record.toolCalls },
    toolFailures: record.toolFailures,
    tokens: record.tokens,
    costUsd: record.costUsd,
    setup: record.setup ?? null,
    tests: record.tests,
    diff: record.diff,
    finalMessage: record.finalMessage,
    runDir: `${RUNS_DIR}/${record.runId}`,
  };
}

/** The batch's report, fixtures in the order given; the roll-up counts only what was compared. */
export function buildReport(stamp: string, inputs: ReportInput[], fallback?: ReportFallback): BatchReport {
  const previous = inputs.flatMap((each) => (each.previous === null ? [] : [each.previous]));
  const candidate = inputs.flatMap((each) => (each.candidate === null ? [] : [each.candidate]));
  const any = candidate[0] ?? previous[0];
  const comparisons = inputs.flatMap((each) => (each.comparison === null ? [] : [each.comparison]));
  const judged = comparisons.find((each) => each.judged !== null)?.judged ?? null;
  return {
    schema: REPORT_SCHEMA,
    stamp,
    headSha: any?.headSha ?? fallback?.headSha ?? "",
    harness: {
      previous: previous[0]?.harness.sha ?? fallback?.harness.previous ?? "",
      candidate: candidate[0]?.harness.sha ?? fallback?.harness.candidate ?? "",
    },
    agent:
      any === undefined
        ? (fallback?.agent ?? { name: "", model: null })
        : { name: any.agent.name, model: any.agent.model },
    judge: judged === null ? null : { provider: judged.provider, model: judged.model },
    rollup: rollup(comparisons),
    fixtures: inputs.map((each) => ({
      fixture: each.fixture,
      comparison: each.comparison,
      sides: {
        previous: each.previous === null ? null : sideSummary(each.previous),
        candidate: each.candidate === null ? null : sideSummary(each.candidate),
      },
      error: each.error,
    })),
  };
}
