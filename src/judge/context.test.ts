import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranscriptEvent } from "../agents/types.js";
import type { Environment, RunRecord } from "../run-record.js";
import { MAPPING, assembleContext, oversized, renderItem, type PairMaterial, type SideMaterial } from "./context.js";

/** Fabricated records: the context never touches disk. */

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function record(environment: Environment, patch: Partial<RunRecord> = {}): RunRecord {
  const runId = `20260919-031455-ttl-cache-${environment}`;
  return {
    schema: 2,
    runId,
    fixture: "ttl-cache",
    environment,
    headSha: HEAD,
    baseBranch: "main",
    harness: { ref: HEAD, sha: HEAD, files: ["CLAUDE.md"], hash: `${environment}hash${"0".repeat(56)}` },
    agent: { name: "claude-code", command: "claude", model: "claude-sonnet-4-5" },
    outcome: "completed",
    exitCode: 0,
    setup: null,
    startedAt: "2026-09-19T03:14:55.000Z",
    finishedAt: "2026-09-19T03:19:07.000Z",
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    costUsd: 0.4,
    durationMs: 240000,
    turns: 3,
    toolCalls: { Read: 1 },
    toolFailures: 0,
    diff: { files: 1, added: 1, removed: 0 },
    tests: { command: "npm test", exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: `Done: ${environment === "previous" ? "cache added" : "cache added, with tests"}`,
    ...patch,
  };
}

function side(environment: Environment, patch: Partial<SideMaterial> = {}, record_?: RunRecord): SideMaterial {
  return {
    record: record_ ?? record(environment),
    diff: `diff --git a/${environment === "previous" ? "one" : "two"}.ts b/x.ts\n+added on ${environment === "previous" ? "one" : "two"}\n`,
    transcript: [],
    ...patch,
  };
}

function pair(patch: Partial<PairMaterial> = {}): PairMaterial {
  return { prompt: "Add a TTL cache.\n", previous: side("previous"), candidate: side("candidate"), ...patch };
}

const at = (n: number) => n * 1000;

/** A main thread that reads, spawns an explorer, runs a shell command, writes, and reports. */
const WITH_SUBAGENT: TranscriptEvent[] = [
  { type: "assistant", thread: "main", at: at(1), text: "Looking at the cache first.", model: "claude-opus-5", usage: null },
  { type: "tool_call", thread: "main", at: at(2), id: "t1", tool: "Read", input: { file_path: "/tree/src/cache.ts" }, kind: "read", path: "src/cache.ts" },
  { type: "tool_result", thread: "main", at: at(3), id: "t1", isError: false, output: "export const cache = new Map();\n" },
  { type: "tool_call", thread: "main", at: at(4), id: "spawn1", tool: "Task", input: { subagent_type: "Explore", prompt: "Which files read from the cache?\nList them." }, kind: "spawn", path: null },
  { type: "assistant", thread: "spawn1", at: at(5), text: "", model: "claude-haiku-4-5", usage: null },
  { type: "tool_call", thread: "spawn1", at: at(6), id: "s1", tool: "Grep", input: { pattern: "cache" }, kind: "search", path: null },
  { type: "tool_result", thread: "spawn1", at: at(7), id: "s1", isError: false, output: "src/read.ts\n" },
  { type: "tool_call", thread: "spawn1", at: at(8), id: "s2", tool: "Read", input: { file_path: "/tree/src/read.ts" }, kind: "read", path: "src/read.ts" },
  { type: "tool_result", thread: "spawn1", at: at(9), id: "s2", isError: false, output: "..." },
  { type: "tool_result", thread: "main", at: at(10), id: "spawn1", isError: false, output: "src/read.ts reads it." },
  { type: "tool_call", thread: "main", at: at(11), id: "t2", tool: "Bash", input: { command: "npm test\n# second line never shown", description: "Run tests" }, kind: "shell", path: null },
  { type: "tool_result", thread: "main", at: at(12), id: "t2", isError: true, output: "1 failing" },
  { type: "tool_call", thread: "main", at: at(13), id: "t3", tool: "Edit", input: { file_path: "/tree/src/cache.ts", old_string: "a", new_string: "b" }, kind: "write", path: "src/cache.ts" },
  { type: "tool_result", thread: "main", at: at(14), id: "t3", isError: false, output: "ok" },
  { type: "tool_call", thread: "main", at: at(15), id: "t4", tool: "WebSearch", input: "how do caches work", kind: "other", path: null },
  { type: "error", thread: "main", at: at(16), message: "stream ended early" },
];

test("the layout shows the task once, then every other item for A and again for B, in menu order", () => {
  const text = assembleContext(["transcript", "diff", "prompt", "tests", "finalMessage", "toolLog"], pair());

  const headings = text.split("\n").filter((line) => line.startsWith("#"));
  assert.deepEqual(headings, [
    "# Task",
    "# Attempt A",
    "## Diff",
    "## Test result",
    "## Final message",
    "## Tool log",
    "## Transcript",
    "# Attempt B",
    "## Diff",
    "## Test result",
    "## Final message",
    "## Tool log",
    "## Transcript",
  ]);
  assert.match(text, /^# Task\n\nAdd a TTL cache\.\n\n# Attempt A/);
  assert.equal(text.match(/Add a TTL cache/g)?.length, 1);
});

test("A is always previous and B always candidate, and neither name reaches the judge", () => {
  assert.deepEqual(MAPPING, { A: "previous", B: "candidate" });
  const text = assembleContext(["prompt", "diff", "finalMessage"], pair());

  const a = text.slice(text.indexOf("# Attempt A"), text.indexOf("# Attempt B"));
  const b = text.slice(text.indexOf("# Attempt B"));
  assert.match(a, /added on one/);
  assert.match(a, /Done: cache added\n/);
  assert.match(b, /added on two/);
  assert.match(b, /cache added, with tests/);

  for (const forbidden of ["previous", "candidate", "20260919-031455", HEAD, "hash0000"]) {
    assert.ok(!text.includes(forbidden), `context should not contain ${JSON.stringify(forbidden)}`);
  }
});

test("run ids and harness hashes that leak through a path or message are redacted", () => {
  const previous = record("previous");
  const leaky = side("previous", {
    diff: `+# see /tmp/harnessbench/${previous.runId}/tree/notes.md (harness ${previous.harness.hash})\n`,
  });
  const text = assembleContext(["diff"], pair({ previous: leaky }));

  assert.match(text, /\+# see \/tmp\/harnessbench\/<redacted>\/tree\/notes\.md \(harness <redacted>\)/);
  assert.ok(!text.includes(previous.runId));
});

test("only the items a judge asked for are rendered", () => {
  const text = assembleContext(["diff"], pair());
  assert.ok(!text.includes("# Task"));
  assert.ok(!text.includes("## Test result"));
  assert.match(text, /# Attempt A\n\n## Diff\n\ndiff --git/);
});

test("tests render as a fact, never the log; an empty diff and message say so", () => {
  assert.equal(renderItem("tests", side("previous")), "passed");
  assert.equal(renderItem("tests", side("previous", {}, record("previous", { tests: null }))), "not configured");
  assert.equal(
    renderItem("tests", side("previous", {}, record("previous", { tests: { command: "npm test", exitCode: 1, durationMs: 1, timedOut: false } }))),
    "failed",
  );
  assert.equal(
    renderItem("tests", side("previous", {}, record("previous", { tests: { command: "npm test", exitCode: null, durationMs: 1, timedOut: true } }))),
    "failed",
  );
  assert.equal(renderItem("diff", side("previous", { diff: "" })), "(no changes)");
  assert.equal(renderItem("finalMessage", side("previous", {}, record("previous", { finalMessage: "" }))), "(none)");
});

test("the tool log is one line per main-thread call, a sub-agent folded into its spawn line", () => {
  const log = renderItem("toolLog", side("previous", { transcript: WITH_SUBAGENT }));

  assert.equal(
    log,
    ["read src/cache.ts", "spawn Task (2 calls on claude-haiku-4-5)", "shell npm test", "write src/cache.ts", "other WebSearch"].join("\n"),
  );
  assert.equal(renderItem("toolLog", side("previous")), "(no tool calls)");
});

test("a sub-agent that never spoke has no model in the tool log", () => {
  const silent: TranscriptEvent[] = [
    { type: "tool_call", thread: "main", at: 1, id: "sp", tool: "Agent", input: {}, kind: "spawn", path: null },
    { type: "tool_call", thread: "sp", at: 2, id: "s1", tool: "Read", input: {}, kind: "read", path: "a.ts" },
  ];
  assert.equal(renderItem("toolLog", side("previous", { transcript: silent })), "spawn Agent (1 call on model not reported)");
});

test("the transcript renders every event as readable text, tagged by thread, with no JSON", () => {
  const text = renderItem("transcript", side("previous", { transcript: WITH_SUBAGENT }));

  assert.equal(
    text,
    [
      "[main] assistant: Looking at the cache first.",
      "[main] tool call Read",
      "  file_path: /tree/src/cache.ts",
      "[main] tool result: export const cache = new Map();",
      "[main] tool call Task",
      "  subagent_type: Explore",
      "  prompt: Which files read from the cache?",
      "    List them.",
      "[sub-agent 1] assistant: (no text)",
      "[sub-agent 1] tool call Grep",
      "  pattern: cache",
      "[sub-agent 1] tool result: src/read.ts",
      "[sub-agent 1] tool call Read",
      "  file_path: /tree/src/read.ts",
      "[sub-agent 1] tool result: ...",
      "[main] tool result: src/read.ts reads it.",
      "[main] tool call Bash",
      "  command: npm test",
      "    # second line never shown",
      "  description: Run tests",
      "[main] tool result (error): 1 failing",
      "[main] tool call Edit",
      "  file_path: /tree/src/cache.ts",
      "  old_string: a",
      "  new_string: b",
      "[main] tool result: ok",
      "[main] tool call WebSearch",
      "  how do caches work",
      "[main] error: stream ended early",
    ].join("\n"),
  );
  assert.ok(!text.includes("{"), "no JSON objects in the rendering");
  assert.equal(renderItem("transcript", side("previous")), "(empty)");
});

test("the size check names every item over the limit, per side, and the shared prompt as such", () => {
  const big = "x".repeat(2 * 1024 + 1);
  const material = pair({
    prompt: big,
    candidate: side("candidate", { diff: big }, record("candidate", { finalMessage: big })),
  });

  assert.deepEqual(oversized(["prompt", "diff", "finalMessage", "tests"], material, 2), [
    { side: null, item: "prompt", bytes: 2049 },
    { side: "candidate", item: "diff", bytes: 2049 },
    { side: "candidate", item: "finalMessage", bytes: 2049 },
  ]);
  assert.deepEqual(oversized(["tests", "toolLog"], material, 2), []);
  // Exactly at the limit is fine; the check is on what the judge would read, not the raw file.
  assert.deepEqual(oversized(["diff"], pair({ previous: side("previous", { diff: "y".repeat(2048) }) }), 2), []);
});
