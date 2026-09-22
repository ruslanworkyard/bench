import { MAIN_THREAD, type TranscriptEvent, type Usage } from "./agents/types.js";

/**
 * What a run's transcript says about how the agent worked: per thread, before its first
 * edit, and where the wall clock went. Pure, and derived from the normalised transcript
 * only, so every adapter gets it for free and nothing here knows a tool's name.
 */

export type ThreadStats = {
  /** Model responses on this thread: distinct `turn` values, the meaning `RunRecord.turns` has. */
  turns: number;
  toolCalls: number;
  toolFailures: number;
  /**
   * Summed over this thread's messages. `cacheRead` is charged per call, not distinct
   * tokens: the same meaning the run's top-level figure has, sliced by thread.
   */
  tokens: Usage;
};

export type SubAgentStats = ThreadStats & {
  /** The id of the `spawn` tool call that started it; also the thread its events carry. */
  id: string;
  /** The model of its first assistant message; null when it never said. */
  model: string | null;
  /** The name of the spawning tool call. */
  tool: string;
};

export type Telemetry = {
  main: ThreadStats;
  /** In spawning order. Their tokens are part of the run's total, not subtracted from it. */
  subAgents: SubAgentStats[];
  /** Main thread only, before its first `write`. */
  readsBeforeFirstEdit: number;
  turnsBeforeFirstEdit: number;
  /** Distinct paths the main thread read. */
  filesRead: number;
  /** Main-thread reads of a path it had already read. */
  repeatReads: number;
  /** Main-thread reads of a path some sub-agent had read earlier in the run. */
  duplicateReads: number;
  /** Distinct paths written on any thread. */
  filesWritten: number;
  /**
   * Wall clock by phase: exploring is start → first write on any thread, building is first
   * write → last write, verifying is last write → the end. A run with no writes has
   * building = verifying = 0.
   */
  phases: { exploringMs: number; buildingMs: number; verifyingMs: number };
};

function emptyStats(): ThreadStats {
  return {
    turns: 0,
    toolCalls: 0,
    toolFailures: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function telemetry(events: TranscriptEvent[], durationMs: number): Telemetry {
  const main = emptyStats();
  const subAgents: SubAgentStats[] = [];
  const byThread = new Map<string, ThreadStats>([[MAIN_THREAD, main]]);

  /** The sub-agent for `thread`, registered on its spawn or, failing that, its first event. */
  const subAgent = (id: string, tool: string): SubAgentStats => {
    const known = subAgents.find((sub) => sub.id === id);
    if (known !== undefined) return known;
    const created = { ...emptyStats(), id, model: null, tool };
    subAgents.push(created);
    byThread.set(id, created);
    return created;
  };
  const stats = (thread: string): ThreadStats =>
    byThread.get(thread) ?? subAgent(thread, "unknown");

  const seenTurns = new Map<string, Set<number>>();
  let mainHasWritten = false;
  let readsBeforeFirstEdit = 0;
  let turnsBeforeFirstEdit = 0;
  const mainRead = new Set<string>();
  const subRead = new Set<string>();
  let repeatReads = 0;
  let duplicateReads = 0;
  const written = new Set<string>();
  let firstWriteAt: number | null = null;
  let lastWriteAt: number | null = null;

  for (const event of events) {
    const onMain = event.thread === MAIN_THREAD;
    switch (event.type) {
      case "assistant": {
        const thread = stats(event.thread);
        let turns = seenTurns.get(event.thread);
        if (turns === undefined) seenTurns.set(event.thread, (turns = new Set()));
        const newTurn = !turns.has(event.turn);
        turns.add(event.turn);
        if (newTurn) thread.turns++;
        if (event.usage !== null) add(thread.tokens, event.usage);
        if (!onMain) {
          const sub = thread as SubAgentStats;
          if (sub.model === null) sub.model = event.model;
        }
        if (newTurn && onMain && !mainHasWritten) turnsBeforeFirstEdit++;
        break;
      }
      case "tool_call": {
        stats(event.thread).toolCalls++;
        if (event.kind === "spawn") subAgent(event.id, event.tool);
        if (event.kind === "read") {
          if (onMain && !mainHasWritten) readsBeforeFirstEdit++;
          if (event.path !== null) {
            if (onMain) {
              if (mainRead.has(event.path)) repeatReads++;
              if (subRead.has(event.path)) duplicateReads++;
              mainRead.add(event.path);
            } else {
              subRead.add(event.path);
            }
          }
        }
        if (event.kind === "write") {
          if (onMain) mainHasWritten = true;
          if (event.path !== null) written.add(event.path);
          firstWriteAt ??= event.at;
          lastWriteAt = event.at;
        }
        break;
      }
      case "tool_result":
        if (event.isError) stats(event.thread).toolFailures++;
        break;
      case "error":
        break;
    }
  }

  const phases =
    firstWriteAt === null || lastWriteAt === null
      ? { exploringMs: durationMs, buildingMs: 0, verifyingMs: 0 }
      : {
          exploringMs: firstWriteAt,
          buildingMs: lastWriteAt - firstWriteAt,
          verifyingMs: Math.max(0, durationMs - lastWriteAt),
        };

  return {
    main,
    subAgents,
    readsBeforeFirstEdit,
    turnsBeforeFirstEdit,
    filesRead: mainRead.size,
    repeatReads,
    duplicateReads,
    filesWritten: written.size,
    phases,
  };
}

function add(into: Usage, usage: Usage): void {
  into.input += usage.input;
  into.output += usage.output;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
}
