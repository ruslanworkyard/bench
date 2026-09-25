import type { ToolKind } from "../agents/types.js";
import type { RunEvent } from "../events.js";
import type { Environment, RunOutcome } from "../run-record.js";

/**
 * What the live board shows, folded from events by `reduce`: pure, no clock, no I/O. Nothing
 * here compares or scores; it only remembers what the events said.
 */

export type Phase = "queued" | "setup" | "agent" | "tests" | "done" | "failed";

/** The sparkline's window: output tokens of the last this-many turns. */
export const SPARK_TURNS = 20;
/** Tool lines kept per side for the follow pane; older ones are dropped. */
export const TOOL_LINES = 500;

export type ToolLine = { thread: string; kind: ToolKind; label: string; failed: boolean };

export type SideState = {
  phase: Phase;
  /** How the previous phase ended, in the progress line's words. */
  detail: string | null;
  turns: number;
  costUsd: number | null;
  /** Output tokens per turn, the last `SPARK_TURNS` of them. */
  outputs: number[];
  /** The running output total at the last turn, to take the next turn's share from. */
  outputTotal: number;
  outcome: RunOutcome | null;
  tools: ToolLine[];
};

export type JudgeChip = { judge: string; verdict: Environment | "tie" | "failed" | null };

export type FixtureState = { id: string; sides: Record<Environment, SideState>; judges: JudgeChip[] };

export type BoardState = {
  stamp: string | null;
  harness: { previous: string; candidate: string } | null;
  harnessFilesChanged: number | null;
  sameHarness: boolean;
  model: string | null;
  fixtures: FixtureState[];
  /** The latest event's clock. */
  lastAt: number;
  done: { durationMs: number; exitCode: number } | null;
};

export const initialState: BoardState = {
  stamp: null,
  harness: null,
  harnessFilesChanged: null,
  sameHarness: false,
  model: null,
  fixtures: [],
  lastAt: 0,
  done: null,
};

function side(): SideState {
  return { phase: "queued", detail: null, turns: 0, costUsd: null, outputs: [], outputTotal: 0, outcome: null, tools: [] };
}

function fixture(id: string): FixtureState {
  return { id, sides: { previous: side(), candidate: side() }, judges: [] };
}

/** The state with fixture `id` changed by `change`; a fixture no `batch.start` named (a `judge` session) is added. */
function withFixture(state: BoardState, id: string, change: (each: FixtureState) => FixtureState): BoardState {
  const known = state.fixtures.some((each) => each.id === id);
  const fixtures = known ? state.fixtures : [...state.fixtures, fixture(id)];
  return { ...state, fixtures: fixtures.map((each) => (each.id === id ? change(each) : each)) };
}

function withSide(
  state: BoardState,
  ref: { fixture: string; environment: Environment },
  change: (each: SideState) => SideState,
): BoardState {
  return withFixture(state, ref.fixture, (each) => ({
    ...each,
    sides: { ...each.sides, [ref.environment]: change(each.sides[ref.environment]) },
  }));
}

function withChip(state: BoardState, id: string, judge: string, verdict: JudgeChip["verdict"]): BoardState {
  return withFixture(state, id, (each) => {
    const known = each.judges.some((chip) => chip.judge === judge);
    const judges = known ? each.judges : [...each.judges, { judge, verdict: null }];
    return { ...each, judges: judges.map((chip) => (chip.judge === judge ? { judge, verdict } : chip)) };
  });
}

/**
 * A failed result marks the latest matching call on its thread, which the stream already
 * reported; a failure with no call to mark is listed on its own.
 */
function addTool(tools: ToolLine[], line: ToolLine): ToolLine[] {
  if (line.failed) {
    for (let i = tools.length - 1; i >= 0; i--) {
      const each = tools[i] as ToolLine;
      if (!each.failed && each.thread === line.thread && each.label === line.label) {
        return [...tools.slice(0, i), { ...each, failed: true }, ...tools.slice(i + 1)];
      }
    }
  }
  return [...tools, line].slice(-TOOL_LINES);
}

export function reduce(state: BoardState, event: RunEvent): BoardState {
  const next = { ...state, lastAt: Math.max(state.lastAt, event.at) };
  switch (event.type) {
    case "batch.start":
      return {
        ...next,
        stamp: event.stamp,
        harness: event.harness,
        harnessFilesChanged: event.harnessFilesChanged ?? null,
        sameHarness: event.sameHarness,
        model: event.agent.model,
        fixtures: event.fixtures.map((id) => state.fixtures.find((each) => each.id === id) ?? fixture(id)),
      };
    case "side.phase":
      return withSide(next, event.side, (each) => ({ ...each, phase: event.phase, detail: event.detail ?? each.detail }));
    case "side.turn":
      return withSide(next, event.side, (each) => ({
        ...each,
        turns: event.turn,
        costUsd: event.costUsd ?? each.costUsd,
        outputs: [...each.outputs, Math.max(0, event.tokens.output - each.outputTotal)].slice(-SPARK_TURNS),
        outputTotal: event.tokens.output,
      }));
    case "side.tool": {
      const line = { thread: event.thread, kind: event.kind, label: event.label, failed: event.failed };
      return withSide(next, event.side, (each) => ({ ...each, tools: addTool(each.tools, line) }));
    }
    case "side.done":
      return withSide(next, event.side, (each) => ({ ...each, outcome: event.outcome }));
    case "judge.start":
      return withChip(next, event.fixture, event.judge, null);
    case "judge.verdict":
      return withChip(next, event.fixture, event.judge, event.preference);
    case "judge.failed":
      return withChip(next, event.fixture, event.judge, "failed");
    case "batch.done":
      return { ...next, done: { durationMs: event.durationMs, exitCode: event.exitCode } };
  }
}

/**
 * Sides finished (done or failed) over all sides; for a `judge` session, which has no
 * `batch.start` and no sides, judge calls settled over judge calls started.
 */
export function progress(state: BoardState): { done: number; total: number; unit: "sides" | "judges" } {
  if (state.stamp === null) {
    const chips = state.fixtures.flatMap((each) => each.judges);
    return { done: chips.filter((each) => each.verdict !== null).length, total: chips.length, unit: "judges" };
  }
  const sides = state.fixtures.flatMap((each) => [each.sides.previous, each.sides.candidate]);
  const done = sides.filter((each) => each.phase === "done" || each.phase === "failed").length;
  return { done, total: sides.length, unit: "sides" };
}
