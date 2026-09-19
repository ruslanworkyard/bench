import { git } from "../detect/git.js";
import { dirtyHarnessFiles, harnessFiles } from "../detect/harness.js";
import {
  requireAgent,
  requireBaseBranch,
  requireConfig,
  requireFixture,
  requireGit,
  requireRepo,
} from "../preflight.js";
import { formatRunPlan, type RunPlan } from "../print.js";

export type RunOptions = {
  cwd: string;
  fixtureId: string;
  base?: string | undefined;
  agent?: string | undefined;
};

/** For now: preflight only. It proves the run is possible, then says what it would do. */
export function run(options: RunOptions): void {
  requireGit();
  const root = requireRepo(options.cwd);
  const config = requireConfig(root);

  const baseBranch = options.base ?? config.baseBranch;
  const baseSha = requireBaseBranch(root, baseBranch);
  const agent = options.agent ?? config.agent;
  const agentPath = requireAgent(agent);
  const { fixture } = requireFixture(root, options.fixtureId);

  const harness = [
    ...new Set([
      ...harnessFiles(root).map((entry) => entry.path),
      ...config.harness.extraPaths,
    ]),
  ];
  const dirty = dirtyHarnessFiles(root, harness);

  const plan: RunPlan = {
    root,
    // requireBaseBranch has already proved this repository has commits.
    head: git(["rev-parse", "HEAD"], root) ?? "",
    baseBranch,
    baseSha,
    agent,
    agentPath,
    fixture,
    dirtyHarness: dirty,
  };
  console.log(formatRunPlan(plan));
}
