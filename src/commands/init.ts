import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { adapterForCommand, adapterNames, getAdapter } from "../agents/index.js";
import type { AgentAdapter } from "../agents/types.js";
import {
  CONFIG_FILE,
  ENV_EXAMPLE_FILE,
  ENV_FILE,
  FIXTURES_DIR,
  JUDGES_DIR,
  RUNS_DIR,
  STATE_DIR,
  defaults,
  load,
  saveOp,
  type Config,
} from "../config.js";
import { agentsOnPath } from "../detect/agents.js";
import { baseBranch } from "../detect/git.js";
import { harnessFiles } from "../detect/harness.js";
import { setupCommand } from "../detect/setup-command.js";
import { testCommand } from "../detect/test-command.js";
import type { Detection } from "../detect/types.js";
import { copyOps, listFixtures, packagedFixturesDir } from "../fixtures.js";
import { packagedJudgesDir } from "../judges.js";
import { apply, type FileOp } from "../plan.js";
import { judgeKeyEnv, requireGit, requireRepo } from "../preflight.js";
import { formatJson, formatSummary, type FileReport, type Report } from "../print.js";

export type InitOptions = {
  cwd: string;
  base?: string | undefined;
  test?: string | undefined;
  setup?: string | undefined;
  agent?: string | undefined;
  dryRun: boolean;
  json: boolean;
};

const NEXT_COMMAND = "harnessbench run";

/** A flag wins over detection, and says so. */
function override<T extends string>(
  flag: T | undefined,
  flagName: string,
  detected: Detection<T> | null,
): Detection<T> | null {
  if (flag !== undefined) return { value: flag, source: `${flagName} flag` };
  return detected;
}

/** The first agent on PATH that we have an adapter for; its adapter name is what config uses. */
function detectAgent(agents: Detection<string[]> | null): Detection<string> | null {
  for (const command of agents?.value ?? []) {
    const adapter = adapterForCommand(command);
    if (adapter !== null) return { value: adapter.name, source: agents?.source ?? "PATH" };
  }
  return null;
}

function display(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** One line per credential variable, for .env.example. A name not listed gets a generic one. */
const CREDENTIAL_NOTES: Record<string, string> = {
  ANTHROPIC_API_KEY: "Anthropic API key: for Claude Code, and for judges on the anthropic provider",
  ANTHROPIC_AUTH_TOKEN: "Bearer token for an Anthropic-compatible gateway, in place of an API key",
  CLAUDE_CODE_OAUTH_TOKEN: "Claude subscription token from `claude setup-token`, in place of an API key",
  CLAUDE_CODE_USE_BEDROCK: "Set to 1 to reach Claude through AWS Bedrock; AWS credentials come from your environment",
  CLAUDE_CODE_USE_VERTEX: "Set to 1 to reach Claude through Google Vertex AI",
  OPENAI_API_KEY: "OpenAI API key: for judges on the openai and openai-compatible providers",
  GOOGLE_GENERATIVE_AI_API_KEY: "Google AI API key: for judges on the google provider",
};

/**
 * The variables the configured agent and judge could use, every one commented out, so the
 * file tracks the config without ever holding a value. Never overwritten once it exists.
 */
function envExample(adapter: AgentAdapter | null, judgeKey: string): string {
  const notes = new Map<string, string>();
  for (const name of adapter?.credentialEnv ?? []) {
    notes.set(name, CREDENTIAL_NOTES[name] ?? `Credential for the ${adapter?.name} agent`);
  }
  if (!notes.has("CLAUDE_CODE_OAUTH_TOKEN")) {
    notes.set("CLAUDE_CODE_OAUTH_TOKEN", CREDENTIAL_NOTES["CLAUDE_CODE_OAUTH_TOKEN"] as string);
  }
  if (!notes.has(judgeKey)) {
    notes.set(judgeKey, CREDENTIAL_NOTES[judgeKey] ?? `API key for the judge ("judge.apiKeyEnv" in ${CONFIG_FILE})`);
  }
  const lines = [
    `# Credentials harnessbench could use, from the agent and judge in ${CONFIG_FILE}.`,
    `# Copy this file to ${ENV_FILE} (gitignored), uncomment what you use, and fill in the values.`,
    "# A variable already set in your shell wins over the file.",
  ];
  for (const [name, note] of notes) lines.push("", `# ${note}`, `# ${name}=`);
  return `${lines.join("\n")}\n`;
}

type Catalogue = { added: string[]; present: string[]; ops: FileOp[] };

/**
 * Ops that copy every packaged directory under `from` into `to`, skipping ids the host already
 * has: a fixture or judge the user edited is theirs. Fixtures and judges share this shape.
 */
function copyCatalogue(from: string, to: string): Catalogue {
  const catalogue: Catalogue = { added: [], present: [], ops: [] };
  for (const entry of listFixtures(from)) {
    const target = join(to, entry.id);
    if (existsSync(target)) {
      catalogue.present.push(entry.id);
      continue;
    }
    catalogue.added.push(entry.id);
    catalogue.ops.push(...copyOps(entry.dir, target));
  }
  return catalogue;
}

export function init(options: InitOptions): void {
  requireGit();
  const root = requireRepo(options.cwd);

  // Detect. A missing base branch or agent is a warning: init must work without them.
  const harness = harnessFiles(root);
  const agents = agentsOnPath();

  const test = override(options.test, "--test", testCommand(root));
  const setup = override(options.setup, "--setup", setupCommand(root));
  const agent = override(options.agent, "--agent", detectAgent(agents));
  const base = override(options.base, "--base", baseBranch(root));

  // An explicit --agent is checked here, so init never writes a config that cannot run.
  const adapter = agent === null ? null : getAdapter(agent.value);

  const existing = load(root); // Throws CliError when a config is present but unusable.
  const config: Config = {
    ...defaults(),
    ...(base === null ? {} : { baseBranch: base.value }),
    testCommand: test?.value ?? "",
    setupCommand: setup?.value ?? "",
    agent: {
      ...defaults().agent,
      name: adapter?.name ?? "",
      command: adapter?.defaultCommand ?? "",
    },
  };

  // The config that will be in effect: an existing one is kept, so .env.example follows it.
  const effective = existing ?? config;
  const effectiveAdapter =
    adapter ?? (adapterNames().includes(effective.agent.name) ? getAdapter(effective.agent.name) : null);

  // Plan.
  const core: FileOp[] = [
    { kind: "mkdir", path: join(root, STATE_DIR) },
    { kind: "mkdir", path: join(root, FIXTURES_DIR) },
    { kind: "mkdir", path: join(root, JUDGES_DIR) },
    saveOp(root, config),
    {
      kind: "write",
      path: join(root, ENV_EXAMPLE_FILE),
      content: envExample(effectiveAdapter, judgeKeyEnv(effective.judge)),
    },
    { kind: "appendLines", path: join(root, ".gitignore"), lines: [`${RUNS_DIR}/`, ENV_FILE] },
  ];

  const fixtures = copyCatalogue(packagedFixturesDir(), join(root, FIXTURES_DIR));
  const judges = copyCatalogue(packagedJudgesDir(), join(root, JUDGES_DIR));

  // Apply.
  const applied = apply([...core, ...fixtures.ops, ...judges.ops], { dryRun: options.dryRun });
  const files: FileReport[] = applied
    .slice(0, core.length)
    .map(({ op, status }) => ({ path: display(root, op.path), status }));

  // Print.
  const warnings: string[] = [];
  if (test === null && (existing === null || existing.testCommand === "")) {
    warnings.push(`no test command detected - set "testCommand" in ${CONFIG_FILE}`);
  }
  if (agent === null && (existing === null || existing.agent.name === "")) {
    warnings.push(`no agent found on PATH - install one, or set "agent.name" in ${CONFIG_FILE}`);
  }
  if (base === null) {
    warnings.push(
      `no base branch detected - using "${config.baseBranch}"; set "baseBranch" in ${CONFIG_FILE}`,
    );
  }

  const report: Report = {
    root,
    dryRun: options.dryRun,
    harness,
    testCommand: test,
    setupCommand: setup,
    agent,
    agentsOnPath: agents?.value ?? [],
    baseBranch: base,
    fixtures: { added: fixtures.added, present: fixtures.present },
    judges: { added: judges.added, present: judges.present },
    files,
    warnings,
    next: NEXT_COMMAND,
  };

  console.log(options.json ? formatJson(report) : formatSummary(report));
}
