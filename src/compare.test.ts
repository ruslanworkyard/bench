import assert from "node:assert/strict";
import { test } from "node:test";

import { compare, type Classification, type Row } from "./compare.js";
import type { RunRecord } from "./run-record.js";
import type { Telemetry } from "./telemetry.js";

/** Telemetry to match the record below: 40 calls on main, one Explore sub-agent with 10. */
function telemetry(patch: Partial<Telemetry> = {}): Telemetry {
  return {
    main: { turns: 20, toolCalls: 40, toolFailures: 2, tokens: { input: 900, output: 18000, cacheRead: 300000, cacheWrite: 9000 } },
    subAgents: [
      { id: "toolu_task", tool: "Explore", model: "claude-haiku-4-5", turns: 5, toolCalls: 10, toolFailures: 0, tokens: { input: 100, output: 2000, cacheRead: 100000, cacheWrite: 1000 } },
    ],
    readsBeforeFirstEdit: 10,
    turnsBeforeFirstEdit: 6,
    filesRead: 12,
    repeatReads: 3,
    duplicateReads: 4,
    filesWritten: 5,
    phases: { exploringMs: 60000, buildingMs: 120000, verifyingMs: 60000 },
    ...patch,
  };
}

/** A completed candidate run with round numbers, so every threshold is easy to reason about. */
function record(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: 2,
    runId: "20260919-031455-ttl-cache-candidate",
    fixture: "ttl-cache",
    environment: "candidate",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    baseBranch: "main",
    harness: {
      ref: "HEAD",
      sha: "0123456789abcdef0123456789abcdef01234567",
      files: ["CLAUDE.md"],
      hash: "candidate-hash",
    },
    agent: { name: "claude-code", command: "/usr/local/bin/claude", model: "claude-sonnet-4-5" },
    outcome: "completed",
    exitCode: 0,
    startedAt: "2026-09-19T03:14:55.000Z",
    finishedAt: "2026-09-19T03:19:07.000Z",
    tokens: { input: 1000, output: 20000, cacheRead: 400000, cacheWrite: 10000 },
    costUsd: 0.4,
    durationMs: 240000,
    turns: 20,
    toolCalls: { Read: 20, Edit: 10, Bash: 10 },
    toolFailures: 2,
    telemetry: telemetry(),
    diff: { files: 5, added: 200, removed: 20 },
    tests: { command: "npm test", exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: "Added a TTL cache.",
    ...patch,
  };
}

function previous(patch: Partial<RunRecord> = {}): RunRecord {
  return record({
    runId: "20260919-031455-ttl-cache-previous",
    environment: "previous",
    harness: {
      ref: "9c21e6389abcdef0123456789abcdef01234567",
      sha: "9c21e6389abcdef0123456789abcdef01234567",
      files: ["CLAUDE.md"],
      hash: "previous-hash",
    },
    ...patch,
  });
}

/** compare(), with `before` and `after` applied on top of a clean pair. */
function pair(before: Partial<RunRecord>, after: Partial<RunRecord> = {}) {
  return compare(previous(before), record(after));
}

function row(rows: Row[], id: string): Row {
  const found = rows.find((r) => r.id === id);
  assert.ok(found, `no row ${id} in ${rows.map((r) => r.id).join(", ")}`);
  return found;
}

const ROW_IDS = [
  "outcome",
  "tests",
  "diff.files",
  "diff.lines",
  "turns",
  "toolCalls.main",
  "toolCalls.sub",
  "toolFailures",
  "subAgents",
  "readsBeforeFirstEdit",
  "duplicateReads",
  "tokens.mainCacheRead",
  "phases.exploringMs",
  "tokens.total",
  "tokens.output",
  "costUsd",
  "durationMs",
];

test("identical runs give every row unchanged, in the fixed order, with no warnings", () => {
  const c = pair({});

  assert.deepEqual(
    c.rows.map((r) => r.id),
    ROW_IDS,
  );
  for (const r of c.rows) {
    assert.equal(r.classification, "unchanged", r.id);
    assert.equal(r.delta, "", r.id);
    // The sub-agents row always says which models ran; nothing else has a note.
    assert.equal(r.note, r.id === "subAgents" ? "Explore on claude-haiku-4-5" : undefined, r.id);
  }
  assert.deepEqual(c.warnings, []);
  assert.equal(c.fixture, "ttl-cache");
  assert.equal(c.headSha, "0123456789abcdef0123456789abcdef01234567");
  assert.deepEqual(c.previous, {
    runId: "20260919-031455-ttl-cache-previous",
    harnessSha: "9c21e6389abcdef0123456789abcdef01234567",
    model: "claude-sonnet-4-5",
  });
  assert.deepEqual(c.candidate, {
    runId: "20260919-031455-ttl-cache-candidate",
    harnessSha: "0123456789abcdef0123456789abcdef01234567",
    model: "claude-sonnet-4-5",
  });
});

test("outcome: completed is best, everything else is a state change", () => {
  assert.equal(row(pair({ outcome: "timeout" }).rows, "outcome").classification, "improved");
  assert.equal(row(pair({}, { outcome: "error" }).rows, "outcome").classification, "regressed");
  const same = row(pair({ outcome: "timeout" }, { outcome: "error" }).rows, "outcome");
  assert.equal(same.classification, "unchanged");
  assert.equal(same.previous, "timeout");
  assert.equal(same.candidate, "error");
});

test("tests: passed is best; n/a when either side has no test command", () => {
  const failed = { command: "npm test", exitCode: 1, durationMs: 100, timedOut: false };
  const timedOut = { command: "npm test", exitCode: null, durationMs: 100, timedOut: true };
  assert.equal(row(pair({ tests: failed }).rows, "tests").classification, "improved");
  assert.equal(row(pair({}, { tests: timedOut }).rows, "tests").classification, "regressed");
  assert.equal(row(pair({ tests: failed }, { tests: failed }).rows, "tests").classification, "unchanged");

  const missing = row(pair({}, { tests: null }).rows, "tests");
  assert.equal(missing.classification, "n/a");
  assert.equal(missing.candidate, "not configured");
  assert.equal(missing.note, "no test command configured");
});

test("numeric rows: lower is better, shown as counts or percentages", () => {
  const expect = (
    id: string,
    before: Partial<RunRecord>,
    after: Partial<RunRecord>,
    display: [string, string, string, Classification],
  ) => {
    const r = row(pair(before, after).rows, id);
    assert.deepEqual([r.previous, r.candidate, r.delta, r.classification], display, id);
  };

  expect("diff.files", { diff: { files: 5, added: 200, removed: 20 } }, { diff: { files: 3, added: 200, removed: 20 } }, ["5", "3", "-2", "improved"]);
  expect("diff.files", {}, { diff: { files: 8, added: 200, removed: 20 } }, ["5", "8", "+3", "regressed"]);
  expect("diff.lines", {}, { diff: { files: 5, added: 100, removed: 10 } }, ["220", "110", "-50%", "improved"]);
  expect("diff.lines", {}, { diff: { files: 5, added: 400, removed: 40 } }, ["220", "440", "+100%", "regressed"]);
  expect("turns", {}, { turns: 10 }, ["20", "10", "-10", "improved"]);
  expect("turns", {}, { turns: 40 }, ["20", "40", "+20", "regressed"]);
  const main = (toolCalls: number) => ({ telemetry: telemetry({ main: { ...telemetry().main, toolCalls } }) });
  expect("toolCalls.main", {}, main(10), ["40", "10", "-30", "improved"]);
  expect("toolCalls.main", {}, main(80), ["40", "80", "+40", "regressed"]);
  const sub = (toolCalls: number) => ({ telemetry: telemetry({ subAgents: [{ ...telemetry().subAgents[0]!, toolCalls }] }) });
  expect("toolCalls.sub", {}, sub(2), ["10", "2", "-8", "improved"]);
  expect("toolCalls.sub", {}, { telemetry: telemetry({ subAgents: [] }) }, ["10", "0", "-10", "improved"]);
  expect("readsBeforeFirstEdit", {}, { telemetry: telemetry({ readsBeforeFirstEdit: 5 }) }, ["10", "5", "-5", "improved"]);
  expect("readsBeforeFirstEdit", {}, { telemetry: telemetry({ readsBeforeFirstEdit: 12 }) }, ["10", "12", "+2", "unchanged"]);
  expect("readsBeforeFirstEdit", {}, { telemetry: telemetry({ readsBeforeFirstEdit: 13 }) }, ["10", "13", "+3", "regressed"]);
  expect("duplicateReads", {}, { telemetry: telemetry({ duplicateReads: 0 }) }, ["4", "0", "-4", "improved"]);
  expect("duplicateReads", {}, { telemetry: telemetry({ duplicateReads: 5 }) }, ["4", "5", "+1", "unchanged"]);
  expect("duplicateReads", {}, { telemetry: telemetry({ duplicateReads: 6 }) }, ["4", "6", "+2", "regressed"]);
  const cacheRead = (n: number) => ({ telemetry: telemetry({ main: { ...telemetry().main, tokens: { ...telemetry().main.tokens, cacheRead: n } } }) });
  expect("tokens.mainCacheRead", {}, cacheRead(150000), ["300,000", "150,000", "-50%", "improved"]);
  expect("tokens.mainCacheRead", {}, cacheRead(330000), ["300,000", "330,000", "+10%", "unchanged"]);
  expect("tokens.mainCacheRead", {}, cacheRead(360000), ["300,000", "360,000", "+20%", "regressed"]);
  const exploring = (ms: number) => ({ telemetry: telemetry({ phases: { exploringMs: ms, buildingMs: 0, verifyingMs: 0 } }) });
  expect("phases.exploringMs", {}, exploring(30000), ["1m00s", "30s", "-50%", "improved"]);
  expect("phases.exploringMs", {}, exploring(120000), ["1m00s", "2m00s", "+100%", "regressed"]);
  expect("toolFailures", {}, { toolFailures: 0 }, ["2", "0", "-2", "improved"]);
  expect("toolFailures", {}, { toolFailures: 4 }, ["2", "4", "+2", "regressed"]);
  const tokens = (output: number) => ({ tokens: { input: 1000, output, cacheRead: 400000, cacheWrite: 10000 } });
  expect("tokens.total", {}, tokens(0), ["431,000", "411,000", "-5%", "unchanged"]);
  expect("tokens.total", {}, { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, ["431,000", "0", "-100%", "improved"]);
  expect("tokens.total", {}, { tokens: { input: 1000, output: 20000, cacheRead: 800000, cacheWrite: 10000 } }, ["431,000", "831,000", "+93%", "regressed"]);
  expect("tokens.output", {}, tokens(10000), ["20,000", "10,000", "-50%", "improved"]);
  expect("tokens.output", {}, tokens(30000), ["20,000", "30,000", "+50%", "regressed"]);
  expect("costUsd", {}, { costUsd: 0.2 }, ["$0.40", "$0.20", "-50%", "improved"]);
  expect("costUsd", {}, { costUsd: 0.5 }, ["$0.40", "$0.50", "+25%", "regressed"]);
  expect("durationMs", {}, { durationMs: 120000 }, ["4m00s", "2m00s", "-50%", "improved"]);
  expect("durationMs", {}, { durationMs: 480000 }, ["4m00s", "8m00s", "+100%", "regressed"]);
});

test("sub-agents: never better or worse, the delta shown, the models in the note", () => {
  const none = { telemetry: telemetry({ subAgents: [] }) };
  const more = {
    telemetry: telemetry({
      subAgents: [...telemetry().subAgents, { ...telemetry().subAgents[0]!, id: "toolu_2", tool: "Task", model: null }],
    }),
  };

  const fewer = row(pair({}, none).rows, "subAgents");
  assert.deepEqual(
    [fewer.previous, fewer.candidate, fewer.delta, fewer.classification, fewer.note],
    ["1", "0", "-1", "unchanged", "previous Explore on claude-haiku-4-5 → candidate none"],
  );
  const added = row(pair({}, more).rows, "subAgents");
  assert.deepEqual(
    [added.previous, added.candidate, added.delta, added.classification, added.note],
    ["1", "2", "+1", "unchanged", "previous Explore on claude-haiku-4-5 → candidate Explore on claude-haiku-4-5, Task on model not reported"],
  );
  assert.equal(row(pair(none, none).rows, "subAgents").note, undefined);
});

test("telemetry rows are n/a on a record from before telemetry was recorded", () => {
  const { telemetry: _dropped, ...earlier } = previous();
  const c = compare(earlier as RunRecord, record());

  for (const id of ["toolCalls.main", "toolCalls.sub", "subAgents", "readsBeforeFirstEdit", "duplicateReads", "tokens.mainCacheRead", "phases.exploringMs"]) {
    const r = row(c.rows, id);
    assert.equal(r.classification, "n/a", id);
    assert.equal(r.note, "recorded by an earlier version", id);
    assert.equal(r.previous, "n/a", id);
    assert.notEqual(r.candidate, "n/a", id);
    assert.equal(r.delta, "", id);
  }
  assert.equal(row(c.rows, "turns").classification, "unchanged");
  assert.deepEqual(c.warnings, []);
});

test("cost is n/a when either side did not report it", () => {
  const r = row(pair({ costUsd: null }).rows, "costUsd");
  assert.equal(r.classification, "n/a");
  assert.equal(r.previous, "n/a");
  assert.equal(r.candidate, "$0.40");
  assert.equal(r.delta, "");
  assert.equal(r.note, "cost not reported");
});

test("a delta under the floor or the relative threshold is unchanged, within noise", () => {
  const turns = row(pair({ turns: 2 }, { turns: 3 }).rows, "turns");
  assert.equal(turns.classification, "unchanged");
  assert.equal(turns.delta, "+1");
  assert.equal(turns.note, "within noise");

  assert.equal(row(pair({ turns: 20 }, { turns: 40 }).rows, "turns").classification, "regressed");
  // Clears the floor (3) but not the relative threshold (15%).
  assert.equal(row(pair({ turns: 100 }, { turns: 104 }).rows, "turns").classification, "unchanged");
  // Clears the relative threshold (20%) but not the floor (20 lines).
  const lines = row(pair({ diff: { files: 1, added: 10, removed: 0 } }, { diff: { files: 1, added: 15, removed: 0 } }).rows, "diff.lines");
  assert.equal(lines.classification, "unchanged");
  assert.equal(lines.note, "within noise");
  // Tokens have no floor: 15% is the whole test.
  const t = (n: number) => ({ tokens: { input: n, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(row(pair(t(1000), t(1140)).rows, "tokens.total").classification, "unchanged");
  assert.equal(row(pair(t(1000), t(1150)).rows, "tokens.total").classification, "regressed");
});

test("a side that did not complete makes every effort row n/a and warns", () => {
  const c = pair({ outcome: "timeout", exitCode: null });

  assert.deepEqual(c.warnings, [
    "previous did not complete (timeout); its effort rows are not comparable",
  ]);
  for (const id of ["outcome", "tests", "diff.files", "diff.lines"]) {
    assert.notEqual(row(c.rows, id).classification, "n/a", id);
  }
  for (const id of ROW_IDS.slice(ROW_IDS.indexOf("turns"))) {
    const r = row(c.rows, id);
    assert.equal(r.classification, "n/a", id);
    assert.equal(r.note, "previous did not complete", id);
    assert.equal(r.delta, "", id);
    assert.notEqual(r.previous, "", `${id} still shows its value`);
  }

  const both = pair({ outcome: "timeout" }, { outcome: "error" });
  assert.equal(row(both.rows, "turns").note, "previous did not complete; candidate did not complete");
  assert.equal(both.warnings.length, 2);
});

test("warns when the models differ", () => {
  assert.deepEqual(pair({ agent: { name: "claude-code", command: "claude", model: "claude-opus-5" } }).warnings, [
    "models differ: previous claude-opus-5, candidate claude-sonnet-4-5",
  ]);
  assert.deepEqual(pair({}, { agent: { name: "claude-code", command: "claude", model: null } }).warnings, [
    "models differ: previous claude-sonnet-4-5, candidate not reported",
  ]);
});

test("warns when both sides ran the same harness", () => {
  const c = pair({ harness: record().harness });
  assert.deepEqual(c.warnings, [
    "both sides ran the same harness (hash candidate-ha); any delta is noise, not the effect of a change",
  ]);
});

test("warns when the records come from different run invocations", () => {
  const c = pair({ runId: "20260918-120000-ttl-cache-previous" });
  assert.deepEqual(c.warnings, [
    "the runs come from different `run` invocations (20260918-120000-ttl-cache-previous, 20260919-031455-ttl-cache-candidate)",
  ]);
});
