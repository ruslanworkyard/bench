import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAdapter } from "./agents/index.js";
import type { AgentAdapter } from "./agents/types.js";
import { CONFIG_FILE, FIXTURES_DIR, load, type AgentConfig, type Config } from "./config.js";
import { agentPath } from "./detect/agents.js";
import { git, repoRoot } from "./detect/git.js";
import { CliError } from "./errors.js";
import { listFixtures, validateFixture, type FixtureMeta } from "./fixtures.js";

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
  const path = agentPath(command, env);
  if (path === null) {
    throw new CliError(
      `agent command '${command}' not found on PATH - install ${adapter.name}, ` +
        `or set "agent.command" in ${CONFIG_FILE}`,
      1,
    );
  }
  return path;
}

/** Credentials stay in the environment: harnessbench never reads, stores or prints them. */
export function requireCredentials(
  adapter: AgentAdapter,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const set = adapter.credentialEnv.some((name) => (env[name] ?? "") !== "");
  if (!set) {
    throw new CliError(
      `no credentials for ${adapter.name}: set one of ${adapter.credentialEnv.join(", ")}`,
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
