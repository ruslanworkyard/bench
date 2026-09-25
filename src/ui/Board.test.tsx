import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";

import { cleanup, render } from "ink-testing-library";

import type { RunEvent } from "../events.js";
import { Board } from "./Board.js";
import { initialState, reduce, type BoardState } from "./state.js";

afterEach(cleanup);

/** The fake agent's recorded batch: one fixture, both sides, three judges. */
function recordedEvents(): RunEvent[] {
  const path = fileURLToPath(new URL("../../test/fixtures/events.jsonl", import.meta.url));
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunEvent);
}

const DOWN = "\u001B[B";
const ENTER = "\r";

function fold(events: RunEvent[]): BoardState {
  return events.reduce(reduce, initialState);
}

const strip = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

/** The board rendered; frames without colour codes, so assertions hold whether or not the terminal has colour. */
function board(state: BoardState, columns: number, onAbort: () => void = () => {}) {
  const instance = render(<Board state={state} elapsedMs={65_000} frame={0} columns={columns} rows={40} onAbort={onAbort} />);
  return { ...instance, lastFrame: () => strip(instance.lastFrame() ?? "") };
}

async function press(stdin: { write: (data: string) => void }, key: string): Promise<void> {
  stdin.write(key);
  await sleep(20);
}

/** The latest frame once `done` holds of it, polling for up to two seconds: input is parsed asynchronously. */
async function settled(lastFrame: () => string | undefined, done: (frame: string) => boolean): Promise<string> {
  for (let i = 0; i < 100 && !done(lastFrame() ?? ""); i++) await sleep(20);
  return lastFrame() ?? "";
}

/** The recorded batch stopped as the candidate's agent finishes its turns; the previous side is in setup. */
function midRun(): BoardState {
  const events = recordedEvents();
  const cut = events.findIndex((each) => each.type === "side.phase" && each.phase === "tests");
  return fold(events.slice(0, cut));
}

test("the header names the clock, the harness shas, the files changed and the model", () => {
  const frame = board(fold(recordedEvents()), 120).lastFrame() ?? "";
  const header = frame.split("\n")[0] ?? "";
  assert.match(header, /harnessbench/);
  assert.match(header, /01:05/);
  assert.match(header, /previous 0995eee → candidate 92e14b9/);
  assert.match(header, /1 harness file changed/);
  assert.match(header, /claude-opus-5/);
  assert.doesNotMatch(frame, /A\/A run/);
});

test("the A/A banner is there when both sides use the same harness", () => {
  const [start, ...rest] = recordedEvents();
  const frame = board(fold([{ ...(start as RunEvent & { type: "batch.start" }), sameHarness: true }, ...rest]), 120).lastFrame() ?? "";
  assert.match(frame, /⚠ A\/A run: both sides use the same harness — deltas are noise/);
});

test("at 120 columns the cards share a row and carry sparklines; at 80 they stack without", () => {
  const wide = board(midRun(), 120).lastFrame() ?? "";
  const row = wide.split("\n").find((line) => line.includes("ttl-cache")) ?? "";
  assert.match(row, /◐ previous +setup .*● candidate +agent/);
  assert.match(row, /[▁▂▃▄▅▆▇█]{3,}/);
  assert.match(row, /9 turns · \$0\.42/);

  const narrow = board(midRun(), 80).lastFrame() ?? "";
  const lines = narrow.split("\n");
  const previous = lines.findIndex((line) => /◐ previous/.test(line));
  const candidate = lines.findIndex((line) => /● candidate/.test(line));
  assert.ok(previous !== -1 && candidate > previous, narrow);
  assert.doesNotMatch(narrow, /[▁▂▃▄▅▆▇█]/);
  assert.ok(lines.every((line) => line.length <= 80), narrow);
});

test("finished cards show outcome, turns and cost; the chips show each judge's verdict", () => {
  const frame = board(fold(recordedEvents()), 120).lastFrame() ?? "";
  assert.match(frame, /✓ previous\s+completed · 9 turns · \$0\.42/);
  assert.match(frame, /⬤ code-quality candidate/);
  assert.match(frame, /✗ engineering-practices failed/);
  assert.match(frame, /· test-quality tie/);
  assert.match(frame, /██+ 2\/2 sides/);
  assert.match(frame, /↑↓ select {2}⏎ follow {2}q abort/);
});

test("⏎ follows the selected side: sub-agent calls indented, failed calls marked; esc closes", async () => {
  const { stdin, lastFrame } = board(fold(recordedEvents()), 120);
  await press(stdin, DOWN);
  await press(stdin, ENTER);
  const frame = await settled(lastFrame, (each) => each.includes("✗ read /etc/hosts"));
  assert.match(frame, /─ ttl-cache candidate ─/);
  const lines = frame.split("\n");
  const spawn = lines.findIndex((line) => line === "  spawn Task");
  assert.notEqual(spawn, -1, frame);
  assert.equal(lines[spawn + 1], "      read /tmp/harnessbench/run/tree/src/cache.ts");
  assert.equal(lines[spawn + 2], "      search Grep");
  assert.equal(lines[spawn + 3], "  read /tmp/harnessbench/run/tree/src/cache.ts");
  assert.ok(lines.includes("✗ read /etc/hosts"), frame);

  await press(stdin, "\u001B");
  assert.doesNotMatch(await settled(lastFrame, (each) => !each.includes("ttl-cache candidate ─")), /─ ttl-cache candidate ─/);
});

test("q asks once, n cancels, y aborts", async () => {
  let aborted = 0;
  const { stdin, lastFrame } = board(midRun(), 120, () => aborted++);
  await press(stdin, "q");
  assert.match(await settled(lastFrame, (each) => each.includes("abort all runs")), /abort all runs\? y\/n/);
  await press(stdin, "n");
  assert.doesNotMatch(await settled(lastFrame, (each) => !each.includes("abort all runs")), /abort all runs/);
  assert.equal(aborted, 0);
  await press(stdin, "q");
  await settled(lastFrame, (each) => each.includes("abort all runs"));
  await press(stdin, "y");
  for (let i = 0; i < 100 && aborted === 0; i++) await sleep(20);
  assert.equal(aborted, 1);
});
