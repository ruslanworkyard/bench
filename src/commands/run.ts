import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentAdapter, AgentResult } from "../agents/types.js";
import { compare } from "../compare.js";
import { RUNS_DIR, type AgentConfig } from "../config.js";
import { dirtyHarnessFiles, harnessFiles, type HarnessSnapshot } from "../detect/harness.js";
import {
  requireAgent,
  requireAgentCommand,
  requireBaseBranch,
  requireConfig,
  requireCredentials,
  requireFixture,
  requireGit,
  requireHarnessSnapshot,
  requireMergeBase,
  requireRepo,
  type LoadedFixture,
} from "../preflight.js";
import { formatComparison, formatDirtyHarness, formatRun, formatSameHarness } from "../print.js";
import {
  ENVIRONMENTS,
  writeRunRecord,
  type Environment,
  type RunRecord,
  type TestResult,
} from "../run-record.js";
import { withWorkspace, type Workspace } from "../workspace.js";

export type RunOptions = {
  cwd: string;
  fixtureId: string;
  base?: string | undefined;
  agent?: string | undefined;
  /** Override config.agent.maxTurns / config.agent.model for this run only. */
  maxTurns?: number | undefined;
  model?: string | undefined;
  keep: boolean;
  json: boolean;
};

/** A test suite that has not finished in this long is not going to. */
const TEST_TIMEOUT_MS = 10 * 60_000;

/** Everything one side of a run needs that the other side shares. */
type Side = {
  root: string;
  runId: string;
  environment: Environment;
  /** The harness this side runs with; `head` is what the clone starts out with. */
  harness: HarnessSnapshot;
  head: HarnessSnapshot;
  baseBranch: string;
  fixture: LoadedFixture;
  adapter: AgentAdapter;
  agentConfig: AgentConfig;
  agentPath: string;
  testCommand: string;
  keep: boolean;
};

/**
 * Runs one fixture twice on the code at HEAD: with the harness at the merge base with the
 * base branch (`previous`), then with the harness at HEAD (`candidate`). Each side gets its
 * own workspace and run directory; both are recorded and summarised, in that order, and
 * the comparison of the two comes last.
 */
export async function run(options: RunOptions): Promise<RunRecord[]> {
  requireGit();
  const root = requireRepo(options.cwd);
  const config = requireConfig(root);

  const baseBranch = options.base ?? config.baseBranch;
  requireBaseBranch(root, baseBranch);
  const mergeBase = requireMergeBase(root, baseBranch);
  const agentConfig = {
    ...config.agent,
    name: options.agent ?? config.agent.name,
    maxTurns: options.maxTurns ?? config.agent.maxTurns,
    model: options.model ?? config.agent.model,
  };
  const adapter = requireAgent(agentConfig.name);
  const agentPath = requireAgentCommand(adapter, agentConfig);
  requireCredentials(adapter);
  const fixture = requireFixture(root, options.fixtureId);

  const head = requireHarnessSnapshot(root, "HEAD", config.harness.extraPaths);
  const previous = requireHarnessSnapshot(root, mergeBase, config.harness.extraPaths);

  // The working tree, not HEAD: an untracked new harness file is exactly what to warn about.
  const onDisk = [
    ...new Set([...harnessFiles(root).map((entry) => entry.path), ...config.harness.extraPaths]),
  ];
  const dirty = dirtyHarnessFiles(root, onDisk);
  if (dirty.length > 0) console.error(formatDirtyHarness(dirty));
  if (head.hash === previous.hash) console.error(formatSameHarness(mergeBase));

  // One timestamp for both sides, so the two run ids differ only in their environment.
  const stamp = timestamp(new Date());
  const shared = {
    root,
    head,
    baseBranch,
    fixture,
    adapter,
    agentConfig,
    agentPath,
    testCommand: config.testCommand,
    keep: options.keep,
  };
  const records: RunRecord[] = [];
  const summaries: string[] = [];
  for (const environment of ENVIRONMENTS) {
    const runId = `${stamp}-${fixture.fixture.id}-${environment}`;
    const harness = environment === "previous" ? previous : head;
    const { record, stderrPath } = await runSide({ ...shared, runId, environment, harness });
    records.push(record);
    summaries.push(formatRun(record, stderrPath));
  }

  const comparison = compare(...(records as [RunRecord, RunRecord]));
  if (options.json) console.log(JSON.stringify([...records, comparison], null, 2));
  else console.log([...summaries, formatComparison(comparison)].join("\n\n"));
  return records;
}

/** One environment: its workspace, the agent, the diff, the tests, and its run directory. */
async function runSide(side: Side): Promise<{ record: RunRecord; stderrPath: string }> {
  const runDir = join(side.root, RUNS_DIR, side.runId);
  // Before the agent starts, so a crash mid-run still leaves the raw stream behind.
  mkdirSync(runDir, { recursive: true });
  const stderrPath = join(runDir, "agent.stderr.log");

  const record = await withWorkspace(
    { repoRoot: side.root, ref: "HEAD", runId: side.runId, keep: side.keep },
    async (ws) => {
      if (side.environment === "previous") {
        await ws.overlayHarness(side.root, side.head, side.harness);
        await ws.rebaseline();
      }

      const startedAt = new Date();
      const result = await side.adapter.run({
        workspace: ws,
        prompt: side.fixture.prompt,
        config: side.agentConfig,
        rawOutputPath: join(runDir, "raw.jsonl"),
        stderrPath,
      });

      const diff = await ws.diff();
      writeFileSync(join(runDir, "diff.patch"), diff, "utf8");

      const tests =
        side.testCommand === "" ? null : await runTests(ws, side.testCommand, join(runDir, "test.log"));

      const transcript = result.transcript.map((event) => JSON.stringify(event));
      writeFileSync(
        join(runDir, "transcript.jsonl"),
        transcript.length === 0 ? "" : `${transcript.join("\n")}\n`,
        "utf8",
      );

      const finished: RunRecord = {
        schema: 2,
        runId: side.runId,
        fixture: side.fixture.fixture.id,
        environment: side.environment,
        headSha: ws.headSha,
        baseBranch: side.baseBranch,
        harness: side.harness,
        agent: { name: side.adapter.name, command: side.agentPath, model: result.model },
        outcome: result.outcome,
        exitCode: result.exitCode,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        ...telemetry(result),
        diff: summariseDiff(diff),
        tests,
        finalMessage: result.finalMessage,
      };
      writeRunRecord(runDir, finished);
      return finished;
    },
  );
  return { record, stderrPath };
}

function telemetry(result: AgentResult) {
  const { tokens, costUsd, durationMs, turns, toolCalls, toolFailures } = result;
  return { tokens, costUsd, durationMs, turns, toolCalls, toolFailures };
}

/** `YYYYMMDD-HHMMSS`, UTC, so run ids sort by time wherever they are read. */
function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Runs the suite in the workspace, keeping its output as `logPath`. */
async function runTests(ws: Workspace, command: string, logPath: string): Promise<TestResult> {
  const log = createWriteStream(logPath);
  const write = (chunk: string): void => {
    log.write(chunk);
  };
  const result = await ws.exec(command, {
    timeoutMs: TEST_TIMEOUT_MS,
    onStdout: write,
    onStderr: write,
  });
  await new Promise<void>((resolve, reject) => {
    log.on("error", reject);
    log.end(resolve);
  });
  return {
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}

/** Files touched and lines added and removed, by counting the patch's own markers. */
function summariseDiff(diff: string): RunRecord["diff"] {
  const summary = { files: 0, added: 0, removed: 0 };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) summary.files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) summary.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) summary.removed++;
  }
  return summary;
}
