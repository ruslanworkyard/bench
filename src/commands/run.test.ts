import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { compare } from "../compare.js";
import { requireConfig } from "../preflight.js";
import { buildReport, type BatchReport } from "../report.js";
import { loadJudgement } from "./compare.js";
import { CONFIG_FILE, ENV_FILE, FIXTURES_DIR, RUNS_DIR, type AgentConfig, type Config } from "../config.js";
import { readRunRecord, type Environment, type RunRecord } from "../run-record.js";
import type { RunEvent } from "../events.js";

/**
 * The real `claude` is never run here. A recorded stream is replayed by a shell script
 * standing in for it (test/fixtures), so what is under test is the run itself: the
 * workspace, the run directory, the record, the summary, and the exit code.
 */

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** A fake agent or a recorded stream, from test/fixtures. */
function fixture(name: string): string {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  if (name.endsWith(".sh")) chmodSync(path, 0o755); // Survives a checkout that lost the bit.
  return path;
}

/** A PATH with a fake `claude` on it, so the agent's command resolves without installing one. */
const AGENT = "claude-code";
const AGENT_BIN = (() => {
  const bin = tempDir("harnessbench-bin-");
  const path = join(bin, "claude");
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
  return bin;
})();

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${AGENT_BIN}${delimiter}${process.env["PATH"] ?? ""}`,
  // Credentials the agent would use; preflight only checks that one of them is set.
  ANTHROPIC_API_KEY: "test-key",
  // What the fake agent replays, and where it records what it was handed.
  FAKE_CLAUDE_STREAM: fixture("claude-stream.jsonl"),
  FAKE_CLAUDE_DUMP: join(tempDir("harnessbench-dump-"), "dump.txt"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "harnessbench",
  GIT_AUTHOR_EMAIL: "harnessbench@example.com",
  GIT_COMMITTER_NAME: "harnessbench",
  GIT_COMMITTER_EMAIL: "harnessbench@example.com",
};
// The suite may itself run under GitHub Actions; only the test that means to may append to a step summary.
delete ENV["GITHUB_STEP_SUMMARY"];

/** The same environment with nothing that could authenticate an agent. */
function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...ENV };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    delete env[name];
  }
  return env;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: ENV, encoding: "utf8" }).trim();
}

type Outcome = { status: number; stdout: string; stderr: string };

function cli(cwd: string, ...args: string[]): Outcome {
  return run(ENV, cwd, ...args);
}

function run(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Outcome {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** cli(), insisting on exit 0. */
function ok(cwd: string, ...args: string[]): Outcome {
  const result = cli(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

/** An initialised repository with one commit, ready to run. */
function repo(): string {
  const root = tempDir("harnessbench-run-");
  git(root, "init", "--quiet", "-b", "main");
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n", "utf8");
  ok(root, "init", "--test", "npm test", "--agent", AGENT);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

/** repo(), with the config pointing the agent at a fake from test/fixtures. */
type ConfigPatch = Partial<Omit<Config, "agent">> & { agent?: Partial<AgentConfig> };

function repoWithFake(fake: string, patch: ConfigPatch = {}): string {
  const root = repo();
  const path = join(root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  const { agent = {}, ...rest } = patch;
  const patched: Config = {
    ...config,
    testCommand: "echo tests ok",
    ...rest,
    agent: {
      ...config.agent,
      command: fixture(fake),
      env: ["FAKE_CLAUDE_STREAM", "FAKE_CLAUDE_DUMP"],
      ...agent,
    },
  };
  writeFileSync(path, `${JSON.stringify(patched, null, 2)}\n`, "utf8");
  git(root, "commit", "--quiet", "-am", "point the agent at a fake");
  return root;
}

/**
 * A repository on a feature branch whose harness differs from main's: CLAUDE.md revised, a
 * rule added, and one code file changed. Returns the sha of the merge base with main.
 */
function repoOnBranch(fake = "fake-claude.sh"): { root: string; mergeBase: string } {
  const root = repoWithFake(fake);
  const mergeBase = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(root, "CLAUDE.md"), "# House rules, revised\n", "utf8");
  execFileSync("mkdir", ["-p", join(root, ".claude")]);
  writeFileSync(join(root, ".claude", "rules.md"), "new rule\n", "utf8");
  writeFileSync(join(root, "code.txt"), "changed on the branch\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "revise the harness");
  return { root, mergeBase };
}

/** The two run directories a fresh repository has after one run, by environment. */
function runDirs(root: string): Record<Environment, string> {
  const runs = join(root, RUNS_DIR);
  // The batch's `<stamp>` report directory sits beside the runs and is not one.
  const entries = readdirSync(runs).filter((name) => /-(previous|candidate)$/.test(name)).sort();
  assert.equal(entries.length, 2, `expected two runs in ${runs}, found ${entries.join(", ")}`);
  const [candidate, previous] = entries as [string, string];
  assert.match(previous, /-previous$/);
  assert.match(candidate, /-candidate$/);
  // Same timestamp: the ids differ only in their environment.
  assert.equal(previous.replace(/-previous$/, ""), candidate.replace(/-candidate$/, ""));
  return { previous: join(runs, previous), candidate: join(runs, candidate) };
}

/** The candidate side's run directory. */
function runDir(root: string): string {
  return runDirs(root).candidate;
}

function fails(cwd: string, ...args: string[]): Outcome {
  return failsWith(ENV, cwd, ...args);
}

/** The one batch's stamp: the report directory, the one entry in the runs directory without a side. */
function stampOf(root: string): string {
  const stamps = readdirSync(join(root, RUNS_DIR)).filter((name) => /^\d{8}-\d{6}$/.test(name));
  assert.equal(stamps.length, 1, `report directories: ${stamps.join(", ")}`);
  return stamps[0] as string;
}

function readReport(root: string, name: "report.md" | "report.json" = "report.json"): string {
  return readFileSync(join(root, RUNS_DIR, stampOf(root), name), "utf8");
}

function reportOf(root: string): BatchReport {
  return JSON.parse(readReport(root)) as BatchReport;
}

function failsWith(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Outcome {
  const result = run(env, cwd, ...args);
  assert.notEqual(result.status, 0, "expected the command to fail");
  return result;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("run drives the agent in a workspace, once per environment, and leaves complete run directories", () => {
  const root = repoWithFake("fake-claude.sh");

  const { stdout, stderr } = ok(root, "run", "ttl-cache");

  const dirs = runDirs(root);
  const dir = dirs.candidate;
  assert.match(dir, /\/\d{8}-\d{6}-ttl-cache-candidate$/);
  for (const side of Object.values(dirs)) {
    for (const file of ["raw.jsonl", "diff.patch", "test.log", "transcript.jsonl", "run.json", "agent.stderr.log"]) {
      assert.ok(existsSync(join(side, file)), `${file} missing from ${side}`);
    }
  }

  const record: RunRecord = readRunRecord(dir);
  assert.equal(record.outcome, "completed");
  assert.equal(record.fixture, "ttl-cache");
  assert.equal(record.environment, "candidate");
  assert.equal(record.baseBranch, "main");
  assert.match(record.headSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(record.harness.files, ["CLAUDE.md"]);
  assert.equal(record.harness.ref, "HEAD");
  assert.equal(record.harness.sha, record.headSha);
  assert.match(record.harness.hash, /^[0-9a-f]{64}$/);

  // On main itself the merge base is HEAD: the previous side ran the very same harness.
  const previous = readRunRecord(dirs.previous);
  assert.equal(previous.environment, "previous");
  assert.equal(previous.outcome, "completed");
  assert.equal(previous.headSha, record.headSha);
  assert.equal(previous.harness.ref, record.headSha);
  assert.equal(previous.harness.hash, record.harness.hash);
  assert.match(stderr, /harness is identical at HEAD and at the merge base/);
  assert.equal(record.agent.name, AGENT);
  assert.equal(record.agent.command, fixture("fake-claude.sh"));
  assert.equal(record.agent.model, "claude-opus-5"); // From the recording, not the config.
  assert.equal(record.turns, 7);
  assert.deepEqual(record.toolCalls, { Read: 1, Bash: 1 });
  assert.equal(record.costUsd, 0.4213);
  // Telemetry is derived from the transcript, so its calls agree with the agent's own count.
  assert.equal(record.telemetry?.main.toolCalls, 2);
  assert.equal(record.telemetry?.main.turns, 4);
  assert.deepEqual(record.telemetry?.subAgents, []);
  assert.equal(record.telemetry?.readsBeforeFirstEdit, 1);
  assert.equal(record.telemetry?.filesRead, 1);
  assert.deepEqual(record.telemetry?.phases, { exploringMs: record.durationMs, buildingMs: 0, verifyingMs: 0 });
  assert.ok(record.diff.files >= 1, JSON.stringify(record.diff));
  assert.equal(record.diff.added, 1);
  assert.equal(record.diff.removed, 0);
  assert.deepEqual({ ...record.tests, durationMs: 0 }, {
    state: "passed",
    command: "echo tests ok",
    files: [],
    exitCode: 0,
    durationMs: 0,
    timedOut: false,
  });
  assert.equal(record.setup, null); // init found no lockfile in this repository.
  assert.ok(Date.parse(record.startedAt) <= Date.parse(record.finishedAt));

  // The raw stream is the recording, verbatim; the transcript is one event per line.
  assert.equal(readFileSync(join(dir, "raw.jsonl"), "utf8"), readFileSync(fixture("claude-stream.jsonl"), "utf8"));
  const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(transcript.length, 8); // What the recording normalises to; see claude-code.test.
  for (const line of transcript) {
    const event = JSON.parse(line);
    assert.ok(typeof event.type === "string");
    assert.equal(event.thread, "main");
    assert.ok(typeof event.at === "number");
  }

  assert.match(readFileSync(join(dir, "diff.patch"), "utf8"), /^\+\+\+ b\/agent-was-here\.txt$/m);
  assert.match(readFileSync(join(dir, "test.log"), "utf8"), /tests ok/);

  // The agent was handed the fixture's prompt, in the workspace, not in the host repository.
  const dump = readFileSync(ENV["FAKE_CLAUDE_DUMP"] as string, "utf8");
  assert.doesNotMatch(dump, new RegExp(`^cwd: ${root}`, "m"));
  assert.match(readFileSync(`${ENV["FAKE_CLAUDE_DUMP"]}.stdin`, "utf8"), /time-to-live/);
  assert.equal(existsSync(join(root, "agent-was-here.txt")), false);
  // ...and not as a file it could read: .harnessbench is hidden, and its deletion is no change.
  assert.doesNotMatch(dump, /^files: .*\.harnessbench/m);
  assert.ok(existsSync(join(root, FIXTURES_DIR, "ttl-cache", "prompt.md")), "the host keeps its fixtures");
  assert.doesNotMatch(readFileSync(join(dir, "diff.patch"), "utf8"), /harnessbench/);

  // stdout is the summary; the whole report is on disk under the batch's stamp.
  const stamp = stampOf(root);
  assert.equal(basename(dir), `${stamp}-ttl-cache-candidate`);
  const sha = record.headSha.slice(0, 7);
  assert.match(stdout, new RegExp(`^harnessbench {2}1 fixture · code ${sha} · previous ${sha} → candidate ${sha} · claude-opus-5\n`));
  assert.match(stdout, /^warning: ttl-cache: both sides ran the same harness/m);
  assert.match(stdout, /^Outcome {5}unchanged 1$/m);
  assert.match(stdout, /^ttl-cache {2}code quality not judged · /m);
  assert.ok(stdout.endsWith(`\n\nreport  ${RUNS_DIR}/${stamp}/report.md\n`), stdout);
  assert.doesNotMatch(stdout, /Final message|Tool calls/);

  const markdown = readReport(root, "report.md");
  assert.match(markdown, /^\| Turns \| 7 \| 7 \|  \| unchanged \|  \|$/m);
  assert.match(
    markdown,
    /^\| candidate \| completed \| \S+ \| 7 \| 2 \(Read 1, Bash 1\), 1 failed \| in 12, out 345, cache read 6,789, cache write 1,011 \| \$0\.42 \| none \| echo tests ok → passed in \S+ \| 1 file, \+1 \/ -0 \|$/m,
  );
  assert.match(markdown, /^> Added a TTL cache and wired it into the expensive read\.$/m);
  assert.ok(markdown.includes(`- previous: \`${RUNS_DIR}/${stamp}-ttl-cache-previous\``), markdown);

  // Once the runs are done, one line on stderr says how many and how long, and nothing follows it.
  assert.match(stderr.trimEnd().split("\n").at(-1) ?? "", /^2 runs finished in \d\d:\d\d$/);
  assert.doesNotMatch(stderr, /workspace kept/);
});

test("a batch records its events to events.jsonl, and stderr says exactly what it always has", () => {
  const root = repoWithFake("fake-claude.sh");
  const { stderr } = ok(root, "run", "ttl-cache");
  const stamp = stampOf(root);
  const sha = git(root, "rev-parse", "HEAD");

  const events = readFileSync(join(root, RUNS_DIR, stamp, "events.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
  assert.deepEqual(events[0], {
    at: events[0]?.at,
    type: "batch.start",
    stamp,
    fixtures: ["ttl-cache"],
    harness: { previous: sha, candidate: sha },
    sameHarness: true,
    agent: { name: AGENT, model: null },
  });
  assert.deepEqual({ ...events.at(-1), at: 0, durationMs: 0 }, { at: 0, type: "batch.done", durationMs: 0, exitCode: 0 });
  const clocks = events.map((event) => event.at);
  assert.deepEqual(clocks, [...clocks].sort((a, b) => a - b), "events are recorded in the order they happened");

  for (const environment of ["previous", "candidate"] as const) {
    const mine = events.filter((event) => "side" in event && event.side.environment === environment);
    const phases = mine.flatMap((event) => (event.type === "side.phase" ? [event.phase] : []));
    assert.deepEqual(phases, ["queued", "setup", "agent", "tests", "done"]);
    const turns = mine.filter((event) => event.type === "side.turn");
    assert.equal(turns.length, 4); // the recording's four assistant messages
    const tools = mine.flatMap((event) => (event.type === "side.tool" ? [`${event.label}${event.failed ? " failed" : ""}`] : []));
    assert.deepEqual(tools, ["read src/cache.ts", "shell npm test", "shell npm test failed"]);
    const done = mine.at(-1);
    assert.equal(done?.type, "side.done");
    assert.equal(done?.type === "side.done" && done.runId, `${stamp}-ttl-cache-${environment}`);
  }

  // Byte for byte what the direct writes printed, but for clocks and durations; the sides interleave.
  const lines = stderr
    .trimEnd()
    .split("\n")
    .map((line) => line.replace(/^\[\d\d:\d\d\]/, "[mm:ss]").replace(/\(\d+\.\ds\)$/, "(n.ns)"));
  assert.deepEqual(lines.slice(0, 4), [
    `! the harness is identical at HEAD and at the merge base (${sha.slice(0, 7)}):`,
    "! previous and candidate will run the same harness, so any difference",
    "! between them is noise, not the effect of a change",
    "running 1 fixture × 2 sides = 2 runs: ttl-cache",
  ]);
  for (const [environment, column] of [["previous", "previous "], ["candidate", "candidate"]] as const) {
    assert.deepEqual(
      lines.filter((line) => line.includes(`  ${environment} `)),
      [
        `[mm:ss] ttl-cache  ${column}  started`,
        `[mm:ss] ttl-cache  ${column}  agent completed (7 turns)`,
        `[mm:ss] ttl-cache  ${column}  tests passed (n.ns)`,
        `[mm:ss] ttl-cache  ${column}  recorded ${RUNS_DIR}/${stamp}-ttl-cache-${environment}`,
      ],
    );
  }
  assert.equal(lines.length, 13, stderr);
  assert.match(lines.at(-1) ?? "", /^2 runs finished in \d\d:\d\d$/);
});

test("on a branch, the previous side runs the merge-base harness on the branch's code", () => {
  const { root, mergeBase } = repoOnBranch();
  const head = git(root, "rev-parse", "HEAD");

  const { stderr } = ok(root, "run", "ttl-cache", "--keep");

  assert.doesNotMatch(stderr, /harness is identical/);
  const dirs = runDirs(root);
  const previous = readRunRecord(dirs.previous);
  const candidate = readRunRecord(dirs.candidate);

  // Same code, different harness.
  assert.equal(previous.headSha, head);
  assert.equal(candidate.headSha, head);
  assert.equal(previous.harness.sha, mergeBase);
  assert.equal(candidate.harness.sha, head);
  assert.deepEqual(previous.harness.files, ["CLAUDE.md"]);
  assert.deepEqual(candidate.harness.files, [".claude/rules.md", "CLAUDE.md"]);
  assert.notEqual(previous.harness.hash, candidate.harness.hash);

  // What each side's agent actually saw, in the workspaces --keep left behind. The sides run
  // at once, so the lines come in whichever order they finished: pick each by its run id.
  const kept = [...stderr.matchAll(/^workspace kept at (.+)$/gm)].map((match) => match[1] as string);
  assert.equal(kept.length, 2, stderr);
  const tree = (environment: Environment): string => {
    const dir = kept.find((path) => new RegExp(`-${environment}-[^/]+$`).test(path));
    assert.ok(dir !== undefined, `no kept workspace for ${environment} in: ${kept.join(", ")}`);
    return join(dir, "tree");
  };
  const [previousTree, candidateTree] = [tree("previous"), tree("candidate")];
  assert.equal(readFileSync(join(previousTree, "CLAUDE.md"), "utf8"), "# House rules\n");
  assert.equal(existsSync(join(previousTree, ".claude")), false);
  assert.equal(readFileSync(join(previousTree, "code.txt"), "utf8"), "changed on the branch\n");
  assert.equal(readFileSync(join(candidateTree, "CLAUDE.md"), "utf8"), "# House rules, revised\n");
  assert.equal(readFileSync(join(candidateTree, ".claude", "rules.md"), "utf8"), "new rule\n");
  for (const dir of kept) rmSync(dir, { recursive: true, force: true });

  // The overlay is not part of the previous side's diff: only the agent's work is.
  for (const side of [previous, candidate]) {
    assert.deepEqual(side.diff, { files: 1, added: 1, removed: 0 });
  }
  assert.doesNotMatch(readFileSync(join(dirs.previous, "diff.patch"), "utf8"), /CLAUDE\.md/);

  // The host repository is exactly as it was.
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# House rules, revised\n");
});

test("a branch with no merge base is refused with a fix", () => {
  const root = repoWithFake("fake-claude.sh");
  git(root, "checkout", "--quiet", "--orphan", "rewrite");
  git(root, "commit", "--quiet", "-m", "unrelated history");

  const { status, stderr } = fails(root, "run", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /no merge base between 'main' and HEAD/);
  assert.equal(existsSync(join(root, RUNS_DIR)), false);
});

test("a failing test command is a result, not a failure of the run", () => {
  const root = repoWithFake("fake-claude.sh", { testCommand: "echo the suite is broken >&2; exit 1" });

  const { stdout } = ok(root, "run", "ttl-cache", "--detail");

  const record = readRunRecord(runDir(root));
  assert.equal(record.outcome, "completed");
  assert.equal(record.tests.state, "failed");
  assert.equal(record.tests.exitCode, 1);
  assert.equal(record.tests.timedOut, false);
  assert.match(readFileSync(join(runDir(root), "test.log"), "utf8"), /the suite is broken/);
  // --detail prints the markdown report instead of the summary.
  assert.equal(stdout, readReport(root, "report.md"));
  assert.match(stdout, /\| echo the suite is broken >&2; exit 1 → failed, exit 1 \|/);
});

test("the setup command runs in the tree before the agent, and is recorded apart from the agent's time", () => {
  const root = repoWithFake("fake-claude.sh", {
    setupCommand: "echo installing deps && echo ready > deps-installed.txt",
  });

  const { stdout } = ok(root, "run", "ttl-cache", "--detail");

  // What setup left behind is what the agent finds; the host repository gets none of it.
  const dump = readFileSync(ENV["FAKE_CLAUDE_DUMP"] as string, "utf8");
  assert.match(dump, /^files: .*\bdeps-installed\.txt\b/m);
  assert.equal(existsSync(join(root, "deps-installed.txt")), false);

  for (const dir of Object.values(runDirs(root))) {
    assert.match(readFileSync(join(dir, "setup.log"), "utf8"), /installing deps/);
    const record = readRunRecord(dir);
    assert.deepEqual(record.setup && { ...record.setup, durationMs: 0 }, {
      command: "echo installing deps && echo ready > deps-installed.txt",
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    });
    assert.ok((record.setup?.durationMs ?? -1) >= 0);
    // Setup time is not agent time: the record's clock starts once the tree is ready.
    assert.equal(record.durationMs, record.telemetry?.phases.exploringMs);
  }
  assert.match(stdout, /\| echo installing deps && echo ready > deps-installed\.txt → ok in \S+ \|/);
});

test("a failing setup command fails the run before any agent starts, and leaves its log", () => {
  const root = repoWithFake("fake-claude.sh", { setupCommand: "echo cannot install >&2; exit 7" });
  const dumpBefore = existsSync(ENV["FAKE_CLAUDE_DUMP"] as string) && readFileSync(ENV["FAKE_CLAUDE_DUMP"] as string, "utf8");

  const { status, stderr } = fails(root, "run", "ttl-cache");

  // Both sides run at once and both fail the same way: one error carries both messages.
  assert.equal(status, 1);
  for (const side of ["previous", "candidate"]) {
    assert.match(stderr, new RegExp(`${side}: setup command \`echo cannot install >&2; exit 7\` exited with code 7`));
    assert.match(stderr, new RegExp(`${RUNS_DIR}/\\d{8}-\\d{6}-ttl-cache-${side}/setup\\.log`));
  }
  assert.match(stderr, /the agent was not started/);
  assert.doesNotMatch(stderr, /side ran and its record/);

  // Each side got a directory holding the log and nothing of a run.
  for (const dir of Object.values(runDirs(root))) {
    assert.equal(readFileSync(join(dir, "setup.log"), "utf8"), "cannot install\n");
    assert.equal(existsSync(join(dir, "run.json")), false);
    assert.equal(existsSync(join(dir, "raw.jsonl")), false);
  }
  // The fake agent never ran: its dump is whatever an earlier test left, or nothing.
  const dumpAfter = existsSync(ENV["FAKE_CLAUDE_DUMP"] as string) && readFileSync(ENV["FAKE_CLAUDE_DUMP"] as string, "utf8");
  assert.equal(dumpAfter, dumpBefore);
});

test("when previous ran and candidate's setup fails, the error names the side and the surviving record", () => {
  // The two trees differ only in their harness: a rule file that exists on the candidate side.
  const { root } = repoOnBranch();
  const path = join(root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  config.setupCommand = "test ! -e .claude/rules.md";
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  git(root, "commit", "--quiet", "-am", "setup that only the previous tree survives");

  const { status, stderr } = fails(root, "run", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /candidate: setup command `test ! -e \.claude\/rules\.md` exited with code 1/);
  assert.match(stderr, new RegExp(`the previous side ran and its record is at ${RUNS_DIR}/\\d{8}-\\d{6}-ttl-cache-previous`));

  const dirs = runDirs(root);
  assert.equal(readRunRecord(dirs.previous).outcome, "completed");
  assert.equal(readRunRecord(dirs.previous).setup?.exitCode, 0);
  assert.ok(existsSync(join(dirs.candidate, "setup.log")));
  assert.equal(existsSync(join(dirs.candidate, "run.json")), false);
});

test("no setup command means nothing runs before the agent, and no log", () => {
  const root = repoWithFake("fake-claude.sh", { setupCommand: "" });

  const { stdout } = ok(root, "run", "ttl-cache", "--detail");

  for (const dir of Object.values(runDirs(root))) {
    assert.equal(readRunRecord(dir).setup, null);
    assert.equal(existsSync(join(dir, "setup.log")), false);
  }
  assert.match(stdout, /^\| previous \| completed \|.* \| none \| echo tests ok/m);
  assert.equal(reportOf(root).fixtures[0]?.sides.candidate?.setup, null);
});

test("an empty test command means tests are not run in this environment, and nothing is run", () => {
  const root = repoWithFake("test-writing-claude.sh", { testCommand: "", testFiles: ["src/**/*.test.ts"] });

  const { stdout } = ok(root, "run", "ttl-cache", "--detail");

  assert.deepEqual(readRunRecord(runDir(root)).tests, {
    state: "not run",
    command: null,
    files: [],
    exitCode: null,
    durationMs: 0,
    timedOut: false,
  });
  assert.equal(existsSync(join(runDir(root), "test.log")), false);
  assert.match(stdout, /\| none \| not run in this environment \| 2 files/);
  assert.match(stdout, /^\| Agent's tests \| not run \| not run \|  \| n\/a \| not run in this environment \|$/m);
});

/** Prints what the test command was handed, so test.log says it. */
const ECHO_FILES = `echo "files: {files}"; echo "dirs: {dirs}"; echo "env: $HB_TEST_FILES"`;

test("a test command with placeholders runs only the test files the agent wrote", () => {
  const root = repoWithFake("test-writing-claude.sh", { testCommand: ECHO_FILES, testFiles: ["src/**/*.test.ts"], testLabel: "Lint" });

  const { stdout } = ok(root, "run", "ttl-cache", "--detail");

  const { tests } = readRunRecord(runDir(root));
  assert.equal(tests.state, "passed");
  assert.deepEqual(tests.files, ["src/answer.test.ts"]);
  assert.equal(tests.command, `echo "files: src/answer.test.ts"; echo "dirs: ./src"; echo "env: $HB_TEST_FILES"`);
  const log = readFileSync(join(runDir(root), "test.log"), "utf8");
  assert.match(log, /^files: src\/answer\.test\.ts$/m);
  assert.match(log, /^dirs: \.\/src$/m);
  assert.match(log, /^env: src\/answer\.test\.ts$/m);
  // The label is the config's, in the table and the side summary.
  assert.match(stdout, /^\| Lint \| passed \| passed \|  \| unchanged \|  \|$/m);
  assert.match(stdout, /\| Setup \| Lint \| Changes \|/);
  assert.match(stdout, /→ passed in \S+ \(1 file\) \|/);
});

test("an agent that writes no test file has none written, and the placeholder command never runs", () => {
  const root = repoWithFake("fake-claude.sh", { testCommand: ECHO_FILES, testFiles: ["src/**/*.test.ts"] });

  const { stdout } = ok(root, "run", "ttl-cache", "--detail");

  const { tests } = readRunRecord(runDir(root));
  assert.deepEqual(tests, { state: "none written", command: null, files: [], exitCode: null, durationMs: 0, timedOut: false });
  assert.equal(existsSync(join(runDir(root), "test.log")), false);
  assert.match(stdout, /\| none \| none written \| 1 file/);
  assert.match(stdout, /^\| Agent's tests \| none written \| none written \|  \| unchanged \|  \|$/m);
});

test("a test command without placeholders runs as it is, the whole suite, with the files in the environment", () => {
  const root = repoWithFake("test-writing-claude.sh", { testCommand: `echo "env: $HB_TEST_FILES"`, testFiles: ["src/**/*.test.ts"] });

  ok(root, "run", "ttl-cache");

  const { tests } = readRunRecord(runDir(root));
  assert.equal(tests.state, "passed");
  assert.equal(tests.command, `echo "env: $HB_TEST_FILES"`);
  assert.deepEqual(tests.files, ["src/answer.test.ts"]);
  assert.match(readFileSync(join(runDir(root), "test.log"), "utf8"), /^env: src\/answer\.test\.ts$/m);
});

test("an agent that hangs is a timeout: exit 2, and the record is still written", () => {
  const root = repoWithFake("slow-claude.sh", { agent: { timeoutMinutes: 0.01 } });

  const { status } = cli(root, "run", "ttl-cache");

  assert.equal(status, 2);
  for (const dir of Object.values(runDirs(root))) {
    const record = readRunRecord(dir);
    assert.equal(record.outcome, "timeout");
    assert.equal(record.exitCode, null);
  }
  const sides = reportOf(root).fixtures[0]?.sides;
  assert.deepEqual([sides?.previous?.outcome, sides?.candidate?.outcome], ["timeout", "timeout"]);
});

test("an agent that cannot start is an error: exit 3, explained by its stderr log", () => {
  const root = repoWithFake("failing-claude.sh");

  const { status } = cli(root, "run", "ttl-cache");

  assert.equal(status, 3);
  const dir = runDir(root);
  assert.equal(readRunRecord(dir).outcome, "error");
  assert.equal(readFileSync(join(dir, "agent.stderr.log"), "utf8"), "claude: invalid API key\n");
  assert.equal(reportOf(root).fixtures[0]?.sides.candidate?.outcome, "error");
});

test("an agent that hits the turn limit is max_turns: exit 4, and compare says so", () => {
  const root = repoWithFake("max-turns-claude.sh");

  const { status, stdout } = cli(root, "run", "ttl-cache");

  assert.equal(status, 4);
  for (const dir of Object.values(runDirs(root))) {
    const record = readRunRecord(dir);
    assert.equal(record.outcome, "max_turns");
    assert.equal(record.exitCode, 1);
    assert.equal(record.turns, 40);
    assert.equal(record.finalMessage, "cut off by the turn limit after 40 turns");
  }
  const sides = reportOf(root).fixtures[0]?.sides;
  assert.deepEqual([sides?.previous?.outcome, sides?.candidate?.outcome], ["max_turns", "max_turns"]);
  assert.equal(sides?.candidate?.finalMessage, "cut off by the turn limit after 40 turns");
  assert.match(stdout, /^warning: ttl-cache: previous hit the turn limit \(40 turns\); its effort rows are not comparable$/m);
  assert.match(stdout, /^warning: ttl-cache: candidate hit the turn limit \(40 turns\); its effort rows are not comparable$/m);
});

test("--keep leaves the workspace behind and says where; without it the workspace is gone", () => {
  const kept = repoWithFake("fake-claude.sh");
  const { stderr } = ok(kept, "run", "ttl-cache", "--keep");
  const workspaces = [...stderr.matchAll(/^workspace kept at (.+)$/gm)].map((match) => match[1] as string);
  assert.equal(workspaces.length, 2, stderr);
  const dirs = runDirs(kept);
  for (const environment of ["previous", "candidate"] as const) {
    // Whichever side finished first printed first; each path is named for its own run id.
    const runId = readRunRecord(dirs[environment]).runId;
    const workspace = workspaces.find((path) => basename(path).startsWith(`${runId}-`));
    assert.ok(workspace !== undefined, `no kept workspace for ${runId} in: ${workspaces.join(", ")}`);
    assert.ok(existsSync(join(workspace, "tree", "agent-was-here.txt")), workspace);
    // Nothing else can collide with it now, but a kept workspace is still litter.
    rmSync(workspace, { recursive: true, force: true });
  }

  // The setup command prints the tree it ran in, so each side names its own workspace.
  const dropped = repoWithFake("fake-claude.sh", { setupCommand: "pwd" });
  ok(dropped, "run", "ttl-cache");
  for (const dir of Object.values(runDirs(dropped))) {
    const tree = readFileSync(join(dir, "setup.log"), "utf8").trim();
    assert.equal(existsSync(dirname(tree)), false, tree);
  }
});

test("--json prints the report exactly as report.json holds it; GITHUB_STEP_SUMMARY gets report.md appended", () => {
  const root = repoWithFake("fake-claude.sh");
  const summary = join(tempDir("harnessbench-summary-"), "summary.md");

  const { stdout } = run({ ...ENV, GITHUB_STEP_SUMMARY: summary }, root, "run", "ttl-cache", "--json");

  const dirs = runDirs(root);
  const previous = readRunRecord(dirs.previous);
  const candidate = readRunRecord(dirs.candidate);
  const judgement = loadJudgement(root, requireConfig(root), previous, candidate);
  const comparison = compare(previous, candidate, judgement);
  const stamp = previous.runId.replace(/-ttl-cache-previous$/, "");
  assert.equal(stampOf(root), stamp);
  assert.deepEqual(JSON.parse(stdout), buildReport(stamp, [{ fixture: "ttl-cache", previous, candidate, comparison, error: null }]));
  assert.equal(stdout, readReport(root, "report.json"));
  assert.equal(readFileSync(summary, "utf8"), readReport(root, "report.md"));
});

test("--max-turns and --model override the config for one run", () => {
  const root = repoWithFake("fake-claude.sh", { agent: { model: "claude-opus-5", maxTurns: 40 } });

  ok(root, "run", "ttl-cache", "--max-turns", "7", "--model", "claude-sonnet-5");

  const dump = readFileSync(ENV["FAKE_CLAUDE_DUMP"] as string, "utf8");
  assert.match(dump, /^argv: .*--model claude-sonnet-5 --max-turns 7$/m);
  const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as Config;
  assert.equal(config.agent.maxTurns, 40); // The config itself is untouched.
});

test("--max-turns must be a positive integer", () => {
  const { status, stderr } = fails(repoWithFake("fake-claude.sh"), "run", "ttl-cache", "--max-turns", "lots");

  assert.equal(status, 2);
  assert.match(stderr, /--max-turns.*positive integer/);
});

test("run warns about harness files with uncommitted changes, and uses the committed version", () => {
  const root = repoWithFake("fake-claude.sh");
  writeFileSync(join(root, "CLAUDE.md"), "# House rules, revised\n", "utf8");

  const { stderr } = ok(root, "run", "ttl-cache");

  assert.match(stderr, /uncommitted changes/);
  assert.match(stderr, /committed version/);
  assert.match(stderr, /!\s+CLAUDE\.md/);
});

test("run without a config points at init", () => {
  const root = tempDir("harnessbench-run-bare-");
  git(root, "init", "--quiet", "-b", "main");

  const { status, stderr } = fails(root, "run", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /no \.harnessbench\/config\.json/);
  assert.match(stderr, /harnessbench init/);
});

test("run with an unknown fixture lists the ones that exist", () => {
  const { status, stderr } = fails(repo(), "run", "nope");

  assert.equal(status, 1);
  assert.match(stderr, /unknown fixture 'nope'/);
  assert.match(stderr, /available fixtures:/);
  assert.match(stderr, /ttl-cache/);
});

test("run with a missing base branch names it", () => {
  const { status, stderr } = fails(repo(), "run", "ttl-cache", "--base", "release/4.2");

  assert.equal(status, 1);
  assert.match(stderr, /base branch 'release\/4\.2' not found/);
});

test("run with an unknown agent lists the ones harnessbench can drive", () => {
  const { status, stderr } = fails(repo(), "run", "ttl-cache", "--agent", "clod");

  assert.equal(status, 1);
  assert.match(stderr, /unknown agent 'clod'/);
  assert.match(stderr, /known agents: claude-code/);
});

test("run without credentials says which variables would do, and where", () => {
  const { status, stderr } = failsWith(withoutCredentials(), repo(), "run", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /no credentials for claude-code: set one of ANTHROPIC_API_KEY/);
  assert.match(stderr, /in your environment or in \.harnessbench\/\.env/);
});

test("run takes credentials from .harnessbench/.env when the shell has none, and the agent gets them", () => {
  const root = repoWithFake("fake-claude.sh");
  writeFileSync(join(root, ENV_FILE), "# laptop key\nANTHROPIC_API_KEY=from-the-env-file\n", "utf8");

  const result = run(withoutCredentials(), root, "run", "ttl-cache");

  assert.equal(result.status, 0, result.stderr);
  const dump = readFileSync(ENV["FAKE_CLAUDE_DUMP"] as string, "utf8");
  assert.match(dump, /^ANTHROPIC_API_KEY=from-the-env-file$/m);
  assert.equal(git(root, "status", "--porcelain"), "", "the env file is ignored by git");
});

test("run refuses a malformed .harnessbench/.env without echoing it", () => {
  const root = repoWithFake("fake-claude.sh");
  writeFileSync(join(root, ENV_FILE), "sk-pasted-without-a-name\n", "utf8");

  const { status, stderr } = fails(root, "run", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /\.harnessbench\/\.env: line 1/);
  assert.doesNotMatch(stderr, /sk-pasted/);
});

/** Every run directory's name, sorted. */
function runIds(root: string): string[] {
  return readdirSync(join(root, RUNS_DIR)).filter((name) => /-(previous|candidate)$/.test(name)).sort();
}

test("bare run selects every fixture: one stamp, one pair each, the roll-up above the tables", () => {
  const root = repoWithFake("fake-claude.sh");

  const { stdout, stderr } = ok(root, "run");

  const ids = runIds(root);
  assert.equal(ids.length, 6, ids.join(", "));
  const stamps = new Set(ids.map((id) => id.slice(0, 15)));
  assert.equal(stamps.size, 1, `stamps: ${[...stamps].join(", ")}`);
  const [stamp] = [...stamps] as [string];
  for (const fixture of ["announcements", "holiday-api-client", "ttl-cache"]) {
    for (const side of ["previous", "candidate"]) {
      assert.ok(ids.includes(`${stamp}-${fixture}-${side}`), `${fixture} ${side} missing from ${ids.join(", ")}`);
      assert.equal(readRunRecord(join(root, RUNS_DIR, `${stamp}-${fixture}-${side}`)).outcome, "completed");
    }
  }
  assert.match(stderr, /^running 3 fixtures × 2 sides = 6 runs: announcements, holiday-api-client, ttl-cache$/m);
  // The plan line comes after preflight's warnings and before the first progress line.
  assert.ok(stderr.indexOf("harness is identical") < stderr.indexOf("running 3 fixtures"), stderr);
  assert.ok(stderr.indexOf("running 3 fixtures") < stderr.indexOf("] announcements"), stderr);
  assert.match(stderr, /^\[\d\d:\d\d\] holiday-api-client {2}previous {3}started$/m);
  assert.match(stderr, /^\[\d\d:\d\d\] ttl-cache {11}candidate {2}started$/m);

  // The summary: header, warnings, verdicts, then each fixture in listing order, the report last.
  assert.match(stdout, /^harnessbench {2}3 fixtures · code [0-9a-f]{7}/);
  assert.match(stdout, /^warning: announcements: both sides ran the same harness/m);
  assert.match(stdout, /^Outcome {5}unchanged 3$/m);
  const fixtureLines = [...stdout.matchAll(/^(announcements|holiday-api-client|ttl-cache) +code quality not judged/gm)].map((match) => match[1]);
  assert.deepEqual(fixtureLines, ["announcements", "holiday-api-client", "ttl-cache"]);
  const at = (text: string): number => stdout.indexOf(text);
  assert.ok(at("warning:") < at("Outcome"), "warnings above the verdict lines");
  assert.ok(at("Judges") < at("\nannouncements "), "verdicts above the fixtures");
  assert.ok(stdout.endsWith(`\n\nreport  ${RUNS_DIR}/${stamp}/report.md\n`), stdout);
  assert.equal(readReport(root, "report.md").match(/^<details>/gm)?.length, 3);
  assert.match(stderr, /^6 runs finished in \d\d:\d\d$/m);
});

test("--tag selects the fixtures carrying any listed tag; with ids it is the intersection; no match names both", () => {
  const root = repoWithFake("fake-claude.sh");
  ok(root, "run", "--tag", "http", "--tag", "performance");
  assert.deepEqual(
    runIds(root).map((id) => id.slice(16)),
    ["holiday-api-client-candidate", "holiday-api-client-previous", "ttl-cache-candidate", "ttl-cache-previous"],
  );

  const both = repoWithFake("fake-claude.sh");
  const { stderr } = ok(both, "run", "announcements", "ttl-cache", "--tag", "performance");
  assert.deepEqual(runIds(both).map((id) => id.slice(16)), ["ttl-cache-candidate", "ttl-cache-previous"]);
  assert.match(stderr, /^running 1 fixture × 2 sides = 2 runs: ttl-cache$/m);

  const none = fails(repoWithFake("fake-claude.sh"), "run", "announcements", "--tag", "http");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no fixtures match fixtures announcements with tags http/);
  assert.match(none.stderr, /available fixtures:\n\s+announcements\n\s+holiday-api-client\n\s+ttl-cache/);
  assert.match(none.stderr, /tags in use: http, integration, performance, persistence/);
  assert.match(fails(repoWithFake("fake-claude.sh"), "run", "--tag", "nope").stderr, /no fixtures match tags nope/);
});

test("one fixture's candidate failing setup leaves the others compared, and the error names that fixture and side", () => {
  // The setup command sees the workspace path: the run id, then mkdtemp's unique suffix.
  const root = repoWithFake("fake-claude.sh", {
    setupCommand: 'case "$(pwd)" in *-ttl-cache-candidate-*/tree) echo cannot install >&2; exit 7;; esac',
  });

  const { status, stdout, stderr } = fails(root, "run");

  assert.equal(status, 1);
  assert.match(stderr, /^harnessbench: ttl-cache: candidate: setup command `case .*` exited with code 7/m);
  assert.match(stderr, new RegExp(`the previous side ran and its record is at ${RUNS_DIR}/\\d{8}-\\d{6}-ttl-cache-previous`));
  assert.doesNotMatch(stderr, /announcements: (previous|candidate): setup/);
  assert.doesNotMatch(stderr, /holiday-api-client: (previous|candidate): setup/);

  // Five records: the failed side has a log and no run.json.
  const ids = runIds(root);
  assert.equal(ids.length, 6);
  const failed = ids.find((id) => id.endsWith("-ttl-cache-candidate")) as string;
  assert.equal(existsSync(join(root, RUNS_DIR, failed, "run.json")), false);
  assert.match(readFileSync(join(root, RUNS_DIR, failed, "setup.log"), "utf8"), /cannot install/);
  for (const id of ids.filter((each) => each !== failed)) assert.equal(readRunRecord(join(root, RUNS_DIR, id)).outcome, "completed");

  // The output still came: the roll-up counts the two compared fixtures, ttl-cache shows its error.
  assert.match(stdout, /^Outcome {5}unchanged 2$/m);
  assert.match(stdout, /^ttl-cache {11}error: ttl-cache: candidate: setup command `case .*` exited with code 7; the agent was not started\.$/m);
  const report = reportOf(root);
  assert.equal(report.rollup.fixtures, 2);
  assert.deepEqual(report.rollup.rows.find((row) => row.id === "turns")?.unchanged, ["announcements", "holiday-api-client"]);
  const ttl = report.fixtures.find((each) => each.fixture === "ttl-cache");
  assert.equal(ttl?.comparison, null);
  assert.notEqual(ttl?.sides.previous, null);
  assert.equal(ttl?.sides.candidate, null);
  assert.match(stderr, /^5 runs finished in \d\d:\d\d$/m);
});

test("--json over several fixtures has the batch shape, a null comparison and an error for a failed fixture", () => {
  const root = repoWithFake("fake-claude.sh", {
    setupCommand: 'case "$(pwd)" in *-announcements-previous-*/tree) exit 3;; esac',
  });

  const { status, stdout } = fails(root, "run", "--json");

  assert.equal(status, 1);
  const printed = JSON.parse(stdout) as BatchReport;
  assert.match(printed.stamp, /^\d{8}-\d{6}$/);
  assert.deepEqual(printed.fixtures.map((each) => each.fixture), ["announcements", "holiday-api-client", "ttl-cache"]);
  type Fixture = BatchReport["fixtures"][number];
  const [announcements, holiday, ttl] = printed.fixtures as [Fixture, Fixture, Fixture];
  assert.equal(announcements.sides.previous, null);
  assert.notEqual(announcements.sides.candidate, null);
  assert.equal(announcements.comparison, null);
  assert.match(announcements.error ?? "", /^announcements: previous: setup command/);
  for (const each of [holiday, ttl]) {
    assert.ok(each.sides.previous?.runId.endsWith("-previous") && each.sides.candidate?.runId.endsWith("-candidate"));
    assert.equal(each.comparison?.fixture, each.fixture);
    assert.equal(each.error, null);
  }
  assert.equal(printed.rollup.fixtures, 2);
  assert.deepEqual(printed.rollup.rows.find((row) => row.id === "outcome")?.unchanged, ["holiday-api-client", "ttl-cache"]);
});

/** The environment for a fake that leaves marks (timestamps, pids) in a fresh directory. */
function withMarks(): { env: NodeJS.ProcessEnv; marks: string } {
  const marks = tempDir("harnessbench-marks-");
  return { env: { ...ENV, FAKE_CLAUDE_MARKS: marks }, marks };
}

const MARKING_AGENT = { env: ["FAKE_CLAUDE_STREAM", "FAKE_CLAUDE_MARKS"] };

/** When each marked agent started and finished, by run id. */
function intervals(marks: string): Array<{ id: string; started: number; finished: number }> {
  const mtime = (name: string): number => statSync(join(marks, name)).mtimeMs;
  return readdirSync(marks)
    .filter((name) => name.endsWith(".started"))
    .map((name) => name.slice(0, -".started".length))
    .map((id) => ({ id, started: mtime(`${id}.started`), finished: mtime(`${id}.finished`) }))
    .sort((a, b) => a.started - b.started);
}

test("both sides run at once, and the records still come back previous first", () => {
  const root = repoWithFake("concurrent-claude.sh", { agent: MARKING_AGENT });
  const { env, marks } = withMarks();

  const began = Date.now();
  const result = run(env, root, "run", "ttl-cache", "--json");
  const took = Date.now() - began;

  assert.equal(result.status, 0, result.stderr);
  // Each agent sleeps 1.5 s; one after the other would take 3 s. Both start before either ends.
  assert.ok(took < 2500, `run took ${took}ms`);
  const sides = intervals(marks);
  assert.equal(sides.length, 2);
  const started = Math.max(...sides.map((side) => side.started));
  const finished = Math.min(...sides.map((side) => side.finished));
  assert.ok(started < finished, `an agent started at ${started} after another finished at ${finished}`);

  const printed = JSON.parse(result.stdout) as BatchReport;
  const pair = printed.fixtures[0]?.sides;
  assert.deepEqual([pair?.previous?.runId.endsWith("-previous"), pair?.candidate?.runId.endsWith("-candidate")], [true, true]);
  const dirs = runDirs(root);
  assert.equal(readRunRecord(dirs.previous).outcome, "completed");
  assert.equal(readRunRecord(dirs.candidate).outcome, "completed");
});

test("three fixtures in one invocation share a stamp and all six sides overlap", () => {
  const root = repoWithFake("concurrent-claude.sh", { agent: MARKING_AGENT });
  const { env, marks } = withMarks();

  const began = Date.now();
  const result = run(env, root, "run", "--json");
  const took = Date.now() - began;

  assert.equal(result.status, 0, result.stderr);
  // Six agents of 1.5 s each; under twice one sleep means none waited for another.
  assert.ok(took < 3000, `run took ${took}ms`);
  const sides = intervals(marks);
  assert.equal(sides.length, 6, sides.map((side) => side.id).join(", "));
  const stamps = new Set(sides.map((side) => side.id.slice(0, 15)));
  assert.equal(stamps.size, 1);
  const started = Math.max(...sides.map((side) => side.started));
  const finished = Math.min(...sides.map((side) => side.finished));
  assert.ok(started < finished, "every agent started before any finished");
  const printed = JSON.parse(result.stdout) as BatchReport;
  assert.equal(printed.fixtures.length, 3);
  assert.ok(printed.fixtures.every((each) => each.sides.previous !== null && each.sides.candidate !== null && each.comparison !== null));
});

test("--concurrency 1 runs one side at a time, in fixture order, previous before candidate", () => {
  const root = repoWithFake("concurrent-claude.sh", { agent: MARKING_AGENT });
  const { env, marks } = withMarks();

  const result = run(env, root, "run", "ttl-cache", "announcements", "--concurrency", "1");

  assert.equal(result.status, 0, result.stderr);
  const sides = intervals(marks);
  assert.equal(sides.length, 4);
  for (let i = 1; i < sides.length; i++) {
    const before = sides[i - 1] as (typeof sides)[number];
    const after = sides[i] as (typeof sides)[number];
    assert.ok(after.started >= before.finished, `${after.id} started before ${before.id} finished`);
  }
  assert.deepEqual(
    // The mark is named for the workspace: the stamp, the fixture and side, mkdtemp's suffix.
    sides.map((side) => side.id.slice(16).replace(/-[^-]+$/, "")),
    ["ttl-cache-previous", "ttl-cache-candidate", "announcements-previous", "announcements-candidate"],
  );
  assert.match(fails(root, "run", "ttl-cache", "--concurrency", "0").stderr, /--concurrency.*positive integer/);
});

test("progress goes to stderr, one line per event per side, while stdout waits for the end", () => {
  const root = repoWithFake("fake-claude.sh", { setupCommand: "echo deps" });

  const { stdout, stderr } = ok(root, "run", "ttl-cache");

  for (const side of ["previous", "candidate"]) {
    const line = (text: string): RegExp => new RegExp(`^\\[\\d\\d:\\d\\d\\] ttl-cache {2}${side}\\s+${text}$`, "m");
    assert.match(stderr, line("started"));
    assert.match(stderr, line("setup ok \\(echo deps, \\d+\\.\\ds\\)"));
    assert.match(stderr, line("agent completed \\(7 turns\\)"));
    assert.match(stderr, line("tests passed \\(\\d+\\.\\ds\\)"));
    assert.match(stderr, line(`recorded ${RUNS_DIR}/\\d{8}-\\d{6}-ttl-cache-${side}`));
  }
  assert.doesNotMatch(stdout, /^\[\d\d:\d\d\]/m);
  // Both sides start before either records: the lines are one timeline, not two summaries.
  const lines = stderr.split("\n");
  const index = (pattern: RegExp): number => lines.findIndex((line) => pattern.test(line));
  assert.ok(index(/candidate\s+started/) < index(/previous\s+recorded/), stderr);
  assert.ok(index(/previous\s+started/) < index(/candidate\s+recorded/), stderr);
});

test("with --json, progress still goes to stderr and stdout stays pure JSON", () => {
  const root = repoWithFake("fake-claude.sh");

  const { stdout, stderr } = ok(root, "run", "ttl-cache", "--json");

  assert.match(stderr, /^\[\d\d:\d\d\] ttl-cache {2}previous\s+started$/m);
  assert.match(stderr, /^\[\d\d:\d\d\] ttl-cache {2}candidate\s+recorded /m);
  assert.match(stderr, /^running 1 fixture × 2 sides = 2 runs: ttl-cache$/m);
  assert.doesNotMatch(stdout, /^\[\d\d:\d\d\]/m);
  assert.deepEqual(Object.keys(JSON.parse(stdout) as object), ["schema", "stamp", "headSha", "harness", "agent", "judge", "rollup", "fixtures"]);
});

/** Polls `probe` until it returns a value, or fails after `timeoutMs`. */
async function until<T>(what: string, probe: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a run whose agents write their pids and then hang, waits until both are running, and
 * sends the CLI the signal a terminal's Ctrl-C would. Returns what the CLI did, the agents'
 * pids, and the workspace directories they ran in.
 */
async function interrupt(
  ...args: string[]
): Promise<{ status: number | null; stderr: string; pids: number[]; workspaces: string[] }> {
  const root = repoWithFake("interruptible-claude.sh", { agent: { env: ["FAKE_CLAUDE_MARKS"] } });
  const { env, marks } = withMarks();

  const child = spawn(process.execPath, [CLI, "run", "ttl-cache", ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));

  const agents = await until(
    "both agents to start",
    () => {
      const files = readdirSync(marks).filter((name) => name.endsWith(".pid"));
      const pids = files.map((name) => Number(readFileSync(join(marks, name), "utf8").trim()));
      return files.length === 2 && pids.every(Number.isInteger) ? { files, pids } : null;
    },
    20_000,
  );
  for (const pid of agents.pids) assert.ok(alive(pid), `agent ${pid} is not running`);

  child.kill("SIGINT");
  const status = await closed;
  // A killed process is a zombie until its parent reaps it; the CLI's exit hands them to init.
  await until("the agents to be gone", () => (agents.pids.some(alive) ? null : true), 5_000);

  // Each pid file is named for the workspace directory the agent ran in, suffix and all.
  const workspaces = agents.files.map((name) => join(realpathSync(tmpdir()), "harnessbench", name.replace(/\.pid$/, "")));
  return { status, stderr, pids: agents.pids, workspaces };
}

test("Ctrl-C kills both agents, removes both workspaces, and exits 130", async () => {
  const { status, stderr, pids, workspaces } = await interrupt();

  assert.equal(status, 130);
  assert.match(stderr, /^harnessbench: interrupted, stopping 2 run\(s\)$/m);
  assert.doesNotMatch(stderr, /workspace kept/);
  for (const pid of pids) assert.equal(alive(pid), false, `agent ${pid} survived`);
  for (const dir of workspaces) assert.equal(existsSync(dir), false, `${dir} was left behind`);
});

test("Ctrl-C with --keep kills both agents but leaves the workspaces, and lists them", async () => {
  const { status, stderr, pids, workspaces } = await interrupt("--keep");

  assert.equal(status, 130);
  assert.match(stderr, /^harnessbench: interrupted, stopping 2 run\(s\)$/m);
  for (const pid of pids) assert.equal(alive(pid), false, `agent ${pid} survived`);
  for (const dir of workspaces) {
    assert.ok(existsSync(dir), `${dir} is gone`);
    assert.ok(stderr.includes(`workspace kept at ${dir}`), stderr);
    rmSync(dir, { recursive: true, force: true });
  }
});
