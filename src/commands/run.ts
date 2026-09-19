import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentResult } from "../agents/types.js";
import { RUNS_DIR } from "../config.js";
import { dirtyHarnessFiles, harnessFiles } from "../detect/harness.js";
import {
  requireAgent,
  requireAgentCommand,
  requireBaseBranch,
  requireConfig,
  requireCredentials,
  requireFixture,
  requireGit,
  requireRepo,
} from "../preflight.js";
import { formatDirtyHarness, formatRun } from "../print.js";
import { writeRunRecord, type RunRecord, type TestResult } from "../run-record.js";
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

/** The only environment there is until `previous` arrives; the run id carries it already. */
const ENVIRONMENT = "candidate";

/** A test suite that has not finished in this long is not going to. */
const TEST_TIMEOUT_MS = 10 * 60_000;

/** Runs one fixture against the current HEAD, records everything, prints a summary. */
export async function run(options: RunOptions): Promise<RunRecord> {
  requireGit();
  const root = requireRepo(options.cwd);
  const config = requireConfig(root);

  const baseBranch = options.base ?? config.baseBranch;
  requireBaseBranch(root, baseBranch);
  const agentConfig = {
    ...config.agent,
    name: options.agent ?? config.agent.name,
    maxTurns: options.maxTurns ?? config.agent.maxTurns,
    model: options.model ?? config.agent.model,
  };
  const adapter = requireAgent(agentConfig.name);
  const agentPath = requireAgentCommand(adapter, agentConfig);
  requireCredentials(adapter);
  const { fixture, prompt } = requireFixture(root, options.fixtureId);

  const harness = [
    ...new Set([
      ...harnessFiles(root).map((entry) => entry.path),
      ...config.harness.extraPaths,
    ]),
  ];
  const dirty = dirtyHarnessFiles(root, harness);
  if (dirty.length > 0) console.error(formatDirtyHarness(dirty));

  const runId = `${timestamp(new Date())}-${fixture.id}-${ENVIRONMENT}`;
  const runDir = join(root, RUNS_DIR, runId);
  // Before the agent starts, so a crash mid-run still leaves the raw stream behind.
  mkdirSync(runDir, { recursive: true });
  const stderrPath = join(runDir, "agent.stderr.log");

  const record = await withWorkspace(
    { repoRoot: root, ref: "HEAD", runId, keep: options.keep },
    async (ws) => {
      const startedAt = new Date();
      const result = await adapter.run({
        workspace: ws,
        prompt,
        config: agentConfig,
        rawOutputPath: join(runDir, "raw.jsonl"),
        stderrPath,
      });

      const diff = await ws.diff();
      writeFileSync(join(runDir, "diff.patch"), diff, "utf8");

      const tests =
        config.testCommand === ""
          ? null
          : await runTests(ws, config.testCommand, join(runDir, "test.log"));

      const transcript = result.transcript.map((event) => JSON.stringify(event));
      writeFileSync(
        join(runDir, "transcript.jsonl"),
        transcript.length === 0 ? "" : `${transcript.join("\n")}\n`,
        "utf8",
      );

      const finished: RunRecord = {
        schema: 1,
        runId,
        fixture: fixture.id,
        environment: ENVIRONMENT,
        headSha: ws.headSha,
        baseBranch,
        agent: { name: adapter.name, command: agentPath, model: result.model },
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

  if (options.json) console.log(JSON.stringify(record, null, 2));
  else console.log(formatRun(record, stderrPath));
  return record;
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
