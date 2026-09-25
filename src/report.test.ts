import assert from "node:assert/strict";
import { test } from "node:test";

import { compare, type JudgeInput } from "./compare.js";
import { buildReport } from "./report.js";
import type { Environment, RunRecord } from "./run-record.js";

const STAMP = "20260924-052122";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MERGE_BASE = "9c21e6389abcdef0123456789abcdef01234567";

function record(fixture: string, environment: Environment, patch: Partial<RunRecord> = {}): RunRecord {
  const sha = environment === "previous" ? MERGE_BASE : HEAD;
  return {
    schema: 2,
    runId: `${STAMP}-${fixture}-${environment}`,
    fixture,
    environment,
    headSha: HEAD,
    baseBranch: "main",
    harness: { ref: sha, sha, files: ["CLAUDE.md"], hash: `${environment}-hash` },
    agent: { name: "claude-code", command: "claude", model: "claude-sonnet-5" },
    outcome: "completed",
    exitCode: 0,
    setup: null,
    startedAt: "2026-09-24T05:21:22.000Z",
    finishedAt: "2026-09-24T05:25:22.000Z",
    tokens: { input: 1000, output: 20000, cacheRead: 400000, cacheWrite: 10000 },
    costUsd: 0.4,
    durationMs: 240000,
    turns: environment === "previous" ? 30 : 20,
    toolCalls: { Read: 20, Edit: 10 },
    toolFailures: 2,
    diff: { files: 5, added: 200, removed: 20 },
    tests: { state: "passed", command: "npm test", files: [], exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: `${environment} done`,
    ...patch,
  };
}

const JUDGED: JudgeInput = {
  configured: [{ id: "code-quality", title: "Code quality", hash: "h" }],
  record: {
    schema: 1,
    fixture: "ttl-cache",
    headSha: HEAD,
    previous: { runId: `${STAMP}-ttl-cache-previous` },
    candidate: { runId: `${STAMP}-ttl-cache-candidate` },
    mapping: { A: "previous", B: "candidate" },
    verdicts: [
      {
        judge: "code-quality",
        title: "Code quality",
        preference: "candidate",
        reason: "B keeps one error type.",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 1, output: 1 },
        rubricHash: "h",
      },
    ],
  },
};

test("buildReport assembles the batch: shas, agent, judge, roll-up, and per fixture its table, sides and error", () => {
  const ttl = [record("ttl-cache", "previous"), record("ttl-cache", "candidate")] as const;
  const list = [record("list-runs", "previous"), record("list-runs", "candidate")] as const;
  const judged = compare(...ttl, JUDGED);
  const unjudged = compare(...list, null);

  const report = buildReport(STAMP, [
    { fixture: "announcements", previous: record("announcements", "previous"), candidate: null, comparison: null, error: "announcements: candidate: setup command failed" },
    { fixture: "list-runs", previous: list[0], candidate: list[1], comparison: unjudged, error: null },
    { fixture: "ttl-cache", previous: ttl[0], candidate: ttl[1], comparison: judged, error: null },
  ]);

  assert.equal(report.schema, 1);
  assert.equal(report.stamp, STAMP);
  assert.equal(report.headSha, HEAD);
  assert.deepEqual(report.harness, { previous: MERGE_BASE, candidate: HEAD });
  assert.deepEqual(report.agent, { name: "claude-code", model: "claude-sonnet-5" });
  assert.deepEqual(report.judge, { provider: "anthropic", model: "claude-sonnet-4-5" });
  assert.equal(report.rollup.fixtures, 2, "the roll-up counts only what was compared");
  assert.deepEqual(report.rollup.rows.find((row) => row.id === "turns")?.improved, ["list-runs", "ttl-cache"]);
  assert.deepEqual(report.rollup.rows.find((row) => row.id === "judge.code-quality")?.improved, ["ttl-cache"]);

  assert.deepEqual(report.fixtures.map((each) => each.fixture), ["announcements", "list-runs", "ttl-cache"]);
  const [errored, plain, withJudge] = report.fixtures;
  assert.equal(errored?.comparison, null);
  assert.equal(errored?.error, "announcements: candidate: setup command failed");
  assert.equal(errored?.sides.candidate, null);
  assert.equal(errored?.sides.previous?.runId, `${STAMP}-announcements-previous`);
  assert.equal(plain?.comparison?.judged, null);
  assert.equal(plain?.comparison?.rows.some((row) => row.id.startsWith("judge.")), false);
  assert.equal(withJudge?.comparison, judged);

  assert.deepEqual(withJudge?.sides.previous, {
    runId: `${STAMP}-ttl-cache-previous`,
    outcome: "completed",
    durationMs: 240000,
    turns: 30,
    toolCalls: { total: 30, byTool: { Read: 20, Edit: 10 } },
    toolFailures: 2,
    tokens: { input: 1000, output: 20000, cacheRead: 400000, cacheWrite: 10000 },
    costUsd: 0.4,
    setup: null,
    tests: { state: "passed", command: "npm test", files: [], exitCode: 0, durationMs: 12000, timedOut: false },
    diff: { files: 5, added: 200, removed: 20 },
    finalMessage: "previous done",
    runDir: `.harnessbench/runs/${STAMP}-ttl-cache-previous`,
  });
});

test("buildReport without any judged comparison has no judge; without any record it takes the fallback", () => {
  const list = [record("list-runs", "previous"), record("list-runs", "candidate")] as const;
  assert.equal(buildReport(STAMP, [{ fixture: "list-runs", previous: list[0], candidate: list[1], comparison: compare(...list, null), error: null }]).judge, null);

  const fallback = { headSha: HEAD, harness: { previous: MERGE_BASE, candidate: HEAD }, agent: { name: "claude-code", model: null } };
  const failed = buildReport(STAMP, [{ fixture: "ttl-cache", previous: null, candidate: null, comparison: null, error: "ttl-cache: setup failed" }], fallback);
  assert.equal(failed.headSha, HEAD);
  assert.deepEqual(failed.harness, fallback.harness);
  assert.deepEqual(failed.agent, fallback.agent);
  assert.equal(failed.rollup.fixtures, 0);
  assert.deepEqual(failed.fixtures[0]?.sides, { previous: null, candidate: null });
});
