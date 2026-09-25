import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { telemetry } from "../telemetry.js";
import { parseStreamJson, StreamParser, type StreamEvent } from "./claude-code-stream.js";
import { MAX_EVENT_CHARS, type TranscriptEvent } from "./types.js";

/** A recording of a real `claude -p --output-format stream-json` run, replayed from disk. */
function recorded(name: string): string[] {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf8").split("\n");
}

const TREE = "/tmp/harnessbench/run/tree";

function calls(events: TranscriptEvent[]) {
  return events.filter((e) => e.type === "tool_call");
}

test("a complete run parses into every field of a result", () => {
  const parsed = parseStreamJson(recorded("claude-stream.jsonl"), { tree: TREE });

  assert.equal(parsed.model, "claude-opus-5");
  assert.equal(parsed.finalMessage, "Added a TTL cache and wired it into the expensive read.");
  assert.deepEqual(parsed.tokens, { input: 12, output: 345, cacheRead: 6789, cacheWrite: 1011 });
  assert.equal(parsed.costUsd, 0.4213);
  assert.equal(parsed.durationMs, 41234);
  assert.equal(parsed.turns, 7);
  assert.deepEqual(parsed.toolCalls, { Read: 1, Bash: 1 });
  assert.equal(parsed.toolFailures, 1);
  assert.equal(parsed.isError, false);
  // One assistant event per message, even one that only calls a tool: its usage lives there.
  const main = { thread: "main", at: 0 };
  assert.deepEqual(parsed.transcript, [
    { ...main, type: "assistant", turn: 0, text: "I'll read the cache module before changing it.", model: "claude-opus-5", usage: null },
    { ...main, type: "assistant", turn: 1, text: "", model: "claude-opus-5", usage: null },
    { ...main, type: "tool_call", id: "toolu_01", tool: "Read", input: { file_path: "src/cache.ts" }, kind: "read", path: "src/cache.ts" },
    {
      ...main,
      type: "tool_result",
      id: "toolu_01",
      isError: false,
      output: "export function get(key: string) {\n  return store.get(key);\n}\n",
    },
    { ...main, type: "assistant", turn: 2, text: "", model: "claude-opus-5", usage: null },
    {
      ...main,
      type: "tool_call",
      id: "toolu_02",
      tool: "Bash",
      input: { command: "npm test", description: "Run the test suite" },
      kind: "shell",
      path: null,
    },
    { ...main, type: "tool_result", id: "toolu_02", isError: true, output: 'npm ERR! Missing script: "test"' },
    { ...main, type: "assistant", turn: 3, text: "The suite has no test script.", model: "claude-opus-5", usage: null },
  ]);
});

test("a sub-agent's events carry its thread, and the last of two results wins", () => {
  const lines = recorded("claude-stream-subagent.jsonl");
  const parser = new StreamParser({ tree: TREE });
  lines.forEach((line, i) => parser.push(line, i * 100));
  const parsed = parser.finish();

  // Turns and tokens come from the final result, not the one emitted when main yielded.
  assert.equal(parsed.turns, 9);
  assert.deepEqual(parsed.tokens, { input: 99, output: 88, cacheRead: 777, cacheWrite: 66 });
  assert.equal(parsed.costUsd, 0.42);
  assert.equal(parsed.durationMs, 5000);
  assert.equal(parsed.finalMessage, "Wired the cache.");
  assert.deepEqual(parsed.toolCalls, { Task: 1, Read: 3, Grep: 1, Edit: 1 });
  assert.equal(parsed.toolFailures, 1);

  const byId = Object.fromEntries(calls(parsed.transcript).map((c) => [c.id, c]));
  assert.deepEqual(
    Object.entries(byId).map(([id, c]) => [id, c.thread, c.kind, c.path]),
    [
      ["toolu_task", "main", "spawn", null],
      ["toolu_s1", "toolu_task", "read", "src/cache.ts"], // Relative to the tree.
      ["toolu_s2", "toolu_task", "search", null],
      ["toolu_03", "main", "read", "src/cache.ts"],
      ["toolu_04", "main", "write", "src/cache.ts"],
      ["toolu_05", "main", "read", "/etc/hosts"], // Outside the tree: stays absolute.
    ],
  );
  assert.equal(byId["toolu_task"]?.at, 200); // Line 3 of the recording, stamped by the caller.
  assert.equal(byId["toolu_task"]?.tool, "Task");

  const results = parsed.transcript.filter((e) => e.type === "tool_result");
  assert.deepEqual(
    results.map((r) => [r.id, r.thread]),
    [["toolu_s1", "toolu_task"], ["toolu_s2", "toolu_task"], ["toolu_task", "main"], ["toolu_03", "main"], ["toolu_04", "main"], ["toolu_05", "main"]],
  );

  const assistants = parsed.transcript.filter((e) => e.type === "assistant");
  assert.equal(assistants.length, 9);
  assert.deepEqual(assistants[0], {
    thread: "main",
    at: 100,
    type: "assistant",
    turn: 0,
    text: "Let me have a sub-agent map the cache module.",
    model: "claude-opus-5",
    usage: { input: 10, output: 20, cacheRead: 100, cacheWrite: 5 },
  });
  const sub = assistants.filter((a) => a.thread === "toolu_task");
  assert.equal(sub.length, 3);
  assert.equal(sub[0]?.model, "claude-haiku-4-5");
  assert.deepEqual(sub[0]?.usage, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
  // A sub-agent's prose is not the run's final message.
  assert.equal(assistants[assistants.length - 1]?.text, "Done.");

  // Telemetry recomputes turns and calls from the events and agrees with the parser.
  const t = telemetry(parsed.transcript, 5000);
  const parsedCalls = Object.values(parsed.toolCalls).reduce((sum, n) => sum + n, 0);
  assert.equal(t.main.toolCalls + t.subAgents.reduce((sum, s) => sum + s.toolCalls, 0), parsedCalls);
  assert.equal(t.main.turns + t.subAgents.reduce((sum, s) => sum + s.turns, 0), parsed.turns);
  assert.equal(t.main.toolFailures, parsed.toolFailures);
});

test("without a tree, paths are kept as the agent gave them", () => {
  const parsed = parseStreamJson([
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"${TREE}/a.ts"}}]}}`,
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"b.ts"}}]}}`,
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Read","input":{}}]}}`,
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"mcp__x__y","input":{"file_path":"c.ts"}}]}}`,
  ]);
  assert.deepEqual(
    calls(parsed.transcript).map((c) => [c.kind, c.path]),
    [["write", `${TREE}/a.ts`], ["read", "b.ts"], ["read", null], ["other", null]],
  );
});

test("a run killed before its result event reports what it managed to say", () => {
  const parsed = parseStreamJson(recorded("claude-stream-no-result.jsonl"));

  assert.equal(parsed.model, "claude-sonnet-5");
  assert.equal(parsed.finalMessage, "Starting on the cache.");
  assert.deepEqual(parsed.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(parsed.costUsd, null);
  assert.equal(parsed.durationMs, null);
  assert.equal(parsed.turns, 2); // The assistant messages, since nothing counted them for us.
  assert.deepEqual(parsed.toolCalls, { Bash: 1 });
  assert.equal(parsed.toolFailures, 0);
  assert.equal(parsed.isError, false);
  assert.equal(parsed.transcript.length, 3);
  assert.equal(telemetry(parsed.transcript, 0).main.turns, parsed.turns);
});

test("a failed result is carried as an error event", () => {
  const parsed = parseStreamJson([
    '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":4,' +
      '"duration_ms":900,"result":"The API rejected the request.","usage":{"input_tokens":3}}',
  ]);

  assert.equal(parsed.isError, true);
  assert.equal(parsed.resultSubtype, "error_during_execution");
  assert.equal(parsed.finalMessage, "The API rejected the request.");
  assert.equal(parsed.costUsd, null);
  assert.deepEqual(parsed.transcript, [
    { thread: "main", at: 0, type: "error", message: "The API rejected the request." },
  ]);
});

test("a run cut off by the turn limit says so, instead of the half-sentence it stopped on", () => {
  const parsed = parseStreamJson([
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Now let\'s make the memory edits."}]}}',
    '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":40,"duration_ms":900,' +
      '"usage":{"input_tokens":3}}',
  ]);

  assert.equal(parsed.resultSubtype, "error_max_turns");
  assert.equal(parsed.isError, true);
  assert.equal(parsed.turns, 40);
  assert.equal(parsed.finalMessage, "cut off by the turn limit after 40 turns");
  // The agent's own words stay in the transcript; only the run's final message is replaced.
  assert.deepEqual(parsed.transcript, [
    { thread: "main", at: 0, type: "assistant", turn: 0, text: "Now let's make the memory edits.", model: null, usage: null },
    { thread: "main", at: 0, type: "error", message: "cut off by the turn limit after 40 turns" },
  ]);
});

test("one API message split over several assistant events is one turn", () => {
  // Claude Code emits one `assistant` event per content block; both carry the message's id.
  const message = (block: string) =>
    `{"type":"assistant","message":{"id":"msg_01","model":"claude-sonnet-5","content":[${block}],` +
    `"usage":{"input_tokens":10,"output_tokens":4}}}`;
  const lines = [
    message('{"type":"text","text":"Reading the cache first."}'),
    message('{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"src/cache.ts"}}'),
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"..."}]}}',
    '{"type":"assistant","message":{"id":"msg_02","model":"claude-sonnet-5","content":[{"type":"text","text":"Done."}]}}',
  ];

  const parsed = parseStreamJson(lines);
  const assistants = parsed.transcript.filter((e) => e.type === "assistant");
  assert.deepEqual(
    assistants.map((a) => a.turn),
    [0, 0, 1],
  );
  assert.equal(parsed.turns, 2);
  const t = telemetry(parsed.transcript, 0);
  assert.equal(t.main.turns, 2);
  assert.equal(t.main.turns, parsed.turns);
  assert.equal(t.turnsBeforeFirstEdit, 2);
  // Usage is per event, as the stream reports it; the turn count is what changes.
  assert.deepEqual(t.main.tokens, { input: 20, output: 8, cacheRead: 0, cacheWrite: 0 });

  // A result event's own count is preferred, and agrees when the stream is whole.
  const withResult = parseStreamJson([...lines, '{"type":"result","subtype":"success","num_turns":2,"result":"Done."}']);
  assert.equal(withResult.turns, 2);
  assert.equal(telemetry(withResult.transcript, 0).main.turns, 2);
});

test("a stream without a result event has no result subtype", () => {
  assert.equal(parseStreamJson(recorded("claude-stream-no-result.jsonl")).resultSubtype, null);
  assert.equal(parseStreamJson(recorded("claude-stream.jsonl")).resultSubtype, "success");
});

test("garbage, blank lines and unknown event types are skipped", () => {
  const parsed = parseStreamJson([
    "",
    "Debugger listening on ws://127.0.0.1:9229",
    "{ not json",
    "[1,2,3]",
    '"a bare string"',
    '{"type":"stream_event","event":{"type":"content_block_delta"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"still here"}]}}',
    '{"type":"assistant","message":{"content":"not a list of blocks"}}',
  ]);

  assert.equal(parsed.finalMessage, "still here");
  assert.equal(parsed.turns, 2);
  assert.deepEqual(parsed.transcript, [
    { thread: "main", at: 0, type: "assistant", turn: 0, text: "still here", model: null, usage: null },
    { thread: "main", at: 0, type: "assistant", turn: 1, text: "", model: null, usage: null },
  ]);
});

test("a tool's input and output are bounded", () => {
  const huge = "x".repeat(MAX_EVENT_CHARS * 2);
  const parsed = parseStreamJson([
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write",` +
      `"input":{"content":"${huge}"}}]}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1",` +
      `"content":"${huge}"}]}}`,
  ]);

  const [, call, result] = parsed.transcript;
  assert.equal(call?.type, "tool_call");
  assert.equal(typeof (call as { input: unknown }).input, "string");
  assert.equal(String((call as { input: string }).input).length, MAX_EVENT_CHARS);
  assert.equal(result?.type, "tool_result");
  assert.equal((result as { output: string }).output.length, MAX_EVENT_CHARS);
});

test("onEvent hears a turn per completed message with running usage, and a tool per call and per failed result", () => {
  const events: StreamEvent[] = [];
  const parser = new StreamParser({ tree: TREE, onEvent: (event) => events.push(event) });
  for (const line of recorded("claude-stream-subagent.jsonl")) parser.push(line);
  const parsed = parser.finish();

  const turn = (n: number, input: number, output: number, cacheRead: number, cacheWrite: number, costUsd: number | null) =>
    ({ type: "turn", turn: n, tokens: { input, output, cacheRead, cacheWrite }, costUsd }) as const;
  const tool = (thread: string, kind: string, label: string, failed = false) => ({ type: "tool", thread, kind, label, failed });
  assert.deepEqual(events, [
    turn(1, 10, 20, 100, 5, null), // msg_01 completes when msg_02 starts
    tool("main", "spawn", "spawn Task"),
    turn(2, 11, 22, 103, 9, 0.01), // the mid-stream result reports cost and closes msg_02
    tool("toolu_task", "read", "read src/cache.ts"),
    turn(3, 16, 28, 110, 17, 0.01),
    tool("toolu_task", "search", "search Grep"),
    turn(4, 21, 34, 117, 25, 0.01),
    turn(5, 26, 40, 124, 33, 0.01), // the sub-agent's last message ends with its spawn's result
    tool("main", "read", "read src/cache.ts"),
    turn(6, 27, 42, 424, 37, 0.01),
    tool("main", "write", "write src/cache.ts"),
    turn(7, 28, 44, 724, 41, 0.01),
    tool("main", "read", "read /etc/hosts"),
    turn(8, 29, 46, 1024, 45, 0.01),
    tool("main", "read", "read /etc/hosts", true),
    turn(9, 30, 48, 1324, 49, 0.42),
  ]);
  // The end-of-run parse is untouched by listening.
  assert.deepEqual(parsed, parseStreamJson(recorded("claude-stream-subagent.jsonl"), { tree: TREE }));
});

test("a shell call's label is its command's first line, with the tree as . and a leading cd dropped", () => {
  const events: StreamEvent[] = [];
  const parser = new StreamParser({ tree: TREE, onEvent: (event) => events.push(event) });
  const command = `cd ${TREE} && node --test ${TREE}/dist/a.test.js\necho done`;
  parser.push(JSON.stringify({
    type: "assistant",
    message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] },
  }));
  parser.push(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
  }));
  assert.deepEqual(
    events.filter((event) => event.type === "tool"),
    [
      { type: "tool", thread: "main", kind: "shell", label: "shell node --test ./dist/a.test.js", failed: false },
      { type: "tool", thread: "main", kind: "shell", label: "shell node --test ./dist/a.test.js", failed: true },
    ],
  );
});
