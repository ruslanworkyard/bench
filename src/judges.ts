import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { JUDGES_DIR, JUDGE_PROVIDERS, type JudgeProvider } from "./config.js";
import { CliError } from "./errors.js";
import { listFixtures } from "./fixtures.js";

/**
 * The judge catalogue: like fixtures, a directory per judge under `.harnessbench/judges/`,
 * each a `judge.json` plus the rubric it points at. Reading and checking only; copying into
 * the host is `init`'s job, through the same ops fixtures use.
 */

/** What a judge is allowed to look at. Fixed: `context.ts` renders exactly these. */
export const CONTEXT_ITEMS = ["prompt", "diff", "tests", "finalMessage", "toolLog", "transcript"] as const;
export type ContextItem = (typeof CONTEXT_ITEMS)[number];

/** What a judge.json says. */
export type JudgeMeta = {
  id: string;
  /** The table row label. */
  title: string;
  description: string;
  /** The rubric file, relative to the judge's directory. */
  prompt: string;
  context: ContextItem[];
  /** Each overrides the `judge` block of the config for this judge only; null means not set. */
  provider: JudgeProvider | null;
  model: string | null;
  apiKeyEnv: string | null;
};

/**
 * A judge as it exists in the host repository, rubric read. `hash` identifies the rubric a
 * verdict was produced under: a verdict whose `rubricHash` differs is stale.
 */
export type LoadedJudge = { dir: string; meta: JudgeMeta; rubric: string; hash: string };

/** sha256 over the rubric text plus the context list, in order. */
export function rubricHash(rubric: string, context: readonly ContextItem[]): string {
  return createHash("sha256").update(rubric).update("\0").update(context.join(",")).digest("hex");
}

const KNOWN_KEYS = ["id", "title", "description", "prompt", "context", "provider", "model", "apiKeyEnv"];

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Checks a parsed judge.json. `where` names the file in any error. */
export function validateJudge(value: unknown, where: string): JudgeMeta {
  const fail = (message: string): never => {
    throw new CliError(`${where}: ${message}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`expected a JSON object, found ${describe(value)}`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) fail(`unknown key "${key}"`);
  }

  const meta: JudgeMeta = {
    id: "",
    title: "",
    description: "",
    prompt: "prompt.md",
    context: [],
    provider: null,
    model: null,
    apiKeyEnv: null,
  };
  for (const key of ["id", "title", "description"] as const) {
    const field = raw[key];
    if (typeof field !== "string" || field === "") {
      fail(`"${key}" must be a non-empty string, found ${describe(field)}`);
    }
    meta[key] = field as string;
  }

  const prompt = raw["prompt"];
  if (prompt !== undefined) {
    if (typeof prompt !== "string" || prompt === "") {
      fail(`"prompt" must be a non-empty string, found ${describe(prompt)}`);
    }
    meta.prompt = prompt as string;
  }

  const context = raw["context"];
  if (!Array.isArray(context) || context.length === 0) {
    fail(`"context" must be a non-empty array of ${CONTEXT_ITEMS.join(", ")}`);
  }
  for (const item of context as unknown[]) {
    if (typeof item !== "string" || !(CONTEXT_ITEMS as readonly string[]).includes(item)) {
      fail(`"context" entry ${JSON.stringify(item)} is not one of ${CONTEXT_ITEMS.join(", ")}`);
    }
  }
  meta.context = [...new Set(context as ContextItem[])];

  for (const key of ["provider", "model", "apiKeyEnv"] as const) {
    const field = raw[key];
    if (field === undefined || field === null) continue;
    if (typeof field !== "string" || field === "") {
      fail(`"${key}" must be a non-empty string or null, found ${describe(field)}`);
    }
    if (key === "provider" && !(JUDGE_PROVIDERS as readonly string[]).includes(field as string)) {
      fail(`"provider" must be one of ${JUDGE_PROVIDERS.join(", ")}, found "${String(field)}"`);
    }
    meta[key] = field as JudgeProvider;
  }

  return meta;
}

/** The judges/ directory shipped with the package, next to dist/. */
export function packagedJudgesDir(): string {
  return fileURLToPath(new URL("../judges", import.meta.url));
}

/** Reads and checks the judge in `dir`; `shown` is how the directory is named in errors. */
function loadJudge(dir: string, shown: string): LoadedJudge {
  const metaPath = join(dir, "judge.json");
  if (!existsSync(metaPath)) throw new CliError(`${shown} has no judge.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (error) {
    throw new CliError(`${shown}/judge.json is not valid JSON (${(error as Error).message})`);
  }
  const meta = validateJudge(parsed, `${shown}/judge.json`);
  const promptPath = join(dir, meta.prompt);
  if (!existsSync(promptPath)) {
    throw new CliError(`judge '${meta.id}' names prompt "${meta.prompt}", but ${shown}/${meta.prompt} does not exist`);
  }
  const rubric = readFileSync(promptPath, "utf8");
  return { dir, meta, rubric, hash: rubricHash(rubric, meta.context) };
}

/**
 * Every judge in the host repository, by directory name. Each one is checked; two directories
 * claiming the same id are refused, since the config names judges by id.
 */
export function listJudges(root: string): LoadedJudge[] {
  const judges: LoadedJudge[] = [];
  const seen = new Map<string, string>();
  for (const entry of listFixtures(join(root, JUDGES_DIR))) {
    const shown = `${JUDGES_DIR}/${entry.id}`;
    const judge = loadJudge(entry.dir, shown);
    const other = seen.get(judge.meta.id);
    if (other !== undefined) {
      throw new CliError(`judge id '${judge.meta.id}' is claimed by both ${other} and ${shown}; ids must be unique`);
    }
    seen.set(judge.meta.id, shown);
    judges.push(judge);
  }
  return judges;
}

/** The judge with this id, or a CliError listing the ones that exist. */
export function requireJudge(root: string, id: string): LoadedJudge {
  const judges = listJudges(root);
  const judge = judges.find((each) => each.meta.id === id);
  if (judge !== undefined) return judge;
  const ids = judges.map((each) => each.meta.id);
  const available =
    ids.length === 0
      ? `no judges in ${JUDGES_DIR} - run \`harnessbench init\` first`
      : `available judges:\n${ids.map((each) => `  ${each}`).join("\n")}`;
  throw new CliError(`unknown judge '${id}'\n\n${available}`, 1);
}
