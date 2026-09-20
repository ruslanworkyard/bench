import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolKind, TranscriptEvent, Usage } from "./agents/types.js";
import { telemetry } from "./telemetry.js";

/** Hand-built events. `at` climbs by 100 per event so phases are easy to read off. */
let clock = 0;
function next(): number {
  clock += 100;
  return clock;
}

const USAGE: Usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 };

function said(thread: string, model = "claude-opus-5", usage: Usage | null = USAGE): TranscriptEvent {
  return { thread, at: next(), type: "assistant", text: "...", model, usage };
}

function call(thread: string, id: string, tool: string, kind: ToolKind, path: string | null = null): TranscriptEvent {
  return { thread, at: next(), type: "tool_call", id, tool, input: {}, kind, path };
}

function result(thread: string, id: string, isError = false): TranscriptEvent {
  return { thread, at: next(), type: "tool_result", id, isError, output: "" };
}

/**
 * Main reads a.ts, spawns an Explore sub-agent that reads b.ts and c.ts, then main re-reads
 * a.ts (repeat) and reads b.ts (duplicate), edits a.ts and b.ts, and runs the tests.
 */
function run(): TranscriptEvent[] {
  clock = 0;
  return [
    said("main"),
    call("main", "r1", "Read", "read", "a.ts"),
    result("main", "r1"),
    said("main"),
    call("main", "spawn1", "Task", "spawn"),
    said("spawn1", "claude-haiku-4-5", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    call("spawn1", "s1", "Read", "read", "b.ts"),
    result("spawn1", "s1"),
    said("spawn1", "claude-haiku-4-5", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    call("spawn1", "s2", "Read", "read", "c.ts"),
    result("spawn1", "s2", true),
    call("spawn1", "s3", "Grep", "search"),
    result("spawn1", "s3"),
    said("spawn1", "claude-haiku-4-5", null),
    result("main", "spawn1"),
    said("main"),
    call("main", "r2", "Read", "read", "a.ts"), // repeat
    result("main", "r2"),
    call("main", "r3", "Read", "read", "b.ts"), // duplicate of the sub-agent's read
    result("main", "r3"),
    call("main", "r4", "Read", "read", null), // unknown path: counted as a read, not a file
    result("main", "r4"),
    said("main"),
    call("main", "w1", "Edit", "write", "a.ts"), // at 2400: first write
    result("main", "w1"),
    said("main"),
    call("main", "w2", "Write", "write", "b.ts"), // at 2700: last write
    result("main", "w2", true),
    said("main"),
    call("main", "r5", "Read", "read", "a.ts"), // after the first edit: not counted before it
    result("main", "r5"),
    call("main", "b1", "Bash", "shell"),
    result("main", "b1"),
    said("main", "claude-opus-5", null),
  ];
}

test("one sub-agent: every field", () => {
  const t = telemetry(run(), 4000);

  assert.deepEqual(t.main, {
    turns: 7,
    toolCalls: 9,
    toolFailures: 1,
    tokens: { input: 60, output: 30, cacheRead: 600, cacheWrite: 6 }, // Six messages with usage.
  });
  assert.deepEqual(t.subAgents, [
    {
      id: "spawn1",
      tool: "Task",
      model: "claude-haiku-4-5",
      turns: 3,
      toolCalls: 3,
      toolFailures: 1,
      tokens: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8 },
    },
  ]);
  assert.equal(t.readsBeforeFirstEdit, 4); // r1, r2, r3, r4; the sub-agent's do not count.
  assert.equal(t.turnsBeforeFirstEdit, 4);
  assert.equal(t.filesRead, 2); // a.ts, b.ts
  assert.equal(t.repeatReads, 2); // r2 and r5, both a.ts again
  assert.equal(t.duplicateReads, 1); // r3: b.ts, which the sub-agent had read
  assert.equal(t.filesWritten, 2);
  assert.deepEqual(t.phases, { exploringMs: 2400, buildingMs: 300, verifyingMs: 1300 });
});

test("an empty run", () => {
  const t = telemetry([], 0);
  assert.deepEqual(t, {
    main: { turns: 0, toolCalls: 0, toolFailures: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    subAgents: [],
    readsBeforeFirstEdit: 0,
    turnsBeforeFirstEdit: 0,
    filesRead: 0,
    repeatReads: 0,
    duplicateReads: 0,
    filesWritten: 0,
    phases: { exploringMs: 0, buildingMs: 0, verifyingMs: 0 },
  });
});

test("a run with no writes spends everything exploring", () => {
  clock = 0;
  const events = [said("main"), call("main", "r1", "Read", "read", "a.ts"), result("main", "r1"), said("main")];
  const t = telemetry(events, 9000);

  assert.deepEqual(t.phases, { exploringMs: 9000, buildingMs: 0, verifyingMs: 0 });
  assert.equal(t.readsBeforeFirstEdit, 1);
  assert.equal(t.turnsBeforeFirstEdit, 2);
  assert.equal(t.filesWritten, 0);
});

test("a first write on the sub-agent thread starts building, but not main's edit", () => {
  clock = 0;
  const events = [
    said("main"),
    call("main", "spawn1", "Agent", "spawn"),
    said("spawn1", "claude-sonnet-5"),
    call("spawn1", "s1", "Write", "write", "scratch.md"), // at 400: the run's first write
    result("spawn1", "s1"),
    result("main", "spawn1"),
    said("main"),
    call("main", "r1", "Read", "read", "a.ts"), // still before main's own first edit
    result("main", "r1"),
    call("main", "w1", "Edit", "write", "a.ts"), // at 1000
    result("main", "w1"),
  ];
  const t = telemetry(events, 1500);

  assert.deepEqual(t.phases, { exploringMs: 400, buildingMs: 600, verifyingMs: 500 });
  assert.equal(t.readsBeforeFirstEdit, 1);
  assert.equal(t.turnsBeforeFirstEdit, 2);
  assert.equal(t.filesWritten, 2);
  assert.equal(t.subAgents[0]?.tool, "Agent");
  assert.equal(t.subAgents[0]?.model, "claude-sonnet-5");
});

test("a thread with no spawning call is still reported, as unknown", () => {
  clock = 0;
  const t = telemetry([said("orphan", "claude-haiku-4-5"), said("main")], 100);
  assert.equal(t.subAgents.length, 1);
  assert.equal(t.subAgents[0]?.id, "orphan");
  assert.equal(t.subAgents[0]?.tool, "unknown");
  assert.equal(t.subAgents[0]?.turns, 1);
  assert.equal(t.main.turns, 1);
});
