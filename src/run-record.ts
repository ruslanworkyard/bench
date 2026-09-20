import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Usage } from "./agents/types.js";
import type { HarnessSnapshot } from "./detect/harness.js";
import { CliError } from "./errors.js";
import type { Telemetry } from "./telemetry.js";

/**
 * What one run left behind, as `run.json` in its run directory. Every later command reads a
 * run only through readRunRecord, so the schema number is the one place compatibility lives.
 */

export const RUN_RECORD_SCHEMA = 2;
export const RUN_RECORD_FILE = "run.json";

/**
 * How the agent's run ended. `max_turns` is a run cut off by the turn limit: not finished,
 * not broken either, so compare and the judge must never read it as either.
 */
export type RunOutcome = "completed" | "max_turns" | "timeout" | "error";

/**
 * The two harnesses a fixture runs under, on the same code: `previous` is the harness at the
 * merge base with the base branch, `candidate` the harness at HEAD. In running order.
 */
export const ENVIRONMENTS = ["previous", "candidate"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** How one command run in the workspace went: the setup command, or the test command. */
export type CommandResult = {
  command: string;
  /** Null when the command was killed, including on timeout. */
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
};

export type TestResult = CommandResult;

export type RunRecord = {
  schema: typeof RUN_RECORD_SCHEMA;
  runId: string;
  fixture: string;
  environment: Environment;
  /** The code both environments run on. */
  headSha: string;
  baseBranch: string;
  /** The harness this run used: which commit it came from, and which files. */
  harness: HarnessSnapshot;
  /** `model` is what actually ran, as the agent reported it; null when it did not say. */
  agent: { name: string; command: string; model: string | null };
  outcome: RunOutcome;
  /** Null when the agent was killed by a signal, including on timeout. */
  exitCode: number | null;
  /**
   * The setup command that made the tree ready before the agent started; null when none is
   * configured. A failed setup never gets a record, so this is always a success when present.
   * Its time is not part of durationMs or startedAt, which measure the agent only.
   */
  setup: CommandResult | null;
  /** When the agent started: after the clone, the overlay and the setup command. */
  startedAt: string;
  finishedAt: string;
  tokens: Usage;
  /** Null when the agent does not report cost. */
  costUsd: number | null;
  durationMs: number;
  turns: number;
  toolCalls: Record<string, number>;
  toolFailures: number;
  /**
   * Per-thread activity derived from the transcript. Absent only in records written
   * before it existed; readRunRecord still reads those, and compare says so in its rows.
   */
  telemetry?: Telemetry;
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
