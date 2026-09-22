import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "./errors.js";
import type { FileOp } from "./plan.js";

export const STATE_DIR = ".harnessbench";
export const FIXTURES_DIR = `${STATE_DIR}/fixtures`;
export const JUDGES_DIR = `${STATE_DIR}/judges`;
export const RUNS_DIR = `${STATE_DIR}/runs`;
export const CONFIG_FILE = `${STATE_DIR}/config.json`;
/** Credentials for a laptop: gitignored by init, read into the environment before preflight. */
export const ENV_FILE = `${STATE_DIR}/.env`;
/** The variables the configured agent and judge could use, commented out; committed. */
export const ENV_EXAMPLE_FILE = `${STATE_DIR}/.env.example`;

export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_TIMEOUT_MINUTES = 20;
export const DEFAULT_MAX_CONTEXT_KB = 512;
export const DEFAULT_JUDGES = ["code-quality", "engineering-practices", "test-quality"];

/** How one agent is driven. `name` picks the adapter; the rest is that adapter's business. */
export type AgentConfig = {
  name: string;
  /** Binary or path. Empty means the adapter's own default command. */
  command: string;
  model: string | null;
  maxTurns: number | null;
  timeoutMinutes: number;
  /** Appended verbatim after the arguments the adapter builds. */
  args: string[];
  /** Extra host environment variable NAMES to forward, on top of the adapter's own. */
  env: string[];
};

/** The model layers a judge can be served by; `provider.ts` in `judge/` knows what each needs. */
export const JUDGE_PROVIDERS = ["anthropic", "openai", "google", "openai-compatible"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

/** How judges reach a model. A judge.json may override provider, model and apiKeyEnv. */
export type JudgeConfig = {
  provider: JudgeProvider;
  /** Required to judge; init writes it empty so the choice is the user's. */
  model: string;
  /** The environment variable holding the key. Empty means the provider's conventional one. */
  apiKeyEnv: string;
  /** openai-compatible only: where the server is. */
  baseUrl: string;
  /**
   * openai-compatible only: ask the endpoint to hold the reply to the verdict schema
   * (`response_format`). Off for an endpoint that rejects it; the other providers always do.
   */
  structuredOutputs: boolean;
  /** Per context item, per side: a bigger item is refused, never truncated. */
  maxContextKb: number;
};

export type Config = {
  baseBranch: string;
  testCommand: string;
  /** Run in the workspace before the agent starts, to install dependencies. Empty means none. */
  setupCommand: string;
  agent: AgentConfig;
  harness: { extraPaths: string[] };
  judge: JudgeConfig;
  /** The judges `judge` runs, in this order, by id under `.harnessbench/judges/`. */
  judges: string[];
};

const TOP_KEYS = ["baseBranch", "testCommand", "setupCommand", "agent", "harness", "judge", "judges"] as const;
const JUDGE_KEYS = ["provider", "model", "apiKeyEnv", "baseUrl", "structuredOutputs", "maxContextKb"] as const;
const AGENT_KEYS = [
  "name",
  "command",
  "model",
  "maxTurns",
  "timeoutMinutes",
  "args",
  "env",
] as const;
const HARNESS_KEYS = ["extraPaths"] as const;

export function defaults(): Config {
  return {
    baseBranch: DEFAULT_BASE_BRANCH,
    testCommand: "",
    setupCommand: "",
    agent: {
      name: "",
      command: "",
      model: null,
      maxTurns: null,
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      args: [],
      env: [],
    },
    harness: { extraPaths: [] },
    judge: {
      provider: "anthropic",
      model: "",
      apiKeyEnv: "",
      baseUrl: "",
      structuredOutputs: true,
      maxContextKb: DEFAULT_MAX_CONTEXT_KB,
    },
    judges: [...DEFAULT_JUDGES],
  };
}

export function configPath(root: string): string {
  return join(root, CONFIG_FILE);
}

function fail(message: string): never {
  throw new CliError(`${CONFIG_FILE}: ${message}`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Every key has to be one we know; a typo is a silently ignored setting otherwise. */
function checkKeys(raw: Record<string, unknown>, known: readonly string[], prefix: string): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) fail(`unknown key "${prefix}${key}"`);
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be an object, found ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function stringField(raw: Record<string, unknown>, key: string, where: string): string | undefined {
  const field = raw[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") fail(`${where} must be a string, found ${describe(field)}`);
  return field;
}

/** A setting the agent leaves to the tool it drives: a value, or null for "unset". */
function nullableString(
  raw: Record<string, unknown>,
  key: string,
  where: string,
): string | null | undefined {
  const field = raw[key];
  if (field === undefined) return undefined;
  if (field === null) return null;
  if (typeof field !== "string") fail(`${where} must be a string or null, found ${describe(field)}`);
  return field;
}

function booleanField(raw: Record<string, unknown>, key: string, where: string): boolean | undefined {
  const field = raw[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") fail(`${where} must be true or false, found ${describe(field)}`);
  return field;
}

function positiveNumber(raw: Record<string, unknown>, key: string, where: string): number | undefined {
  const field = raw[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isFinite(field) || field <= 0) {
    fail(`${where} must be a positive number, found ${describe(field)}`);
  }
  return field;
}

function stringArray(raw: Record<string, unknown>, key: string, where: string): string[] | undefined {
  const field = raw[key];
  if (field === undefined) return undefined;
  if (!Array.isArray(field) || field.some((entry) => typeof entry !== "string")) {
    fail(`${where} must be an array of strings`);
  }
  return [...(field as string[])];
}

function validateAgent(value: unknown, agent: AgentConfig): void {
  const raw = object(value, '"agent"');
  checkKeys(raw, AGENT_KEYS, "agent.");

  agent.name = stringField(raw, "name", '"agent.name"') ?? agent.name;
  agent.command = stringField(raw, "command", '"agent.command"') ?? agent.command;

  const model = nullableString(raw, "model", '"agent.model"');
  if (model !== undefined) agent.model = model;

  const maxTurns = raw["maxTurns"];
  if (maxTurns !== undefined) {
    if (maxTurns === null) agent.maxTurns = null;
    else if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns <= 0) {
      fail(`"agent.maxTurns" must be a positive integer or null, found ${describe(maxTurns)}`);
    } else agent.maxTurns = maxTurns;
  }

  agent.timeoutMinutes =
    positiveNumber(raw, "timeoutMinutes", '"agent.timeoutMinutes"') ?? agent.timeoutMinutes;
  agent.args = stringArray(raw, "args", '"agent.args"') ?? agent.args;
  agent.env = stringArray(raw, "env", '"agent.env"') ?? agent.env;
}

function validateJudge(value: unknown, judge: JudgeConfig): void {
  const raw = object(value, '"judge"');
  checkKeys(raw, JUDGE_KEYS, "judge.");

  const provider = stringField(raw, "provider", '"judge.provider"');
  if (provider !== undefined) {
    if (!(JUDGE_PROVIDERS as readonly string[]).includes(provider)) {
      fail(`"judge.provider" must be one of ${JUDGE_PROVIDERS.join(", ")}, found "${provider}"`);
    }
    judge.provider = provider as JudgeProvider;
  }
  judge.model = stringField(raw, "model", '"judge.model"') ?? judge.model;
  judge.apiKeyEnv = stringField(raw, "apiKeyEnv", '"judge.apiKeyEnv"') ?? judge.apiKeyEnv;
  judge.baseUrl = stringField(raw, "baseUrl", '"judge.baseUrl"') ?? judge.baseUrl;
  judge.structuredOutputs =
    booleanField(raw, "structuredOutputs", '"judge.structuredOutputs"') ?? judge.structuredOutputs;
  judge.maxContextKb =
    positiveNumber(raw, "maxContextKb", '"judge.maxContextKb"') ?? judge.maxContextKb;
}

/** Checks a parsed config, filling in defaults for anything absent. */
export function validate(value: unknown): Config {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`expected a JSON object, found ${describe(value)}`);
  }
  const raw = value as Record<string, unknown>;
  checkKeys(raw, TOP_KEYS, "");
  const config = defaults();

  config.baseBranch = stringField(raw, "baseBranch", '"baseBranch"') ?? config.baseBranch;
  config.testCommand = stringField(raw, "testCommand", '"testCommand"') ?? config.testCommand;
  // Absent in configs written before it existed; those keep loading as "no setup".
  config.setupCommand = stringField(raw, "setupCommand", '"setupCommand"') ?? config.setupCommand;
  if (config.baseBranch.trim() === "") fail('"baseBranch" must not be empty');

  if (raw["agent"] !== undefined) validateAgent(raw["agent"], config.agent);

  if (raw["harness"] !== undefined) {
    const harness = object(raw["harness"], '"harness"');
    checkKeys(harness, HARNESS_KEYS, "harness.");
    config.harness.extraPaths =
      stringArray(harness, "extraPaths", '"harness.extraPaths"') ?? config.harness.extraPaths;
  }

  // Both absent in configs written before judges existed; those load with the defaults.
  if (raw["judge"] !== undefined) validateJudge(raw["judge"], config.judge);
  config.judges = stringArray(raw, "judges", '"judges"') ?? config.judges;

  return config;
}

/** The config on disk, or null when there is none. Throws CliError when it is unusable. */
export function load(root: string): Config | null {
  const path = configPath(root);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`is not valid JSON (${(error as Error).message})`);
  }
  return validate(parsed);
}

/** The op that would save this config. Writing is plan.apply()'s job. */
export function saveOp(root: string, config: Config): FileOp {
  return {
    kind: "write",
    path: configPath(root),
    content: `${JSON.stringify(config, null, 2)}\n`,
  };
}
