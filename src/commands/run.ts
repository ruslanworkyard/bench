import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentAdapter, AgentResult } from "../agents/types.js";
import { compare, rollup, type Comparison, type JudgeInput, type Rollup } from "../compare.js";
import { FIXTURES_DIR, RUNS_DIR, type AgentConfig } from "../config.js";
import { dirtyHarnessFiles, harnessFiles, type HarnessSnapshot } from "../detect/harness.js";
import { CliError } from "../errors.js";
import { EventBus, emitter, recorder, type Emit, type SideRef } from "../events.js";
import { selectFixtures } from "../fixtures.js";
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
import { formatDirtyHarness, formatProgressText } from "../print.js";
import { plainRenderer } from "../render/plain.js";
import { buildReport } from "../report.js";
import {
  ENVIRONMENTS,
  EVENTS_FILE,
  reportDir,
  runStamp,
  writeRunRecord,
  type CommandResult,
  type Environment,
  type RunOutcome,
  type RunRecord,
  type TestResult,
} from "../run-record.js";
import { telemetry } from "../telemetry.js";
import { expandTestCommand, selectTests } from "../test-selection.js";
import { withWorkspace, type Workspace } from "../workspace.js";
import { loadJudgement, printReport, saveReport, type ReportOutput } from "./compare.js";
import { defaultDeps, judgePair, type JudgeDeps } from "./judge.js";

export type RunOptions = ReportOutput & {
  cwd: string;
  /** Fixture ids to run; none means every fixture (or every fixture carrying one of `tags`). */
  fixtureIds: string[];
  /** Fixtures carrying any of these tags; with `fixtureIds`, the intersection. */
  tags: string[];
  /** Sides in flight at once; unlimited when absent. */
  concurrency?: number | undefined;
  base?: string | undefined;
  agent?: string | undefined;
  /** Override config.agent.maxTurns / config.agent.model for this run only. */
  maxTurns?: number | undefined;
  model?: string | undefined;
  keep: boolean;
  /** Run the configured judges on each pair as soon as its two sides are in. */
  judge: boolean;
};

/** One fixture's outcome in a batch: its records, its table, and what went wrong if anything. */
export type RunFixtureResult = {
  fixture: string;
  /** The sides that finished, previous first. */
  records: RunRecord[];
  comparison: Comparison | null;
  error: string | null;
};

/** What `run` returns and `--json` prints. */
export type RunBatchResult = { stamp: string; fixtures: RunFixtureResult[]; rollup: Rollup };

/** A test suite, or a dependency install, that has not finished in this long is not going to. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const SETUP_LOG = "setup.log";

/** What the shell learns from a run: the agent's outcome, never the test suite's. */
export const RUN_EXIT_CODES: Record<RunOutcome, number> = { completed: 0, timeout: 2, error: 3, max_turns: 4 };

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
  setupCommand: string;
  testCommand: string;
  testFiles: string[];
  hidePaths: string[];
  keep: boolean;
  ref: SideRef;
  emit: Emit;
};

/**
 * Runs a set of fixtures on the code at HEAD, every side of every fixture at once under one
 * stamp: with the harness at the merge base with the base branch (`previous`) and with the
 * harness at HEAD (`candidate`). Each side gets its own workspace and run directory; while
 * they run, every moment is an event on a bus, rendered as progress lines on stderr and
 * recorded to the batch's `events.jsonl`. Each fixture is compared (and, with
 * --judge, judged) as soon as its two sides are in. At the end the batch's report is written
 * under `.harnessbench/runs/<stamp>/` and printed, fixtures in order.
 */
export async function run(options: RunOptions, deps: JudgeDeps = defaultDeps): Promise<RunBatchResult> {
  // One clock for every side's progress lines, started before any preflight.
  const invokedAt = Date.now();
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
  const fixtures = selectFixtures(join(root, FIXTURES_DIR), options.fixtureIds, options.tags).map((each) =>
    requireFixture(root, each.id),
  );

  const head = requireHarnessSnapshot(root, "HEAD", config.harness.extraPaths);
  const previous = requireHarnessSnapshot(root, mergeBase, config.harness.extraPaths);

  // The working tree, not HEAD: an untracked new harness file is exactly what to warn about.
  const onDisk = [
    ...new Set([...harnessFiles(root).map((entry) => entry.path), ...config.harness.extraPaths]),
  ];
  const dirty = dirtyHarnessFiles(root, onDisk);
  if (dirty.length > 0) console.error(formatDirtyHarness(dirty));

  // One timestamp for the whole batch, so every run id differs only in fixture and environment.
  const stamp = runStamp(new Date());
  const bus = new EventBus();
  bus.subscribe(plainRenderer());
  bus.subscribe(recorder(join(root, reportDir(stamp), EVENTS_FILE)));
  const emit = emitter(bus, invokedAt);
  emit({
    type: "batch.start",
    stamp,
    fixtures: fixtures.map((each) => each.fixture.id),
    harness: { previous: previous.sha, candidate: head.sha },
    sameHarness: head.hash === previous.hash,
    agent: { name: adapter.name, model: agentConfig.model },
  });
  const shared = {
    root,
    head,
    baseBranch,
    adapter,
    agentConfig,
    agentPath,
    setupCommand: config.setupCommand,
    testCommand: config.testCommand,
    testFiles: config.testFiles,
    hidePaths: config.workspace.hidePaths,
    keep: options.keep,
  };
  const start = limiter(options.concurrency);
  // Said once: a config the judges cannot be loaded for is the same for every fixture.
  const said = new Set<string>();
  const sayOnce = (message: string): void => {
    if (said.has(message)) return;
    said.add(message);
    console.error(message);
  };

  const outcomes = await Promise.all(
    fixtures.map(async (fixture): Promise<FixtureOutcome> => {
      const settled = await Promise.allSettled(
        ENVIRONMENTS.map((environment) => {
          const ref: SideRef = { fixture: fixture.fixture.id, environment };
          emit({ type: "side.phase", side: ref, phase: "queued" });
          return start(() =>
            runSide({
              ...shared,
              fixture,
              runId: `${stamp}-${fixture.fixture.id}-${environment}`,
              environment,
              harness: environment === "previous" ? previous : head,
              ref,
              emit,
            }),
          );
        }),
      );
      const outcome = settledSides(fixture.fixture.id, settled);
      if (outcome.sides.length !== 2) return outcome;

      // Judged as soon as this pair is in, whatever the other fixtures are doing. A refusal is
      // not a failure of the run: both records exist, so say why on stderr, for this fixture
      // only, and keep the exit code. The pair is new, so every configured judge runs.
      const pair = outcome.sides.map((side) => side.record) as [RunRecord, RunRecord];
      if (options.judge) {
        try {
          await judgePair(root, config, ...pair, deps, true, emit);
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          console.error(`${fixture.fixture.id}: judging skipped: ${oneLine(error.message)}`);
        }
      }
      // The table names the configured judges even without --judge; a config the judges cannot
      // be loaded for costs the rows, not the run.
      let judgement: JudgeInput | null = null;
      try {
        judgement = loadJudgement(root, config, ...pair);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        sayOnce(`judge rows skipped: ${oneLine(error.message)}`);
      }
      outcome.comparison = compare(...pair, judgement, config.testLabel);
      return outcome;
    }),
  );

  const result: RunBatchResult = {
    stamp,
    fixtures: outcomes.map(({ fixture, sides, comparison, error }) => ({
      fixture,
      records: sides.map((side) => side.record),
      comparison,
      error,
    })),
    rollup: rollup(outcomes.flatMap((each) => (each.comparison === null ? [] : [each.comparison]))),
  };
  const side = (sides: SideResult[], environment: Environment): RunRecord | null =>
    sides.find((each) => each.record.environment === environment)?.record ?? null;
  const report = buildReport(
    stamp,
    outcomes.map(({ fixture, sides, comparison, error }) => ({
      fixture,
      previous: side(sides, "previous"),
      candidate: side(sides, "candidate"),
      comparison,
      error,
    })),
    {
      headSha: head.sha,
      harness: { previous: previous.sha, candidate: head.sha },
      agent: { name: adapter.name, model: agentConfig.model },
    },
  );
  printReport(report, options, saveReport(root, report, options.stepSummary));

  // Every fixture had its say; now the failures, all of them, as the one error the shell sees.
  const failures = outcomes.flatMap((each) => each.failures);
  const exitCode =
    failures.length > 0
      ? Math.max(...failures.map((each) => each.exitCode))
      : Math.max(0, ...result.fixtures.flatMap((each) => each.records).map((record) => RUN_EXIT_CODES[record.outcome]));
  emit({ type: "batch.done", durationMs: Date.now() - invokedAt, exitCode });
  if (failures.length > 0) {
    throw new CliError(failures.map((each) => each.message).join("\n"), Math.max(...failures.map((each) => each.exitCode)));
  }
  return result;
}

function oneLine(message: string): string {
  return message.replace(/\s*\n\s*/g, " ");
}

/**
 * At most `max` tasks running at once, started in the order they were handed in; no cap when
 * `max` is undefined. A plain queue: nothing is ever reordered.
 */
function limiter(max: number | undefined): <T>(task: () => Promise<T>) => Promise<T> {
  if (max === undefined) return (task) => task();
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

type SideResult = { record: RunRecord };

/** One fixture's sides as they settled, plus what the batch adds to it once the pair is in. */
type FixtureOutcome = {
  fixture: string;
  /** The sides that finished, in `ENVIRONMENTS` order. */
  sides: SideResult[];
  /** The sides that did not, each error prefixed with the fixture. */
  failures: CliError[];
  comparison: Comparison | null;
  error: string | null;
};

/**
 * One fixture's outcome from its settled sides. A side's failure never cancels the other: its
 * record is still worth having, so the failure names the fixture and side and says where any
 * completed record is. Anything that is not a CliError is a bug and is rethrown as it is.
 */
function settledSides(fixture: string, settled: PromiseSettledResult<SideResult>[]): FixtureOutcome {
  const reasons = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  const unexpected = reasons.find((reason) => !(reason instanceof CliError));
  if (unexpected !== undefined) throw unexpected;
  const sides = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const kept = sides.map(
    ({ record }) => `the ${record.environment} side ran and its record is at ${RUNS_DIR}/${record.runId}`,
  );
  const failures = (reasons as CliError[]).map(
    (error) => new CliError([`${fixture}: ${error.message}`, ...kept].join("\n"), error.exitCode),
  );
  return {
    fixture,
    sides,
    failures,
    comparison: null,
    error: failures.length === 0 ? null : failures.map((each) => each.message).join("\n"),
  };
}

/**
 * One environment: its workspace, the setup command, the agent, the diff, the tests, and its
 * run directory. Throws CliError when the setup command fails: a tree that cannot install is
 * a configuration problem, not a result, so no run.json is written and no agent starts.
 */
async function runSide(side: Side): Promise<SideResult> {
  // A failure said with a reason (the setup line) is not said again without one.
  let failed = false;
  const phase = (to: "setup" | "agent" | "tests" | "done" | "failed", detail?: string): void => {
    if (to === "failed") failed = true;
    side.emit({ type: "side.phase", side: side.ref, phase: to, ...(detail === undefined ? {} : { detail }) });
  };
  try {
    return await runSideSteps(side, phase);
  } catch (error) {
    if (!failed) phase("failed");
    throw error;
  }
}

async function runSideSteps(
  side: Side,
  phase: (to: "setup" | "agent" | "tests" | "done" | "failed", detail?: string) => void,
): Promise<SideResult> {
  phase("setup");
  const runDir = join(side.root, RUNS_DIR, side.runId);
  // Before the agent starts, so a crash mid-run still leaves the raw stream behind.
  mkdirSync(runDir, { recursive: true });
  const stderrPath = join(runDir, "agent.stderr.log");

  const record = await withWorkspace(
    { repoRoot: side.root, ref: "HEAD", runId: side.runId, keep: side.keep, hidePaths: side.hidePaths },
    async (ws) => {
      if (side.environment === "previous") {
        await ws.overlayHarness(side.root, side.head, side.harness);
        await ws.rebaseline();
      }
      // The tool's own material, the fixture prompt among it, is not the agent's to read.
      await ws.hide();

      // Before the agent's clock starts; the agent sees only the tree it leaves behind.
      const setup = side.setupCommand === "" ? null : await runLogged(ws, side.setupCommand, join(runDir, SETUP_LOG));
      const setupLine = setup === null ? undefined : formatProgressText({ kind: "setup", result: setup });
      if (setup !== null && setup.exitCode !== 0) {
        phase("failed", setupLine);
        throw setupFailed(side, setup, join(RUNS_DIR, side.runId, SETUP_LOG));
      }
      phase("agent", setupLine);

      const startedAt = new Date();
      const result = await side.adapter.run({
        workspace: ws,
        prompt: side.fixture.prompt,
        config: side.agentConfig,
        rawOutputPath: join(runDir, "raw.jsonl"),
        stderrPath,
        onEvent: (event) => side.emit({ ...event, side: side.ref }),
      });
      phase("tests", formatProgressText({ kind: "agent", outcome: result.outcome, turns: result.turns }));

      const diff = await ws.diff();
      writeFileSync(join(runDir, "diff.patch"), diff, "utf8");

      const tests = await runTests(ws, side, join(runDir, "test.log"));

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
        setup,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        ...spend(result),
        telemetry: telemetry(result.transcript, result.durationMs),
        diff: summariseDiff(diff),
        tests,
        finalMessage: result.finalMessage,
      };
      writeRunRecord(runDir, finished);
      phase("done", formatProgressText({ kind: "tests", result: tests }));
      side.emit({ type: "side.done", side: side.ref, outcome: finished.outcome, runId: side.runId });
      return finished;
    },
  );
  return { record };
}

/** The top-level figures the agent reported for the whole run. */
function spend(result: AgentResult) {
  const { tokens, costUsd, durationMs, turns, toolCalls, toolFailures } = result;
  return { tokens, costUsd, durationMs, turns, toolCalls, toolFailures };
}

function setupFailed(side: Side, setup: CommandResult, logPath: string): CliError {
  const how = setup.timedOut
    ? `timed out after ${Math.round(setup.durationMs / 1000)}s`
    : setup.exitCode === null
      ? "was killed"
      : `exited with code ${setup.exitCode}`;
  return new CliError(
    `${side.environment}: setup command \`${setup.command}\` ${how}; the agent was not started.\n` +
      `Its output is in ${logPath}. Fix the command, or the tree it runs in, and run again; ` +
      `setupCommand lives in .harnessbench/config.json.`,
  );
}

/**
 * The test step, after the diff: the test files the agent added or changed, and the test command
 * narrowed to them. Nothing runs when the command is empty (`not run`) or has a placeholder and
 * there are no such files (`none written`). The list is also `HB_TEST_FILES`, one per line.
 */
async function runTests(ws: Workspace, side: Side, logPath: string): Promise<TestResult> {
  const idle = { command: null, exitCode: null, durationMs: 0, timedOut: false };
  if (side.testCommand === "") return { state: "not run", files: [], ...idle };
  const files = selectTests(await ws.changedFiles(), side.testFiles);
  const command = expandTestCommand(side.testCommand, files);
  if (command === null) return { state: "none written", files, ...idle };
  const result = await runLogged(ws, command, logPath, { HB_TEST_FILES: files.join("\n") });
  return { ...result, state: result.exitCode === 0 && !result.timedOut ? "passed" : "failed", files };
}

/** Runs a command in the workspace tree, keeping its output as `logPath`. */
async function runLogged(
  ws: Workspace,
  command: string,
  logPath: string,
  env: Record<string, string> = {},
): Promise<CommandResult> {
  const log = createWriteStream(logPath);
  const write = (chunk: string): void => {
    log.write(chunk);
  };
  const result = await ws.exec(command, {
    env,
    timeoutMs: COMMAND_TIMEOUT_MS,
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
