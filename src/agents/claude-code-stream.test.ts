import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseStreamJson } from "./claude-code-stream.js";
import { MAX_EVENT_CHARS } from "./types.js";

/** A recording of a real `claude -p --output-format stream-json` run, replayed from disk. */
function recorded(name: string): string[] {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf8").split("\n");
}

test("a complete run parses into every field of a result", () => {
  const parsed = parseStreamJson(recorded("claude-stream.jsonl"));

  assert.equal(parsed.model, "claude-opus-5");
  assert.equal(parsed.finalMessage, "Added a TTL cache and wired it into the expensive read.");
  assert.deepEqual(parsed.tokens, { input: 12, output: 345, cacheRead: 6789, cacheWrite: 1011 });
  assert.equal(parsed.costUsd, 0.4213);
  assert.equal(parsed.durationMs, 41234);
  assert.equal(parsed.turns, 7);
  assert.deepEqual(parsed.toolCalls, { Read: 1, Bash: 1 });
  assert.equal(parsed.toolFailures, 1);
  assert.equal(parsed.isError, false);
  assert.deepEqual(parsed.transcript, [
    { type: "assistant", text: "I'll read the cache module before changing it." },
    { type: "tool_call", id: "toolu_01", tool: "Read", input: { file_path: "src/cache.ts" } },
    {
      type: "tool_result",
      id: "toolu_01",
      isError: false,
      output: "export function get(key: string) {\n  return store.get(key);\n}\n",
    },
    {
      type: "tool_call",
      id: "toolu_02",
      tool: "Bash",
      input: { command: "npm test", description: "Run the test suite" },
    },
    { type: "tool_result", id: "toolu_02", isError: true, output: 'npm ERR! Missing script: "test"' },
    { type: "assistant", text: "The suite has no test script." },
  ]);
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
  assert.equal(parsed.transcript.length, 2);
});

test("a failed result is carried as an error event", () => {
  const parsed = parseStreamJson([
    '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":40,' +
      '"duration_ms":900,"result":"Reached the turn limit.","usage":{"input_tokens":3}}',
  ]);

  assert.equal(parsed.isError, true);
  assert.equal(parsed.finalMessage, "Reached the turn limit.");
  assert.equal(parsed.costUsd, null);
  assert.deepEqual(parsed.transcript, [{ type: "error", message: "Reached the turn limit." }]);
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
  assert.deepEqual(parsed.transcript, [{ type: "assistant", text: "still here" }]);
});

test("a tool's input and output are bounded", () => {
  const huge = "x".repeat(MAX_EVENT_CHARS * 2);
  const parsed = parseStreamJson([
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write",` +
      `"input":{"content":"${huge}"}}]}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1",` +
      `"content":"${huge}"}]}}`,
  ]);

  const [call, result] = parsed.transcript;
  assert.equal(call?.type, "tool_call");
  assert.equal(typeof (call as { input: unknown }).input, "string");
  assert.equal(String((call as { input: string }).input).length, MAX_EVENT_CHARS);
  assert.equal(result?.type, "tool_result");
  assert.equal((result as { output: string }).output.length, MAX_EVENT_CHARS);
});
