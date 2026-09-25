import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { EventBus, emitter, recorder, type RunEvent } from "./events.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const done = (at: number): RunEvent => ({ at, type: "batch.done", durationMs: at, exitCode: 0 });

test("every subscriber hears every event, in the order emitted and subscribed", () => {
  const bus = new EventBus();
  const heard: string[] = [];
  bus.subscribe((event) => heard.push(`a${event.at}`));
  bus.subscribe((event) => heard.push(`b${event.at}`));
  bus.emit(done(1));
  bus.emit(done(2));
  assert.deepEqual(heard, ["a1", "b1", "a2", "b2"]);
});

test("a subscriber that throws does not stop the others", (t) => {
  const warnings = t.mock.method(process, "emitWarning", () => {});
  const bus = new EventBus();
  const heard: number[] = [];
  bus.subscribe(() => {
    throw new Error("renderer bug");
  });
  bus.subscribe((event) => heard.push(event.at));
  bus.emit(done(1));
  bus.emit(done(2));
  assert.deepEqual(heard, [1, 2]);
  assert.equal(warnings.mock.callCount(), 2);
  assert.match(String(warnings.mock.calls[0]?.arguments[0]), /batch\.done: renderer bug/);
});

test("emitter stamps each event with the time since its start", () => {
  const bus = new EventBus();
  const heard: RunEvent[] = [];
  bus.subscribe((event) => heard.push(event));
  emitter(bus, Date.now() - 5_000)({ type: "judge.start", fixture: "ttl-cache", judge: "code-quality" });
  assert.ok((heard[0]?.at ?? 0) >= 5_000);
  assert.equal(heard[0]?.type, "judge.start");
});

test("the recorder appends one JSON line per event, after its session line, and writes nothing until an event", () => {
  const dir = mkdtempSync(join(tmpdir(), "harnessbench-events-"));
  dirs.push(dir);
  const path = join(dir, "runs", "20260925-120000", "events.jsonl");
  const record = recorder(path, { type: "session", command: "judge", startedAt: "2026-09-25T12:00:00.000Z" });
  assert.equal(existsSync(path), false);
  record(done(1));
  record(done(2));
  const lines = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [{ type: "session", command: "judge", startedAt: "2026-09-25T12:00:00.000Z" }, done(1), done(2)]);
});
