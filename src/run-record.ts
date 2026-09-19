import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "./errors.js";

/**
 * What one run left behind, as `run.json` in its run directory. Every later command reads a
 * run only through readRunRecord, so the schema number is the one place compatibility lives.
 */

export const RUN_RECORD_SCHEMA = 1;
export const RUN_RECORD_FILE = "run.json";

export type RunOutcome = "completed" | "timeout" | "error";

export type TestResult = {
  command: string;
  /** Null when the test command was killed, including on timeout. */
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
};

export type RunRecord = {
  schema: typeof RUN_RECORD_SCHEMA;
  runId: string;
  fixture: string;
  environment: "candidate";
  headSha: string;
  baseBranch: string;
  /** `model` is what actually ran, as the agent reported it; null when it did not say. */
  agent: { name: string; command: string; model: string | null };
  outcome: RunOutcome;
  /** Null when the agent was killed by a signal, including on timeout. */
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Null when the agent does not report cost. */
  costUsd: number | null;
  durationMs: number;
  turns: number;
  toolCalls: Record<string, number>;
  toolFailures: number;
  diff: { files: number; added: number; removed: number };
  /** Null when no test command is configured. */
  tests: TestResult | null;
  finalMessage: string;
};

export function runRecordPath(dir: string): string {
  return join(dir, RUN_RECORD_FILE);
}

export function writeRunRecord(dir: string, record: RunRecord): void {
  writeFileSync(runRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** The record in `dir`, checked to be one this version knows how to read. */
export function readRunRecord(dir: string): RunRecord {
  const path = runRecordPath(dir);
  if (!existsSync(path)) throw new CliError(`no ${RUN_RECORD_FILE} in ${dir}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`${path} is not valid JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${path}: expected a JSON object`);
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (schema !== RUN_RECORD_SCHEMA) {
    throw new CliError(
      `${path}: schema ${String(schema)}, expected ${RUN_RECORD_SCHEMA} - ` +
        `it was written by another version of harnessbench`,
    );
  }
  return parsed as RunRecord;
}
