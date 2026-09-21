import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { adapterForCommand, getAdapter } from "../agents/index.js";
import {
  CONFIG_FILE,
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
import { requireGit, requireRepo } from "../preflight.js";
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

  // Plan.
  const core: FileOp[] = [
    { kind: "mkdir", path: join(root, STATE_DIR) },
    { kind: "mkdir", path: join(root, FIXTURES_DIR) },
    { kind: "mkdir", path: join(root, JUDGES_DIR) },
    saveOp(root, config),
    { kind: "appendLine", path: join(root, ".gitignore"), line: `${RUNS_DIR}/` },
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
