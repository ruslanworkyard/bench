import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { RunEvent } from "../events.js";
import { SPARK_TURNS, initialState, progress, reduce, type BoardState } from "./state.js";

/** A recorded batch from the fake agent (one fixture, both sides, three judges), as `run` wrote it. */
function recordedEvents(): RunEvent[] {
  const path = fileURLToPath(new URL("../../test/fixtures/events.jsonl", import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunEvent);
}

function fold(events: RunEvent[]): BoardState {
  return events.reduce(reduce, initialState);
}

test("the recorded batch folds into its header, phases, turns and cost", () => {
  const state = fold(recordedEvents());
  assert.equal(state.stamp, "20260925-040217");
  assert.equal(state.harnessFilesChanged, 1);
  assert.equal(state.model, "claude-opus-5");
  assert.equal(state.sameHarness, false);
  assert.deepEqual(state.done, { durationMs: 20400, exitCode: 0 });
  assert.deepEqual(state.fixtures.map((each) => each.id), ["ttl-cache"]);
  for (const side of Object.values(state.fixtures[0]!.sides)) {
    assert.equal(side.phase, "done");
    assert.equal(side.outcome, "completed");
    assert.equal(side.turns, 9);
    assert.equal(side.costUsd, 0.42);
    assert.equal(side.detail, "tests passed (0.0s)");
  }
  assert.deepEqual(progress(state), { done: 2, total: 2, unit: "sides" });
});

test("phases follow the events as they arrive", () => {
  const events = recordedEvents();
  const firstAgent = events.findIndex((each) => each.type === "side.phase" && each.phase === "agent");
  const state = fold(events.slice(0, firstAgent + 1));
  const { previous, candidate } = state.fixtures[0]!.sides;
  assert.equal(previous.phase, "setup");
  assert.equal(candidate.phase, "agent");
  assert.deepEqual(progress(state), { done: 0, total: 2, unit: "sides" });
});

test("the sparkline holds each turn's own output tokens, the last 20 turns", () => {
  const state = fold(recordedEvents());
  // Running totals 20, 22, 28, 34, 40, 42, 44, 46, 48.
  assert.deepEqual(state.fixtures[0]!.sides.previous.outputs, [20, 2, 6, 6, 6, 2, 2, 2, 2]);

  const side = { fixture: "f", environment: "previous" as const };
  const turns: RunEvent[] = Array.from({ length: 30 }, (_, i) => ({
    at: i,
    type: "side.turn",
    side,
    turn: i + 1,
    tokens: { input: 0, output: (i + 1) * 10, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
  }));
  const long = fold(turns).fixtures[0]!.sides.previous;
  assert.equal(long.outputs.length, SPARK_TURNS);
  assert.equal(long.turns, 30);
  assert.equal(long.costUsd, null);
});

test("tool calls keep their thread, and a failed result marks its call", () => {
  const tools = fold(recordedEvents()).fixtures[0]!.sides.candidate.tools;
  assert.deepEqual(
    tools.map((each) => [each.thread, each.label, each.failed]),
    [
      ["main", "spawn Task", false],
      ["toolu_task", "read /tmp/harnessbench/run/tree/src/cache.ts", false],
      ["toolu_task", "search Grep", false],
      ["main", "read /tmp/harnessbench/run/tree/src/cache.ts", false],
      ["main", "write /tmp/harnessbench/run/tree/src/cache.ts", false],
      ["main", "read /etc/hosts", true],
    ],
  );
});

test("judge chips appear on judge.start and fill as verdicts arrive", () => {
  const events = recordedEvents();
  const started = events.map((each) => each.type).lastIndexOf("judge.start");
  const pending = fold(events.slice(0, started + 1)).fixtures[0]!.judges;
  assert.deepEqual(pending.map((each) => each.verdict), [null, null, null]);

  const judges = fold(events).fixtures[0]!.judges;
  assert.deepEqual(
    judges.map((each) => [each.judge, each.verdict]),
    [
      ["code-quality", "candidate"],
      ["engineering-practices", "failed"],
      ["test-quality", "tie"],
    ],
  );
});

test("a judge session without batch.start adds its fixtures and counts judge calls", () => {
  const state = fold([
    { at: 1, type: "judge.start", fixture: "a", judge: "code-quality" },
    { at: 2, type: "judge.start", fixture: "b", judge: "code-quality" },
    { at: 3, type: "judge.verdict", fixture: "a", judge: "code-quality", preference: "previous", durationMs: 2, upstream: null },
  ]);
  assert.deepEqual(state.fixtures.map((each) => each.id), ["a", "b"]);
  assert.deepEqual(progress(state), { done: 1, total: 2, unit: "judges" });
});
