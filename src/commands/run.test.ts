import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { compare } from "../compare.js";
import { CONFIG_FILE, RUNS_DIR, type AgentConfig, type Config } from "../config.js";
import { readRunRecord, type Environment, type RunRecord } from "../run-record.js";

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
  const entries = execFileSync("ls", [runs], { encoding: "utf8" }).trim().split("\n").sort();
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
  assert.deepEqual(record.tests && { ...record.tests, durationMs: 0 }, {
    command: "echo tests ok",
    exitCode: 0,
    durationMs: 0,
    timedOut: false,
  });
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

  assert.match(stdout, /harnessbench run {2}ttl-cache · previous {2}→ completed in /);
  assert.match(stdout, /harnessbench run {2}ttl-cache · candidate {2}→ completed in /);
  assert.match(stdout, /Harness\s+1 file at [0-9a-f]{7} \(HEAD\) · hash [0-9a-f]{12}/);
  assert.match(stdout, /Harness\s+1 file at [0-9a-f]{7} \(merge base\) · hash [0-9a-f]{12}/);
  assert.match(stdout, new RegExp(`Agent\\s+${AGENT} · claude-opus-5`));
  assert.match(stdout, /Turns\s+7\s+Tool calls\s+2 \(Read 1, Bash 1\)\s+Tool failures 1/);
  assert.match(stdout, /Tokens\s+in 12\s+out 345\s+cache read 6,789\s+cache write 1,011/);
  assert.match(stdout, /Cost\s+\$0\.42/);
  assert.match(stdout, /Changes\s+1 file, \+1 \/ -0/);
  assert.match(stdout, /Tests\s+echo tests ok → passed in /);
  assert.match(stdout, new RegExp(`Run dir\\s+${RUNS_DIR}/\\d{8}-\\d{6}-ttl-cache-previous`));
  assert.match(stdout, new RegExp(`Run dir\\s+${RUNS_DIR}/\\d{8}-\\d{6}-ttl-cache-candidate`));
  assert.match(stdout, /Final message: Added a TTL cache and wired it into the expensive read\./);

  // The comparison of the two sides closes the output.
  const tail = stdout.slice(stdout.lastIndexOf("harnessbench compare"));
  assert.match(tail, /^harnessbench compare {2}ttl-cache · code [0-9a-f]{7}/);
  assert.match(tail, /^warning: both sides ran the same harness/m);
  assert.match(tail, /Turns\s+7\s+→ 7\s+unchanged/);
  assert.doesNotMatch(stderr, /workspace kept/);
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

  // What each side's agent actually saw, in the workspaces --keep left behind.
  const kept = [...stderr.matchAll(/^workspace kept at (.+)$/gm)].map((match) => match[1] as string);
  assert.equal(kept.length, 2, stderr);
  const [previousTree, candidateTree] = kept.map((dir) => join(dir, "tree")) as [string, string];
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

  const { stdout } = ok(root, "run", "ttl-cache");

  const record = readRunRecord(runDir(root));
  assert.equal(record.outcome, "completed");
  assert.equal(record.tests?.exitCode, 1);
  assert.equal(record.tests?.timedOut, false);
  assert.match(readFileSync(join(runDir(root), "test.log"), "utf8"), /the suite is broken/);
  assert.match(stdout, /Tests\s+.*→ failed, exit 1/);
});

test("no test command means tests are not configured, and nothing is run", () => {
  const root = repoWithFake("fake-claude.sh", { testCommand: "" });

  const { stdout } = ok(root, "run", "ttl-cache");

  assert.equal(readRunRecord(runDir(root)).tests, null);
  assert.equal(existsSync(join(runDir(root), "test.log")), false);
  assert.match(stdout, /Tests\s+not configured/);
});

test("an agent that hangs is a timeout: exit 2, and the record is still written", () => {
  const root = repoWithFake("slow-claude.sh", { agent: { timeoutMinutes: 0.01 } });

  const { status, stdout } = cli(root, "run", "ttl-cache");

  assert.equal(status, 2);
  for (const dir of Object.values(runDirs(root))) {
    const record = readRunRecord(dir);
    assert.equal(record.outcome, "timeout");
    assert.equal(record.exitCode, null);
  }
  assert.match(stdout, /previous {2}→ timeout after /);
  assert.match(stdout, /candidate {2}→ timeout after /);
});

test("an agent that cannot start is an error: exit 3, explained by its stderr", () => {
  const root = repoWithFake("failing-claude.sh");

  const { status, stdout } = cli(root, "run", "ttl-cache");

  assert.equal(status, 3);
  const dir = runDir(root);
  assert.equal(readRunRecord(dir).outcome, "error");
  assert.equal(readFileSync(join(dir, "agent.stderr.log"), "utf8"), "claude: invalid API key\n");
  assert.match(stdout, /→ error after /);
  assert.match(stdout, /claude: invalid API key/);
});

test("--keep leaves the workspace behind and says where; without it the workspace is gone", () => {
  const kept = repoWithFake("fake-claude.sh");
  const { stderr } = ok(kept, "run", "ttl-cache", "--keep");
  const workspaces = [...stderr.matchAll(/^workspace kept at (.+)$/gm)].map((match) => match[1] as string);
  assert.equal(workspaces.length, 2, stderr);
  const dirs = runDirs(kept);
  for (const [i, environment] of (["previous", "candidate"] as const).entries()) {
    const workspace = workspaces[i] as string;
    assert.ok(existsSync(join(workspace, "tree", "agent-was-here.txt")), workspace);
    assert.ok(workspace.endsWith(readRunRecord(dirs[environment]).runId), workspace);
    // Run ids have one-second resolution: a kept workspace would collide with the next run.
    rmSync(workspace, { recursive: true, force: true });
  }

  const dropped = repoWithFake("fake-claude.sh");
  ok(dropped, "run", "ttl-cache");
  for (const dir of Object.values(runDirs(dropped))) {
    const runId = readRunRecord(dir).runId;
    assert.equal(existsSync(join(realpathSync(tmpdir()), "harnessbench", runId)), false);
  }
});

test("--json prints both run.json records, previous first, then the comparison", () => {
  const root = repoWithFake("fake-claude.sh");

  const { stdout } = ok(root, "run", "ttl-cache", "--json");

  const dirs = runDirs(root);
  const previous = readRunRecord(dirs.previous);
  const candidate = readRunRecord(dirs.candidate);
  assert.deepEqual(JSON.parse(stdout), [previous, candidate, compare(previous, candidate)]);
  assert.doesNotMatch(stdout, /Tool calls\s+2/);
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

test("run without credentials says which variables would do", () => {
  const { status, stderr } = failsWith(withoutCredentials(), repo(), "run", "ttl-cache");

  assert.equal(status, 1);
  assert.match(stderr, /no credentials for claude-code: set one of ANTHROPIC_API_KEY/);
});

test("run needs a fixture id", () => {
  const { status, stderr } = fails(repo(), "run");

  assert.equal(status, 2);
  assert.match(stderr, /run needs a fixture id/);
});
