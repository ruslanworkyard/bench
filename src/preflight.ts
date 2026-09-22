import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { getAdapter } from "./agents/index.js";
import type { AgentAdapter } from "./agents/types.js";
import {
  CONFIG_FILE,
  ENV_FILE,
  FIXTURES_DIR,
  JUDGES_DIR,
  JUDGE_PROVIDERS,
  load,
  type AgentConfig,
  type Config,
  type JudgeConfig,
  type JudgeProvider,
} from "./config.js";
import { agentPath, isExecutable } from "./detect/agents.js";
import { git, mergeBase, repoRoot } from "./detect/git.js";
import { harnessSnapshot, type HarnessSnapshot } from "./detect/harness.js";
import { CliError } from "./errors.js";
import { listFixtures, validateFixture, type FixtureMeta } from "./fixtures.js";
import type { LoadedJudge } from "./judges.js";

/**
 * The checks every command that actually runs something shares. Each one either
 * returns what it found or throws CliError; none of them print, exit, or write.
 */

/** A fixture as it exists in the host repository. */
export type LoadedFixture = { dir: string; fixture: FixtureMeta; prompt: string };

export function requireGit(): void {
  if (git(["--version"], process.cwd()) === null) {
    throw new CliError("git is required on PATH", 1);
  }
}

export function requireRepo(cwd: string): string {
  const root = repoRoot(cwd);
  if (root === null) {
    throw new CliError("run harnessbench from inside a git repository", 1);
  }
  return root;
}

export function requireConfig(root: string): Config {
  const config = load(root); // Throws CliError when the config is present but unusable.
  if (config === null) {
    throw new CliError(`no ${CONFIG_FILE} — run \`harnessbench init\` first`, 1);
  }
  return config;
}

export function requireBaseBranch(root: string, branch: string): string {
  const sha = git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], root);
  if (sha === null || sha === "") {
    throw new CliError(
      `base branch '${branch}' not found. Fetch it or set --base ` +
        `(or baseBranch in ${CONFIG_FILE})`,
      1,
    );
  }
  return sha;
}

/** The commit whose harness is `previous`: where the base branch and HEAD last agreed. */
export function requireMergeBase(root: string, branch: string): string {
  const sha = mergeBase(root, branch);
  if (sha === null) {
    throw new CliError(
      `no merge base between '${branch}' and HEAD - fetch the full history ` +
        `(git fetch --unshallow) or set --base to a branch this one was cut from`,
      1,
    );
  }
  return sha;
}

/** The harness as committed at `ref`; `ref` has already been checked to be a commit. */
export function requireHarnessSnapshot(
  root: string,
  ref: string,
  extraPaths: readonly string[],
): HarnessSnapshot {
  const snapshot = harnessSnapshot(root, ref, extraPaths);
  if (snapshot === null) {
    throw new CliError(`'${ref}' is not a commit in this repository`, 1);
  }
  return snapshot;
}

export function requireAgent(name: string): AgentAdapter {
  if (name.trim() === "") {
    throw new CliError(`no agent set - set "agent.name" in ${CONFIG_FILE}, or pass --agent`, 1);
  }
  return getAdapter(name); // Throws CliError listing the agents that do exist.
}

/** Where the agent's binary is. `agent.command` wins; an empty one means the adapter's own. */
export function requireAgentCommand(
  adapter: AgentAdapter,
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const command = config.command === "" ? adapter.defaultCommand : config.command;
  // A path is taken as it is; only a bare name is looked up.
  const path = command.includes(sep) ? (isExecutable(command) ? command : null) : agentPath(command, env);
  if (path === null) {
    const where = command.includes(sep) ? "" : " on PATH";
    throw new CliError(
      `agent command '${command}' not found${where} - install ${adapter.name}, ` +
        `or set "agent.command" in ${CONFIG_FILE}`,
      1,
    );
  }
  return path;
}

/** Where a credential may be set: the shell, or the file cli.ts has already read into it. */
const WHERE_TO_SET = `in your environment or in ${ENV_FILE}`;

/** Credentials stay in the environment: harnessbench never reads, stores or prints them. */
export function requireCredentials(
  adapter: AgentAdapter,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const set = adapter.credentialEnv.some((name) => (env[name] ?? "") !== "");
  if (!set) {
    throw new CliError(
      `no credentials for ${adapter.name}: set one of ${adapter.credentialEnv.join(", ")} ${WHERE_TO_SET}`,
      1,
    );
  }
}

export function requireFixture(root: string, id: string): LoadedFixture {
  const dir = join(root, FIXTURES_DIR, id);
  const metaPath = join(dir, "fixture.json");
  if (!existsSync(metaPath)) {
    const ids = listFixtures(join(root, FIXTURES_DIR)).map((fixture) => fixture.id);
    const available =
      ids.length === 0
        ? `no fixtures in ${FIXTURES_DIR} - run \`harnessbench init\` first`
        : `available fixtures:\n${ids.map((each) => `  ${each}`).join("\n")}`;
    throw new CliError(`unknown fixture '${id}'\n\n${available}`, 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (error) {
    throw new CliError(
      `${FIXTURES_DIR}/${id}/fixture.json is not valid JSON (${(error as Error).message})`,
    );
  }
  const fixture = validateFixture(parsed, `${FIXTURES_DIR}/${id}/fixture.json`);

  const promptPath = join(dir, "prompt.md");
  if (!existsSync(promptPath)) {
    throw new CliError(`fixture '${id}' has no prompt.md`, 1);
  }
  return { dir, fixture, prompt: readFileSync(promptPath, "utf8") };
}

/** Environment overrides for every judge at once; they beat judge.json, which beats the config. */
export const JUDGE_PROVIDER_ENV = "HARNESSBENCH_JUDGE_PROVIDER";
export const JUDGE_MODEL_ENV = "HARNESSBENCH_JUDGE_MODEL";

/** Where each provider looks for its key when the config names no variable. */
const CONVENTIONAL_KEY_ENV: Record<JudgeProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

/** The variable a judge's key is read from when its judge.json names none; init lists it. */
export function judgeKeyEnv(config: JudgeConfig, provider: JudgeProvider = config.provider): string {
  return config.apiKeyEnv || CONVENTIONAL_KEY_ENV[provider];
}

/** Everything `judge/provider.ts` needs to build a model, with every override applied. */
export type ResolvedJudge = {
  provider: JudgeProvider;
  model: string;
  /** The variable the key is read from at call time. Only its name lives here. */
  apiKeyEnv: string;
  baseUrl: string;
};

/**
 * Provider, model and key variable for one judge: environment > judge.json > config, then
 * the provider's conventional variable for a key nobody named. A judge with no model after
 * all that cannot run, and the error says where to set one.
 */
export function requireJudgeModel(
  judge: LoadedJudge,
  config: JudgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedJudge {
  const id = judge.meta.id;
  const judgeFile = `${JUDGES_DIR}/${id}/judge.json`;

  const providerName = env[JUDGE_PROVIDER_ENV] || judge.meta.provider || config.provider;
  if (!(JUDGE_PROVIDERS as readonly string[]).includes(providerName)) {
    throw new CliError(
      `${JUDGE_PROVIDER_ENV} is '${providerName}'; judge providers are ${JUDGE_PROVIDERS.join(", ")}`,
      1,
    );
  }
  const provider = providerName as JudgeProvider;

  const model = env[JUDGE_MODEL_ENV] || judge.meta.model || config.model;
  if (model === "") {
    throw new CliError(
      `judge '${id}' has no model: set "judge.model" in ${CONFIG_FILE}, "model" in ${judgeFile}, ` +
        `or ${JUDGE_MODEL_ENV}`,
      1,
    );
  }

  if (provider === "openai-compatible" && config.baseUrl === "") {
    throw new CliError(
      `judge '${id}' uses the openai-compatible provider, which needs "judge.baseUrl" in ${CONFIG_FILE}`,
      1,
    );
  }

  const apiKeyEnv = judge.meta.apiKeyEnv || judgeKeyEnv(config, provider);
  return { provider, model, apiKeyEnv, baseUrl: config.baseUrl };
}

/** The key stays in the environment: this checks only that the variable is set. */
export function requireJudgeKey(
  judge: LoadedJudge,
  resolved: ResolvedJudge,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if ((env[resolved.apiKeyEnv] ?? "") !== "") return;
  throw new CliError(
    `no API key for judge '${judge.meta.id}' (${resolved.provider}): set ${resolved.apiKeyEnv} ` +
      `${WHERE_TO_SET}, or name another variable in "judge.apiKeyEnv" in ${CONFIG_FILE}`,
    1,
  );
}
