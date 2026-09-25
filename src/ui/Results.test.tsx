import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";

import type { Comparison, Row } from "../compare.js";
import type { BatchReport } from "../report.js";

// Colour on, before anything loads ink, so the NO_COLOR test has colour to take away.
process.env["FORCE_COLOR"] = "1";
const { cleanup, render } = await import("ink-testing-library");
const { rollup } = await import("../compare.js");
const { formatSummaryReport } = await import("../print.js");
const { App, Store } = await import("./App.js");
const { Results } = await import("./Results.js");
const { NoColor } = await import("./style.js");

afterEach(cleanup);

const DOWN = "\u001B[B";
const TAB = "\t";

function row(id: string, label: string, classification: Row["classification"], extra: Partial<Row> = {}): Row {
  return { id, label, previous: "", candidate: "", delta: "", classification, ...extra };
}

function comparison(fixture: string, rows: Row[]): Comparison {
  return {
    fixture,
    headSha: "9c4c5e2aaaaaaa",
    previous: { runId: `20260925-040217-${fixture}-previous`, harnessSha: "cca3e7cbbbbbbb", model: "claude-opus-5" },
    candidate: { runId: `20260925-040217-${fixture}-candidate`, harnessSha: "9c4c5e2aaaaaaa", model: "claude-opus-5" },
    rows,
    warnings: [],
    judged: { provider: "anthropic", model: "claude-sonnet-5" },
  };
}

/** Two fixtures: ttl-cache got cheaper and the judges liked it; announcements took more turns. */
function report(): BatchReport {
  const comparisons = [
    comparison("ttl-cache", [
      row("outcome", "Outcome", "unchanged", { previous: "completed", candidate: "completed" }),
      row("turns", "Turns", "improved", { previous: "31", candidate: "23", delta: "-8" }),
      row("readsBeforeFirstEdit", "Reads before first edit", "unchanged", { previous: "6", candidate: "5", delta: "-1", note: "within noise" }),
      row("costUsd", "Cost", "improved", { previous: "$0.51", candidate: "$0.38", delta: "-25%" }),
      row("judge.code-quality", "Code quality", "improved", {
        delta: "candidate preferred",
        note: "B keeps the existing error type in read.ts; A introduces a second one.",
      }),
      row("judge.test-quality", "Test quality", "unchanged", { delta: "tie", note: "Both test the expiry path only." }),
    ]),
    comparison("announcements", [
      row("outcome", "Outcome", "unchanged", { previous: "completed", candidate: "completed" }),
      row("turns", "Turns", "regressed", { previous: "20", candidate: "30", delta: "+10" }),
      row("costUsd", "Cost", "unchanged", { previous: "$0.40", candidate: "$0.41", delta: "+2%", note: "within noise" }),
      row("judge.code-quality", "Code quality", "regressed", {
        delta: "previous preferred",
        note: "A reuses the feed parser; B writes its own.",
      }),
      row("judge.test-quality", "Test quality", "n/a", { note: "not judged; run harnessbench judge --fixture announcements" }),
    ]),
  ];
  return {
    schema: 1,
    stamp: "20260925-040217",
    headSha: "9c4c5e2aaaaaaa",
    harness: { previous: "cca3e7cbbbbbbb", candidate: "9c4c5e2aaaaaaa" },
    agent: { name: "claude-code", model: "claude-opus-5" },
    judge: { provider: "anthropic", model: "claude-sonnet-5" },
    rollup: { ...rollup(comparisons), warnings: ["announcements: models differ"] },
    fixtures: comparisons.map((each) => ({ fixture: each.fixture, comparison: each, sides: { previous: null, candidate: null }, error: null })),
  };
}

function results(noColor = false, onOpenReport: () => string = () => "report  .harnessbench/runs/20260925-040217/report.md") {
  return render(
    <NoColor.Provider value={noColor}>
      <Results report={report()} columns={100} onOpenReport={onOpenReport} onQuit={() => {}} />
    </NoColor.Provider>,
  );
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

const strip = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");
/** Foreground or background colour, 16-colour, 256-colour or truecolour. */
const COLOUR = /\u001B\[(3[0-8]|4[0-8]|9[0-7]|10[0-7])[;m]/;

test("the verdict lines carry arrows: ▲ improved, ▼ regressed; warnings are marked", () => {
  const frame = strip(results().lastFrame() ?? "");
  assert.match(frame, /harnessbench {2}2 fixtures · code 9c4c5e2 · previous cca3e7c → candidate 9c4c5e2/);
  assert.match(frame, /⚠ announcements: models differ/);
  assert.match(frame, /Outcome {5}unchanged 2/);
  assert.match(frame, /Efficiency {2}▼ regressed: Turns 1 · ▲ improved: Turns 1, Cost 1/);
  assert.match(frame, /Judges {6}▲ candidate 1 · ▼ previous 1 · tie 1 · not judged 1/);
});

test("each fixture line has its headline deltas and judge chips", () => {
  const lines = strip(results().lastFrame() ?? "").split("\n");
  const ttl = lines.find((line) => line.includes("ttl-cache ")) ?? "";
  assert.match(ttl, /› ttl-cache/);
  assert.match(ttl, /turns -8 ▲ {2}cost -25% ▲ {2}reads before edit -1 = {2}⬤ ·/);
  const announcements = lines.find((line) => line.includes("announcements  ")) ?? "";
  assert.match(announcements, /turns \+10 ▼ {2}cost \+2% = {2}○ –/);
});

test("the selected fixture's judge reasons are shown in full; ↓ selects the next", async () => {
  const { stdin, lastFrame } = results();
  let frame = strip(lastFrame() ?? "");
  assert.match(frame, /⬤ Code quality: candidate/);
  assert.match(frame, /B keeps the existing error type in read\.ts; A introduces a second one\./);
  assert.match(frame, /· Test quality: tie/);

  await press(stdin, DOWN);
  frame = strip(await settled(lastFrame, (each) => strip(each).includes("› announcements")));
  assert.match(frame, /› announcements/);
  assert.match(frame, /○ Code quality: previous/);
  assert.match(frame, /A reuses the feed parser; B writes its own\./);
  assert.doesNotMatch(frame, /read\.ts/);
});

test("⇥ toggles to the fixture's full comparison table and back", async () => {
  const { stdin, lastFrame } = results();
  await press(stdin, TAB);
  let frame = strip(await settled(lastFrame, (each) => each.includes("comparison")));
  assert.match(frame, /─ ttl-cache: comparison/);
  assert.match(frame, /Turns +31 +23 +-8 +▲ improved/);
  assert.match(frame, /Reads before first edit +6 +5 +-1 +\S* *= unchanged/);
  assert.doesNotMatch(frame, /introduces a second one/);
  await press(stdin, TAB);
  frame = strip(await settled(lastFrame, (each) => !each.includes("comparison")));
  assert.match(frame, /introduces a second one/);
});

test("r opens the report, or says where it is", async () => {
  const { stdin, lastFrame } = results();
  await press(stdin, "r");
  assert.match(strip(await settled(lastFrame, (each) => each.includes("report.md"))), /report {2}\.harnessbench\/runs\/20260925-040217\/report\.md/);
});

test("colour is there by default, and NO_COLOR keeps every glyph without it", () => {
  assert.match(results().lastFrame() ?? "", COLOUR);
  const plain = results(true).lastFrame() ?? "";
  assert.doesNotMatch(plain, COLOUR);
  for (const glyph of ["▲", "▼", "⬤", "○", "·", "⚠", "="]) assert.ok(plain.includes(glyph), `${glyph} missing`);
});

test("the app shows the board until the report, and q leaves the plain summary", async () => {
  const store = new Store();
  store.dispatch({
    at: 1,
    type: "batch.start",
    stamp: "20260925-040217",
    fixtures: ["ttl-cache", "announcements"],
    harness: { previous: "cca3e7cbbbbbbb", candidate: "9c4c5e2aaaaaaa" },
    sameHarness: false,
    agent: { name: "claude-code", model: "claude-opus-5" },
  });
  const { stdin, lastFrame, frames } = render(
    <App store={store} onAbort={() => {}} onOpenReport={() => ""} animate={false} columns={100} rows={30} />,
  );
  assert.match(strip(lastFrame() ?? ""), /0\/4 sides/);

  store.show(report(), ".harnessbench/runs/20260925-040217/report.md");
  assert.match(strip(await settled(lastFrame, (each) => each.includes("Efficiency"))), /Efficiency/);
  assert.doesNotMatch(strip(lastFrame() ?? ""), /sides/);

  await press(stdin, "q");
  const summary = formatSummaryReport(report(), ".harnessbench/runs/20260925-040217/report.md");
  for (let i = 0; i < 100 && !frames.some((frame) => strip(frame).includes(summary)); i++) await sleep(20);
  assert.ok(frames.map(strip).some((frame) => frame.includes(summary)), frames.map(strip).join("\n---\n"));
});
