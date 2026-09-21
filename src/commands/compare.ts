import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compare as compareRecords, type Comparison } from "../compare.js";
import { RUNS_DIR } from "../config.js";
import { CliError } from "../errors.js";
import { requireConfig, requireGit, requireRepo } from "../preflight.js";
import { formatComparison, formatComparisonMarkdown } from "../print.js";
import { readRunRecord, type RunRecord } from "../run-record.js";

export type CompareOptions = {
  cwd: string;
  /** Explicit pair, in any order; when absent, the latest pair for `fixture`. */
  runIds?: readonly [string, string] | undefined;
  fixture?: string | undefined;
  json: boolean;
  markdown: boolean;
};

/**
 * Loads the two run records of one `run` invocation, checks they are a comparable pair, and
 * prints their delta table. Reports only: the exit code says nothing about regressions.
 */
export function compare(options: CompareOptions): Comparison {
  requireGit();
  const root = requireRepo(options.cwd);
  requireConfig(root);
  const [previous, candidate] = loadPair(root, "compare", options);
  const comparison = compareRecords(previous, candidate);

  if (options.json) console.log(JSON.stringify(comparison, null, 2));
  else if (options.markdown) console.log(formatComparisonMarkdown(comparison));
  else console.log(formatComparison(comparison));
  return comparison;
}

/**
 * The pair a command was pointed at: two ids in any order, or the latest pair of --fixture.
 * Ordered previous then candidate, and refused unless they are comparable. `command` names
 * the caller in the error a missing selection gets.
 */
export function loadPair(
  root: string,
  command: string,
  options: { runIds?: readonly [string, string] | undefined; fixture?: string | undefined },
): [RunRecord, RunRecord] {
  const runsDir = join(root, RUNS_DIR);
  let ids: readonly [string, string];
  if (options.runIds !== undefined) ids = options.runIds;
  else {
    if (options.fixture === undefined) {
      throw new CliError(`${command} needs two run ids, or --fixture <id> to pick its latest pair`, 2);
    }
    ids = latestPair(runsDir, options.fixture);
  }
  const records = ids.map((id) => readRecord(runsDir, id)) as [RunRecord, RunRecord];
  return orderPair(records);
}

export function readRecord(runsDir: string, id: string): RunRecord {
  try {
    return readRunRecord(join(runsDir, id));
  } catch (error) {
    if (error instanceof CliError) throw new CliError(`cannot read run '${id}': ${error.message}`, 1);
    throw error;
  }
}

/** The pair in environment order, refusing anything that is not one previous and one candidate. */
export function orderPair(records: [RunRecord, RunRecord]): [RunRecord, RunRecord] {
  const ids = records.map((record) => record.runId).join(" and ");
  const previous = records.find((record) => record.environment === "previous");
  const candidate = records.find((record) => record.environment === "candidate");
  if (previous === undefined || candidate === undefined || previous === candidate) {
    const envs = records.map((record) => `${record.runId} is ${record.environment}`).join(", ");
    throw new CliError(`the pair must be one previous and one candidate run, got ${envs}`, 1);
  }
  if (previous.fixture !== candidate.fixture) {
    throw new CliError(
      `runs ${ids} are of different fixtures (${previous.fixture} vs ${candidate.fixture})`,
      1,
    );
  }
  if (previous.headSha !== candidate.headSha) {
    throw new CliError(
      `runs ${ids} ran on different code (${previous.headSha.slice(0, 7)} vs ` +
        `${candidate.headSha.slice(0, 7)}); only runs on the same HEAD are comparable`,
      1,
    );
  }
  return [previous, candidate];
}

/** `<stamp>-<fixture>-<environment>`. A `-judge` directory is not a run and never matches. */
export const RUN_ID = /^(\d{8}-\d{6})-(.+)-(previous|candidate)$/;

/** The newest `run` invocation of `fixture` that left both a previous and a candidate directory. */
export function latestPair(runsDir: string, fixture: string): [string, string] {
  const sides = new Map<string, Set<string>>();
  const entries = existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true }) : [];
  for (const entry of entries) {
    const match = entry.isDirectory() ? RUN_ID.exec(entry.name) : null;
    if (match === null || match[2] !== fixture) continue;
    const stamp = match[1] as string;
    sides.set(stamp, (sides.get(stamp) ?? new Set()).add(match[3] as string));
  }
  const stamp = [...sides.entries()]
    .filter(([, envs]) => envs.has("previous") && envs.has("candidate"))
    .map(([stamp]) => stamp)
    .sort()
    .at(-1);
  if (stamp === undefined) {
    throw new CliError(
      `no previous/candidate run pair for fixture '${fixture}' in ${RUNS_DIR} - ` +
        `run \`harnessbench run ${fixture}\` first, or name two run ids`,
      1,
    );
  }
  return [`${stamp}-${fixture}-previous`, `${stamp}-${fixture}-candidate`];
}
