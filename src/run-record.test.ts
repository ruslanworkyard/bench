import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CliError } from "./errors.js";
import { readRunRecord, writeRunRecord, type RunRecord } from "./run-record.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-record-")));
  dirs.push(dir);
  return dir;
}

function record(): RunRecord {
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
      files: ["CLAUDE.md", "docs/style.md"],
      hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    },
    agent: { name: "claude-code", command: "/usr/local/bin/claude", model: "claude-sonnet-4-5" },
    outcome: "completed",
    exitCode: 0,
    startedAt: "2026-09-19T03:14:55.000Z",
    finishedAt: "2026-09-19T03:19:07.000Z",
    tokens: { input: 1203, output: 18940, cacheRead: 402113, cacheWrite: 10004 },
    costUsd: 0.38,
    durationMs: 252000,
    turns: 23,
    toolCalls: { Read: 18, Edit: 9, Bash: 14 },
    toolFailures: 2,
    diff: { files: 5, added: 212, removed: 7 },
    tests: { command: "npm test", exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: "Added a TTL cache.",
  };
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a run record round-trips through run.json", () => {
  const dir = tempDir();
  const written = record();

  writeRunRecord(dir, written);

  assert.deepEqual(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")), written);
  assert.deepEqual(readRunRecord(dir), written);
});

test("readRunRecord rejects a run.json with another schema", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ...record(), schema: 1 }), "utf8");

  assert.throws(
    () => readRunRecord(dir),
    (error: unknown) =>
      error instanceof CliError && /run\.json.*schema 1.*expected 2/.test(error.message),
  );
});

test("readRunRecord names a run.json that is not there", () => {
  const dir = tempDir();

  assert.throws(
    () => readRunRecord(dir),
    (error: unknown) => error instanceof CliError && /no run\.json in/.test(error.message),
  );
});
