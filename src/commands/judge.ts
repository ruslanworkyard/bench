import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TranscriptEvent } from "../agents/types.js";
import { RUNS_DIR, type Config } from "../config.js";
import { CliError } from "../errors.js";
import {
  MAPPING,
  assembleContext,
  oversized,
  type Oversize,
  type PairMaterial,
  type SideMaterial,
} from "../judge/context.js";
import { VerdictError, modelJudge, translate, type Judge } from "../judge/judge.js";
import { judgeModel } from "../judge/provider.js";
import { requireJudge, type ContextItem } from "../judges.js";
import {
  requireConfig,
  requireFixture,
  requireGit,
  requireJudgeKey,
  requireJudgeModel,
  requireRepo,
  type ResolvedJudge,
} from "../preflight.js";
import { formatVerdicts } from "../print.js";
import { runStamp, type Environment, type RunRecord } from "../run-record.js";
import { RUN_ID, loadPair } from "./compare.js";

/**
 * Pairwise verdicts on one previous/candidate pair: every configured judge, in order, each
 * shown the two sides as A and B. Refuses before any model call when the pair is not judgeable.
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
  usage: { input: number; output: number };
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

export type JudgeOptions = {
  cwd: string;
  /** Explicit pair, in any order; when absent, the latest pair for `fixture`. */
  runIds?: readonly [string, string] | undefined;
  fixture?: string | undefined;
  json: boolean;
};

/** How a judge is built from its resolved target. Tests hand in one backed by a mock model. */
export type JudgeDeps = { judgeFor: (target: ResolvedJudge) => Judge };

export const defaultDeps: JudgeDeps = { judgeFor: (target) => modelJudge(judgeModel(target)) };

export async function judge(options: JudgeOptions, deps: JudgeDeps = defaultDeps): Promise<JudgeRecord> {
  requireGit();
  const root = requireRepo(options.cwd);
  const config = requireConfig(root);
  const [previous, candidate] = loadPair(root, "judge", options);
  const record = await judgePair(root, config, previous, candidate, deps);
  console.log(options.json ? JSON.stringify(record, null, 2) : formatVerdicts(record));
  return record;
}

/**
 * The judging itself, for `judge` and `run --judge`. The pair has been ordered and checked.
 * Every refusal is a CliError thrown before the first model call; the judge directory is
 * created only once judging is going ahead, and replaces an earlier one for the same pair.
 */
export async function judgePair(
  root: string,
  config: Config,
  previous: RunRecord,
  candidate: RunRecord,
  deps: JudgeDeps = defaultDeps,
): Promise<JudgeRecord> {
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
  const targets = judges.map((each) => {
    const target = requireJudgeModel(each, config.judge);
    requireJudgeKey(each, target);
    return target;
  });

  const runsDir = join(root, RUNS_DIR);
  const pair: PairMaterial = {
    prompt: requireFixture(root, previous.fixture).prompt,
    previous: material(runsDir, previous),
    candidate: material(runsDir, candidate),
  };
  const items: ContextItem[] = [...new Set(judges.flatMap((each) => each.meta.context))];
  const hits = oversized(items, pair, config.judge.maxContextKb);
  if (hits.length > 0) throw new CliError(tooBig(hits, config.judge.maxContextKb), 1);

  const stamp = RUN_ID.exec(previous.runId)?.[1] ?? runStamp(new Date());
  const dirName = `${stamp}-${previous.fixture}-judge`;
  const dir = join(runsDir, dirName);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const verdicts: VerdictRecord[] = [];
  for (const [i, each] of judges.entries()) {
    const target = targets[i] as ResolvedJudge;
    const judgeDir = join(dir, each.meta.id);
    mkdirSync(judgeDir);
    const context = assembleContext(each.meta.context, pair);
    let response;
    try {
      response = await deps.judgeFor(target).judge({ id: each.meta.id, rubric: each.rubric, context });
    } catch (error) {
      if (error instanceof VerdictError) {
        keep(judgeDir, error.system, error.user, { text: error.text, usage: error.usage, attempts: 2 });
        throw new CliError(`${error.message}; its reply is kept in ${RUNS_DIR}/${dirName}/${each.meta.id}/`, 1);
      }
      throw error;
    }
    keep(judgeDir, response.system, response.user, {
      text: response.text,
      usage: response.usage,
      attempts: response.attempts,
    });
    verdicts.push({
      judge: each.meta.id,
      title: each.meta.title,
      preference: translate(response.verdict.preference),
      reason: response.verdict.reason,
      provider: target.provider,
      model: target.model,
      usage: response.usage,
    });
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
  writeFileSync(join(dir, JUDGE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/** What was sent and what came back, per judge, so a verdict can be checked by hand. */
function keep(
  judgeDir: string,
  system: string,
  user: string,
  response: { text: string; usage: { input: number; output: number }; attempts: number },
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
