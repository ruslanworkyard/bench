import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  CONFIG_FILE,
  FIXTURES_DIR,
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
import { testCommand } from "../detect/test-command.js";
import type { Detection } from "../detect/types.js";
import { copyOps, listFixtures, packagedFixturesDir } from "../fixtures.js";
import { apply, type FileOp } from "../plan.js";
import { requireGit, requireRepo } from "../preflight.js";
import { formatJson, formatSummary, type FileReport, type Report } from "../print.js";

export type InitOptions = {
  cwd: string;
  base?: string | undefined;
  test?: string | undefined;
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

function display(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function init(options: InitOptions): void {
  requireGit();
  const root = requireRepo(options.cwd);

  // Detect. A missing base branch or agent is a warning: init must work without them.
  const harness = harnessFiles(root);
  const agents = agentsOnPath();
  const detectedAgent: Detection<string> | null =
    agents === null || agents.value[0] === undefined
      ? null
      : { value: agents.value[0], source: agents.source };

  const test = override(options.test, "--test", testCommand(root));
  const agent = override(options.agent, "--agent", detectedAgent);
  const base = override(options.base, "--base", baseBranch(root));

  const existing = load(root); // Throws CliError when a config is present but unusable.
  const config: Config = {
    ...defaults(),
    ...(base === null ? {} : { baseBranch: base.value }),
    testCommand: test?.value ?? "",
    agent: agent?.value ?? "",
  };

  // Plan.
  const core: FileOp[] = [
    { kind: "mkdir", path: join(root, STATE_DIR) },
    { kind: "mkdir", path: join(root, FIXTURES_DIR) },
    saveOp(root, config),
    { kind: "appendLine", path: join(root, ".gitignore"), line: `${RUNS_DIR}/` },
  ];

  const added: string[] = [];
  const present: string[] = [];
  const fixtureOps: FileOp[] = [];
  for (const fixture of listFixtures(packagedFixturesDir())) {
    const target = join(root, FIXTURES_DIR, fixture.id);
    if (existsSync(target)) {
      present.push(fixture.id);
      continue;
    }
    added.push(fixture.id);
    fixtureOps.push(...copyOps(fixture.dir, target));
  }

  // Apply.
  const applied = apply([...core, ...fixtureOps], { dryRun: options.dryRun });
  const files: FileReport[] = applied
    .slice(0, core.length)
    .map(({ op, status }) => ({ path: display(root, op.path), status }));

  // Print.
  const warnings: string[] = [];
  if (test === null && (existing === null || existing.testCommand === "")) {
    warnings.push(`no test command detected - set "testCommand" in ${CONFIG_FILE}`);
  }
  if (agent === null && (existing === null || existing.agent === "")) {
    warnings.push(`no agent found on PATH - install one, or set "agent" in ${CONFIG_FILE}`);
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
    agent,
    agentsOnPath: agents?.value ?? [],
    baseBranch: base,
    fixtures: { added, present },
    files,
    warnings,
    next: NEXT_COMMAND,
  };

  console.log(options.json ? formatJson(report) : formatSummary(report));
}
