import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compare as compareRecords, rollup, type Comparison, type JudgeInput, type Rollup } from "../compare.js";
import { RUNS_DIR, type Config } from "../config.js";
import { CliError } from "../errors.js";
import { requireJudge } from "../judges.js";
import { requireConfig, requireGit, requireRepo } from "../preflight.js";
import { formatBatch, formatBatchMarkdown, formatComparison, formatComparisonMarkdown } from "../print.js";
import {
  ENVIRONMENTS,
  RUN_ID,
  latestBatch,
  listBatches,
  readRunRecord,
  type Batch,
  type Environment,
  type RunRecord,
} from "../run-record.js";
// Type-only: judge.ts imports this file for the pair loader, so the file name and schema
// number are repeated below rather than imported.
import type { JudgeRecord } from "./judge.js";

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
  const config = requireConfig(root);
  const [previous, candidate] = loadPair(root, "compare", options);
  const comparison = compareRecords(previous, candidate, loadJudgement(root, config, previous, candidate));

  if (options.json) console.log(JSON.stringify(comparison, null, 2));
  else if (options.markdown) console.log(formatComparisonMarkdown(comparison));
  else console.log(formatComparison(comparison));
  return comparison;
}

export type CompareBatchOptions = {
  cwd: string;
  /** The batch with this stamp; when absent, the latest batch with at least one complete pair. */
  stamp?: string | undefined;
  json: boolean;
  markdown: boolean;
};

/** One fixture of a compared batch: its table, or why it has none. */
export type BatchFixtureComparison = { fixture: string; comparison: Comparison | null; error: string | null };

/** A batch compared: the shape `--json` prints, minus what `run` adds. */
export type BatchComparison = { stamp: string; fixtures: BatchFixtureComparison[]; rollup: Rollup };

/**
 * The delta tables of every complete pair in one batch, under their roll-up. A pair with a
 * missing side is listed with the reason and compared with nothing; a batch with no complete
 * pair at all is refused.
 */
export function compareBatch(options: CompareBatchOptions): BatchComparison {
  requireGit();
  const root = requireRepo(options.cwd);
  const config = requireConfig(root);
  const batch = loadBatch(root, options.stamp);
  const result = compareBatchRecords(root, config, batch);
  const headSha = headShaOf(result);

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (options.markdown) console.log(formatBatchMarkdown(result.rollup, result.fixtures, headSha));
  else console.log(formatBatch(result.rollup, result.fixtures, headSha));
  return result;
}

/** The code a batch ran on: every record agrees, so the first complete pair's says. */
export function headShaOf(result: BatchComparison): string {
  return result.fixtures.find((each) => each.comparison !== null)?.comparison?.headSha ?? "";
}

/**
 * The batch a command was pointed at: `--stamp`, or the newest batch with a complete pair.
 * Refused, naming the stamp and what is missing, when it has no pair to compare.
 */
export function loadBatch(root: string, stamp: string | undefined): Batch {
  const runsDir = join(root, RUNS_DIR);
  let batch: Batch | null;
  if (stamp === undefined) {
    batch = latestBatch(runsDir, (each) => each.pairs.some(complete));
    if (batch === null) {
      const seen = listBatches(runsDir);
      const why = seen.length === 0 ? `no runs in ${RUNS_DIR}` : `no complete previous/candidate pair in ${RUNS_DIR}`;
      throw new CliError(`${why} - run \`harnessbench run\` first, or name two run ids`, 1);
    }
  } else {
    batch = listBatches(runsDir).find((each) => each.stamp === stamp) ?? null;
    if (batch === null) {
      const stamps = listBatches(runsDir).map((each) => `  ${each.stamp}`);
      const known = stamps.length === 0 ? `no runs in ${RUNS_DIR}` : `stamps in ${RUNS_DIR}:\n${stamps.join("\n")}`;
      throw new CliError(`no runs with stamp '${stamp}'\n\n${known}`, 1);
    }
    if (!batch.pairs.some(complete)) {
      throw new CliError(
        `batch ${stamp} has no complete previous/candidate pair:\n${batch.pairs.map((pair) => `  ${describePair(runsDir, stamp, pair)}`).join("\n")}`,
        1,
      );
    }
  }
  return batch;
}

function complete(pair: Batch["pairs"][number]): boolean {
  return pair.previous !== null && pair.candidate !== null;
}

/** `ttl-cache: candidate side missing` or `... unreadable`, for every side a pair lacks. */
export function describePair(runsDir: string, stamp: string, pair: Batch["pairs"][number]): string {
  const missing = ENVIRONMENTS.filter((environment) => pair[environment] === null).map((environment: Environment) => {
    const dir = join(runsDir, `${stamp}-${pair.fixture}-${environment}`);
    return `${environment} side ${existsSync(dir) ? "unreadable (no valid run.json)" : "missing"}`;
  });
  return `${pair.fixture}: ${missing.join(", ")}`;
}

/**
 * Every pair of a batch compared, in fixture order. A pair that cannot be compared (a side
 * missing, or the two records not a valid pair) is kept with the reason as its error, so the
 * roll-up counts only what was compared and the reader still sees the rest.
 */
export function compareBatchRecords(root: string, config: Config, batch: Batch): BatchComparison {
  const runsDir = join(root, RUNS_DIR);
  const fixtures = batch.pairs.map((pair): BatchFixtureComparison => {
    if (pair.previous === null || pair.candidate === null) {
      return { fixture: pair.fixture, comparison: null, error: describePair(runsDir, batch.stamp, pair) };
    }
    let ordered: [RunRecord, RunRecord];
    try {
      ordered = orderPair([pair.previous, pair.candidate]);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return { fixture: pair.fixture, comparison: null, error: error.message };
    }
    // A judge the config names but the catalogue lacks is the same refusal a single compare gives.
    const judgement = loadJudgement(root, config, ...ordered);
    return { fixture: pair.fixture, comparison: compareRecords(...ordered, judgement), error: null };
  });
  return {
    stamp: batch.stamp,
    fixtures,
    rollup: rollup(fixtures.flatMap((each) => (each.comparison === null ? [] : [each.comparison]))),
  };
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

/**
 * The judge rows' input: the pair's `judge.json`, if one exists, and the configured judges with
 * their current rubric hashes. Null when the config names no judges: then there are no judge
 * rows at all. A configured judge missing from the catalogue is the error `judge` gives.
 */
export function loadJudgement(root: string, config: Config, previous: RunRecord, candidate: RunRecord): JudgeInput | null {
  if (config.judges.length === 0) return null;
  const configured = config.judges.map((id) => {
    const judge = requireJudge(root, id);
    return { id, title: judge.meta.title, hash: judge.hash };
  });
  const found = findJudgeRecord(join(root, RUNS_DIR), previous, candidate);
  return { record: found === null ? null : found.record, configured };
}

/**
 * The `-judge` directory whose judge.json names this pair. Matched on the two run ids, not
 * on the directory's stamp: the stamp is a naming convention, the ids are the fact. A
 * judge.json that is not one of ours (unreadable, another schema) is skipped, not an error.
 */
export function findJudgeRecord(
  runsDir: string,
  previous: RunRecord,
  candidate: RunRecord,
): { dir: string; record: JudgeRecord } | null {
  const suffix = `-${previous.fixture}-judge`;
  const entries = existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true }) : [];
  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of names) {
    const path = join(runsDir, name, "judge.json");
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const record = parsed as Partial<JudgeRecord> | null;
    if (
      typeof record !== "object" ||
      record === null ||
      record.schema !== 1 ||
      record.previous?.runId !== previous.runId ||
      record.candidate?.runId !== candidate.runId ||
      !Array.isArray(record.verdicts)
    ) {
      continue;
    }
    return { dir: join(runsDir, name), record: record as JudgeRecord };
  }
  return null;
}

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
