import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { TranscriptEvent } from "../agents/types.js";
import { compare } from "../compare.js";
import { RUNS_DIR, type Config } from "../config.js";
import { CliError } from "../errors.js";
import { EventBus, emitter, recorder, type Emit } from "../events.js";
import {
  MAPPING,
  assembleContext,
  oversized,
  type Oversize,
  type PairMaterial,
  type SideMaterial,
} from "../judge/context.js";
import { VerdictError, modelJudge, translate, type Judge, type Usage } from "../judge/judge.js";
import { judgeModel, judgeProviderOptions } from "../judge/provider.js";
import { requireJudge, type ContextItem, type LoadedJudge } from "../judges.js";
import {
  requireConfig,
  requireFixture,
  requireGit,
  requireJudgeKey,
  requireJudgeModel,
  requireRepo,
  type ResolvedJudge,
} from "../preflight.js";
import { plainRenderer } from "../render/plain.js";
import { EVENTS_FILE, RUN_ID, reportDir, runStamp, type Environment, type RunRecord } from "../run-record.js";
import {
  batchReport,
  compareBatchRecords,
  findJudgeRecord,
  loadBatch,
  loadJudgement,
  loadPair,
  orderPair,
  pairReport,
  printReport,
  rewriteBatchReport,
  saveReport,
  type BatchComparison,
  type ReportOutput,
  type ReportView,
} from "./compare.js";

/**
 * Pairwise verdicts on one previous/candidate pair: every configured judge at once, each
 * shown the two sides as A and B. Refuses before any model call when the pair is not judgeable.
 * Judging is incremental: a verdict whose rubric has not changed since is kept, not re-bought.
 */

export const JUDGE_RECORD_SCHEMA = 1;
export const JUDGE_RECORD_FILE = "judge.json";

export type VerdictRecord = {
  judge: string;
  title: string;
  /** Translated back from A/B before storage. */
  preference: Environment | "tie";
  reason: string;
  provider: string;
  model: string;
  /** Who served the call behind a router (OpenRouter's `provider`); null when not reported. */
  upstream: string | null;
  usage: Usage;
  /** Wall clock over every attempt. Absent in files written before it was recorded. */
  durationMs: number;
  /** Model calls made: 1, or more after a timeout or a malformed reply. */
  attempts: number;
  /** `LoadedJudge.hash` at the time; a verdict without one (an older file) is stale. */
  rubricHash: string;
};

/** `judge.json` in `.harnessbench/runs/<stamp>-<fixture>-judge/`. */
export type JudgeRecord = {
  schema: typeof JUDGE_RECORD_SCHEMA;
  fixture: string;
  headSha: string;
  previous: { runId: string };
  candidate: { runId: string };
  mapping: typeof MAPPING;
  verdicts: VerdictRecord[];
};

export type JudgeOptions = ReportOutput & {
  cwd: string;
  /** Explicit pair, in any order; when absent, the latest pair for `fixture`. */
  runIds?: readonly [string, string] | undefined;
  fixture?: string | undefined;
  /** Judge every configured judge, even one whose verdict is fresh. */
  all: boolean;
};

/** What `judgePair` did: the record as written, and which judges it ran or kept. */
export type JudgePairResult = { record: JudgeRecord; judged: string[]; kept: string[] };

/** How a judge is built from its resolved target. Tests hand in one backed by a mock model. */
export type JudgeDeps = { judgeFor: (target: ResolvedJudge) => Judge };

export const defaultDeps: JudgeDeps = {
  judgeFor: (target) =>
    modelJudge(judgeModel(target), {
      providerOptions: judgeProviderOptions(target),
      timeoutMs: target.timeoutSeconds * 1000,
    }),
};

export async function judge(options: JudgeOptions, deps: JudgeDeps = defaultDeps): Promise<JudgeRecord> {
  requireGit();
  const root = requireRepo(options.cwd);
  const config = requireConfig(root);
  const invokedAt = Date.now();
  const [previous, candidate] = loadPair(root, "judge", options);
  // A pair of one batch records into that batch's events; a pair across batches has none.
  const stamp = RUN_ID.exec(previous.runId)?.[1];
  const sameBatch = stamp !== undefined && stamp === RUN_ID.exec(candidate.runId)?.[1];
  const emit = judgeEvents(root, invokedAt, previous.fixture.length, sameBatch ? stamp : null, options.view);
  const result = await judgePair(root, config, previous, candidate, deps, options.all, emit);
  const comparison = compare(previous, candidate, loadJudgement(root, config, previous, candidate), config.testLabel);
  const path = rewriteBatchReport(root, config, previous, candidate, options.stepSummary);
  printReport(pairReport(previous, candidate, comparison), options, path);
  return result.record;
}

export type JudgeBatchOptions = ReportOutput & {
  cwd: string;
  /** The batch with this stamp; when absent, the latest batch with at least one complete pair. */
  stamp?: string | undefined;
  all: boolean;
};

/** A judged batch: the compared batch plus, per fixture, what judging did or why it was skipped. */
export type JudgeBatchResult = Omit<BatchComparison, "fixtures"> & {
  fixtures: Array<BatchComparison["fixtures"][number] & { judging: JudgePairResult | null }>;
};

/**
 * Every complete pair of a batch judged at once, each as `judgePair` would alone, then the
 * batch's report written and printed. A pair with a missing side, or one a judge refuses, is
 * listed as skipped with the reason; it never stops the others.
 */
export async function judgeBatch(options: JudgeBatchOptions, deps: JudgeDeps = defaultDeps): Promise<JudgeBatchResult> {
  requireGit();
  const root = requireRepo(options.cwd);
  const config = requireConfig(root);
  const invokedAt = Date.now();
  const batch = loadBatch(root, options.stamp);
  const fixtureWidth = Math.max(...batch.pairs.map((pair) => pair.fixture.length));
  const emit = judgeEvents(root, invokedAt, fixtureWidth, batch.stamp, options.view);

  const settled = await Promise.allSettled(
    batch.pairs.map(async (pair): Promise<JudgePairResult | null> => {
      if (pair.previous === null || pair.candidate === null) return null;
      const [previous, candidate] = orderPair([pair.previous, pair.candidate]);
      return judgePair(root, config, previous, candidate, deps, options.all, emit);
    }),
  );
  const unexpected = settled.find((each) => each.status === "rejected" && !(each.reason instanceof CliError));
  if (unexpected !== undefined) throw (unexpected as PromiseRejectedResult).reason;
  // Nothing judged at all is the refusal a single pair gets, with every pair's reason.
  if (!settled.some((each) => each.status === "fulfilled" && each.value !== null)) {
    const reasons = settled.flatMap((each, i) =>
      each.status === "rejected" ? [`${batch.pairs[i]?.fixture}: ${(each.reason as CliError).message}`] : [],
    );
    throw new CliError(reasons.join("\n"), 1);
  }

  // The tables read what judging just wrote; a pair that was skipped keeps whatever it had.
  const compared = compareBatchRecords(root, config, batch);
  const fixtures = compared.fixtures.map((each, i) => {
    const outcome = settled[i] as PromiseSettledResult<JudgePairResult | null>;
    const judging = outcome.status === "fulfilled" ? outcome.value : null;
    const refusal = outcome.status === "rejected" ? `judging skipped: ${(outcome.reason as CliError).message}` : null;
    return { ...each, judging, error: each.error ?? refusal };
  });
  const result: JudgeBatchResult = { ...compared, fixtures };

  const report = batchReport(batch, result);
  printReport(report, options, saveReport(root, report, options.stepSummary));
  return result;
}

/**
 * The judging itself, for `judge` and `run --judge`. The pair has been ordered and checked.
 * Every refusal is a CliError thrown before the first model call. The pair's existing
 * judge.json, if any, is merged into: a configured judge whose verdict carries the current
 * rubric hash is kept without a model call (unless `all`), the others are judged, and verdicts
 * for judges no longer configured ride along untouched, after the configured ones. The new
 * directory is assembled as `<dir>.tmp` and renamed over the old one once every call has
 * settled. A judge that fails does not cost the others their verdicts: they are written, and
 * then the failure is thrown as a CliError naming that judge. `emit` hears each call start and end.
 */
export async function judgePair(
  root: string,
  config: Config,
  previous: RunRecord,
  candidate: RunRecord,
  deps: JudgeDeps = defaultDeps,
  all = false,
  emit?: Emit,
): Promise<JudgePairResult> {
  for (const side of [previous, candidate]) {
    if (side.outcome !== "completed") {
      throw new CliError(
        `${side.environment} did not complete (${side.outcome}); only a pair of completed runs is judged`,
        1,
      );
    }
  }
  if (config.judges.length === 0) {
    throw new CliError('no judges configured: "judges" in .harnessbench/config.json is empty', 1);
  }
  const judges = config.judges.map((id) => requireJudge(root, id));

  const runsDir = join(root, RUNS_DIR);
  const existing = findJudgeRecord(runsDir, previous, candidate);
  const stored = new Map((existing?.record.verdicts ?? []).map((verdict) => [verdict.judge, verdict]));
  const fresh = (each: LoadedJudge): VerdictRecord | undefined => {
    const verdict = stored.get(each.meta.id);
    return !all && verdict !== undefined && verdict.rubricHash === each.hash ? verdict : undefined;
  };
  const todo = judges.filter((each) => fresh(each) === undefined);

  // Only a judge that will be called needs a model, a key and the pair's artefacts.
  const targets = new Map<string, ResolvedJudge>();
  for (const each of todo) {
    const target = requireJudgeModel(each, config.judge);
    requireJudgeKey(each, target);
    targets.set(each.meta.id, target);
  }
  let pair: PairMaterial | null = null;
  if (todo.length > 0) {
    pair = {
      prompt: requireFixture(root, previous.fixture).prompt,
      previous: material(runsDir, previous),
      candidate: material(runsDir, candidate),
    };
    const items: ContextItem[] = [...new Set(todo.flatMap((each) => each.meta.context))];
    const hits = oversized(items, pair, config.judge.maxContextKb);
    if (hits.length > 0) throw new CliError(tooBig(hits, config.judge.maxContextKb), 1);
  }

  const stamp = RUN_ID.exec(previous.runId)?.[1] ?? runStamp(new Date());
  const dir = existing?.dir ?? join(runsDir, `${stamp}-${previous.fixture}-judge`);
  const dirName = basename(dir);
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // The per-judge files of a kept verdict travel with it, so the directory stays whole.
  const carry = (id: string): void => {
    if (existing === null) return;
    const from = join(existing.dir, id);
    if (existsSync(from)) cpSync(from, join(tmp, id), { recursive: true });
  };

  // Every call at once: a pair takes as long as its slowest judge, not the sum of them.
  const calls = await Promise.allSettled(
    todo.map(async (each): Promise<VerdictRecord> => {
      const target = targets.get(each.meta.id) as ResolvedJudge;
      const judgeDir = join(tmp, each.meta.id);
      mkdirSync(judgeDir);
      const context = assembleContext(each.meta.context, pair as PairMaterial);
      const call = { fixture: previous.fixture, judge: each.meta.id };
      emit?.({ type: "judge.start", ...call });
      const started = Date.now();
      let response;
      try {
        response = await deps.judgeFor(target).judge({ id: each.meta.id, rubric: each.rubric, context });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit?.({ type: "judge.failed", ...call, message, durationMs: Date.now() - started });
        if (error instanceof VerdictError) {
          keepFiles(judgeDir, error.system, error.user, { text: error.text, usage: error.usage, attempts: error.attempts });
          throw new CliError(`${error.message}; its reply is kept in ${RUNS_DIR}/${dirName}/${each.meta.id}/`, 1);
        }
        rmSync(judgeDir, { recursive: true, force: true });
        throw error;
      }
      keepFiles(judgeDir, response.system, response.user, {
        text: response.text,
        usage: response.usage,
        attempts: response.attempts,
        durationMs: response.durationMs,
        upstream: response.upstream,
      });
      const verdict: VerdictRecord = {
        judge: each.meta.id,
        title: each.meta.title,
        preference: translate(response.verdict.preference),
        reason: response.verdict.reason,
        provider: target.provider,
        model: target.model,
        upstream: response.upstream,
        usage: response.usage,
        durationMs: response.durationMs,
        attempts: response.attempts,
        rubricHash: each.hash,
      };
      emit?.({
        type: "judge.verdict",
        ...call,
        preference: verdict.preference,
        durationMs: verdict.durationMs,
        upstream: verdict.upstream,
      });
      return verdict;
    }),
  );
  const unexpected = calls.find((each) => each.status === "rejected" && !(each.reason instanceof CliError));
  if (unexpected !== undefined) throw (unexpected as PromiseRejectedResult).reason;
  const outcomes = new Map(todo.map((each, i) => [each.meta.id, calls[i] as PromiseSettledResult<VerdictRecord>]));

  // Config order, whatever order the calls finished in. A judge that failed has no verdict:
  // the table shows it missing, and the others' verdicts are written all the same.
  const verdicts: VerdictRecord[] = [];
  const judged: string[] = [];
  const kept: string[] = [];
  const failures: string[] = [];
  for (const each of judges) {
    const keep = fresh(each);
    if (keep !== undefined) {
      verdicts.push(keep);
      kept.push(each.meta.id);
      carry(each.meta.id);
      continue;
    }
    const outcome = outcomes.get(each.meta.id) as PromiseSettledResult<VerdictRecord>;
    if (outcome.status === "rejected") {
      failures.push((outcome.reason as CliError).message);
      continue;
    }
    verdicts.push(outcome.value);
    judged.push(each.meta.id);
  }
  const configured = new Set(config.judges);
  for (const verdict of existing?.record.verdicts ?? []) {
    if (configured.has(verdict.judge)) continue;
    verdicts.push(verdict);
    carry(verdict.judge);
  }

  const record: JudgeRecord = {
    schema: JUDGE_RECORD_SCHEMA,
    fixture: previous.fixture,
    headSha: previous.headSha,
    previous: { runId: previous.runId },
    candidate: { runId: candidate.runId },
    mapping: MAPPING,
    verdicts,
  };
  writeFileSync(join(tmp, JUDGE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  // Rename cannot replace a non-empty directory: step the old one aside first.
  const old = `${dir}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(dir)) renameSync(dir, old);
  renameSync(tmp, dir);
  rmSync(old, { recursive: true, force: true });
  if (failures.length > 0) throw new CliError(failures.join("\n"), 1);
  return { record, judged, kept };
}

/**
 * The judge command's events, on its own clock: progress lines on stderr, as `run` prints its
 * sides', and, when the pairs are one batch's, appended to that batch's `events.jsonl` after a
 * session line.
 */
function judgeEvents(
  root: string,
  invokedAt: number,
  fixtureWidth: number,
  stamp: string | null,
  view: ReportView | undefined,
): Emit {
  const bus = new EventBus();
  bus.subscribe(view?.subscriber ?? plainRenderer({ fixtureWidth }));
  if (stamp !== null) {
    const session = { type: "session", command: "judge", startedAt: new Date(invokedAt).toISOString() } as const;
    bus.subscribe(recorder(join(root, reportDir(stamp), EVENTS_FILE), session));
  }
  return emitter(bus, invokedAt);
}

/** What was sent and what came back, per judge, so a verdict can be checked by hand. */
function keepFiles(
  judgeDir: string,
  system: string,
  user: string,
  response: { text: string; usage: Usage; attempts: number; durationMs?: number; upstream?: string | null },
): void {
  writeFileSync(join(judgeDir, "prompt.txt"), `# System\n\n${system}\n\n# User\n\n${user}`, "utf8");
  writeFileSync(join(judgeDir, "response.json"), `${JSON.stringify(response, null, 2)}\n`, "utf8");
}

/** One side's artefacts from its run directory. A completed run always has both files. */
function material(runsDir: string, record: RunRecord): SideMaterial {
  const dir = join(runsDir, record.runId);
  const read = (name: string): string => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      throw new CliError(`run '${record.runId}' has no ${name}; a judge needs the run's artefacts`, 1);
    }
    return readFileSync(path, "utf8");
  };
  const diff = read("diff.patch");
  const transcript = read("transcript.jsonl")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as TranscriptEvent);
  return { record, diff, transcript };
}

function tooBig(hits: Oversize[], maxKb: number): string {
  const lines = hits.map(({ side, item, bytes }) => {
    const what = side === null ? "the fixture prompt" : `the ${side} side's ${item}`;
    return `  ${what} is ${Math.ceil(bytes / 1024)} KB`;
  });
  return (
    `the fixture produces more output than a judge can read; the limit is ${maxKb} KB per item ` +
    `("judge.maxContextKb" in .harnessbench/config.json):\n${lines.join("\n")}\n` +
    "Narrow the fixture, or keep generated paths out of the diff (gitignore them). Nothing is truncated."
  );
}
