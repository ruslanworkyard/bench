import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import type { TranscriptEvent } from "../agents/types.js";
import { CONFIG_FILE, FIXTURES_DIR, JUDGES_DIR, RUNS_DIR, defaults, type Config } from "../config.js";
import { CliError } from "../errors.js";
import { modelJudge } from "../judge/judge.js";
import { packagedJudgesDir } from "../judges.js";
import type { ResolvedJudge } from "../preflight.js";
import { readRunRecord, writeRunRecord, type Environment, type RunRecord } from "../run-record.js";
import { judge, type JudgeDeps, type JudgeRecord } from "./judge.js";
import { run } from "./run.js";

/**
 * No model is ever called here. Refusals happen before any call, so they run through the CLI;
 * the judging itself runs in-process with the AI SDK's mock model handed in as the judge.
 */

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const KEY_ENV = "HARNESSBENCH_TEST_JUDGE_KEY";
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  [KEY_ENV]: "set",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "harnessbench",
  GIT_AUTHOR_EMAIL: "harnessbench@example.com",
  GIT_COMMITTER_NAME: "harnessbench",
  GIT_COMMITTER_EMAIL: "harnessbench@example.com",
};
delete ENV["HARNESSBENCH_JUDGE_MODEL"];
delete ENV["HARNESSBENCH_JUDGE_PROVIDER"];
// The in-process calls read process.env: the same environment the CLI subprocesses get.
Object.assign(process.env, ENV);

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** An initialised repository: config with a judge model, the packaged judges, one fixture. */
function repo(patch: Partial<Config["judge"]> = {}, judges = defaults().judges): string {
  const root = tempDir("harnessbench-judge-");
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: ENV });
  mkdirSync(join(root, RUNS_DIR), { recursive: true });
  const config: Config = {
    ...defaults(),
    judge: { ...defaults().judge, model: "claude-sonnet-4-5", apiKeyEnv: KEY_ENV, ...patch },
    judges,
  };
  writeFileSync(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  cpSync(packagedJudgesDir(), join(root, JUDGES_DIR), { recursive: true });
  const fixture = join(root, FIXTURES_DIR, "ttl-cache");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "fixture.json"), '{"id":"ttl-cache","kind":"feature","description":"d"}\n', "utf8");
  writeFileSync(join(fixture, "prompt.md"), "Add a TTL cache.\n", "utf8");
  return root;
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function record(stamp: string, environment: Environment, patch: Partial<RunRecord> = {}, fixture = "ttl-cache"): RunRecord {
  return {
    schema: 2,
    runId: `${stamp}-${fixture}-${environment}`,
    fixture,
    environment,
    headSha: HEAD,
    baseBranch: "main",
    harness: { ref: HEAD, sha: HEAD, files: ["CLAUDE.md"], hash: `${environment}-hash` },
    agent: { name: "claude-code", command: "claude", model: "claude-sonnet-4-5" },
    outcome: "completed",
    exitCode: 0,
    setup: null,
    startedAt: "2026-09-19T03:14:55.000Z",
    finishedAt: "2026-09-19T03:19:07.000Z",
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    costUsd: 0.4,
    durationMs: 240000,
    turns: 3,
    toolCalls: { Read: 1 },
    toolFailures: 0,
    diff: { files: 1, added: 1, removed: 0 },
    tests: { command: "npm test", exitCode: 0, durationMs: 12000, timedOut: false },
    finalMessage: "done",
    ...patch,
  };
}

type Side = { record?: Partial<RunRecord>; diff?: string; transcript?: TranscriptEvent[] };

const TRANSCRIPT: TranscriptEvent[] = [
  { type: "assistant", thread: "main", at: 100, turn: 0, text: "Reading the cache.", model: "claude-sonnet-4-5", usage: null },
  { type: "tool_call", thread: "main", at: 200, id: "t1", tool: "Read", input: { file_path: "src/cache.ts" }, kind: "read", path: "src/cache.ts" },
  { type: "tool_result", thread: "main", at: 300, id: "t1", isError: false, output: "..." },
];

/** Writes one side's run directory with everything a judge reads; returns its id. */
function write(root: string, stamp: string, environment: Environment, side: Side = {}, fixture = "ttl-cache"): string {
  const r = record(stamp, environment, side.record ?? {}, fixture);
  const dir = join(root, RUNS_DIR, r.runId);
  mkdirSync(dir, { recursive: true });
  writeRunRecord(dir, r);
  writeFileSync(join(dir, "diff.patch"), side.diff ?? `diff --git a/${environment}.ts b/${environment}.ts\n+${environment} change\n`, "utf8");
  writeFileSync(join(dir, "transcript.jsonl"), `${(side.transcript ?? TRANSCRIPT).map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return r.runId;
}

function writePair(root: string, stamp: string, sides: { previous?: Side; candidate?: Side } = {}, fixture = "ttl-cache"): [string, string] {
  return [write(root, stamp, "previous", sides.previous, fixture), write(root, stamp, "candidate", sides.candidate, fixture)];
}

function judgeDirs(root: string): string[] {
  return readdirSync(join(root, RUNS_DIR)).filter((name) => name.endsWith("-judge")).sort();
}

type Outcome = { status: number; stdout: string; stderr: string };

function cli(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Outcome {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A refusal: non-zero exit, and no judge directory left behind. */
function refuses(root: string, ...args: string[]): Outcome {
  return refusesWith(ENV, root, ...args);
}

function refusesWith(env: NodeJS.ProcessEnv, root: string, ...args: string[]): Outcome {
  const result = cli(root, env, "judge", ...args);
  assert.notEqual(result.status, 0, "expected judge to refuse");
  assert.deepEqual(judgeDirs(root), [], "a refusal must not leave a judge directory");
  return result;
}

// --- the mock model ---

type Reply = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

function reply(text: string): Reply {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    warnings: [],
  };
}

function verdict(preference: "A" | "B" | "tie", reason: string): Reply {
  return reply(JSON.stringify({ preference, reason }));
}

/** One mock model per judge call, each with its own scripted replies, and every target seen. */
function mocks(...perJudge: Reply[][]): JudgeDeps & { targets: ResolvedJudge[]; models: MockLanguageModelV4[] } {
  const targets: ResolvedJudge[] = [];
  const models: MockLanguageModelV4[] = [];
  return {
    targets,
    models,
    judgeFor(target) {
      targets.push(target);
      const model = new MockLanguageModelV4({ doGenerate: perJudge[targets.length - 1] ?? [] });
      models.push(model);
      return modelJudge(model);
    },
  };
}

/** Runs fn with console.log and console.error captured. */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { result, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function readJudgeRecord(root: string, dirName: string): JudgeRecord {
  return JSON.parse(readFileSync(join(root, RUNS_DIR, dirName, "judge.json"), "utf8")) as JudgeRecord;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// --- refusals ---

test("judge refuses a side that did not complete, naming the side and its outcome", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-100000", { candidate: { record: { outcome: "max_turns" } } });

  const { status, stderr } = refuses(root, previous, candidate);

  assert.equal(status, 1);
  assert.match(stderr, /candidate did not complete \(max_turns\); only a pair of completed runs is judged/);
});

test("judge refuses a pair compare would refuse, with compare's message", () => {
  const root = repo();
  const a = write(root, "20260918-100000", "candidate");
  const b = write(root, "20260919-100000", "candidate");
  assert.match(refuses(root, a, b).stderr, /one previous and one candidate run, got .* is candidate, .* is candidate/);

  const [previous] = writePair(root, "20260920-100000");
  const other = write(root, "20260920-100000", "candidate", { record: { headSha: "fedcba9876543210fedcba9876543210fedcba98" } }, "announcements");
  assert.match(refuses(root, previous, other).stderr, /different fixtures/);
});

test("judge refuses context over the size limit, naming the side, the item, its size and the limit", () => {
  const root = repo({ maxContextKb: 1 });
  const [previous, candidate] = writePair(root, "20260919-100000", {
    candidate: { diff: `+${"x".repeat(3 * 1024)}\n` },
  });

  const { status, stderr } = refuses(root, previous, candidate);

  assert.equal(status, 1);
  assert.match(stderr, /more output than a judge can read; the limit is 1 KB per item/);
  assert.match(stderr, /the candidate side's diff is 4 KB/);
  assert.doesNotMatch(stderr, /previous side's/);
  assert.match(stderr, /Narrow the fixture, or keep generated paths out of the diff/);
  assert.match(stderr, /Nothing is truncated/);
});

test("judge refuses when a judge has no model, and says where to set one", () => {
  const root = repo({ model: "" });
  const [previous, candidate] = writePair(root, "20260919-100000");

  const { status, stderr } = refuses(root, previous, candidate);

  assert.equal(status, 1);
  assert.match(stderr, /judge 'code-quality' has no model: set "judge\.model" in \.harnessbench\/config\.json/);
  assert.match(stderr, /HARNESSBENCH_JUDGE_MODEL/);
});

test("judge refuses when the key variable is unset, naming it", () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-100000");
  const env = { ...ENV };
  delete env[KEY_ENV];

  const { status, stderr } = refusesWith(env, root, previous, candidate);

  assert.equal(status, 1);
  assert.match(stderr, new RegExp(`no API key for judge 'code-quality' \\(anthropic\\): set ${KEY_ENV}`));
});

test("judge refuses an unknown judge id in the config, an empty list, and a run without artefacts", () => {
  const root = repo({}, ["code-quality", "vibes"]);
  const [previous, candidate] = writePair(root, "20260919-100000");
  assert.match(refuses(root, previous, candidate).stderr, /unknown judge 'vibes'[\s\S]*available judges:/);

  const empty = repo({}, []);
  const pair = writePair(empty, "20260919-100000");
  assert.match(refuses(empty, ...pair).stderr, /no judges configured/);

  const bare = repo();
  const [p, c] = writePair(bare, "20260919-100000");
  rmSync(join(bare, RUNS_DIR, c, "diff.patch"));
  assert.match(refuses(bare, p, c).stderr, new RegExp(`run '${c}' has no diff.patch`));
});

test("judge needs two ids or --fixture, and a repository with a config", () => {
  const root = repo();
  const [previous] = writePair(root, "20260919-100000");
  assert.equal(refuses(root).status, 2);
  assert.match(refuses(root, previous).stderr, /judge takes two run ids or none/);
  assert.match(refuses(root, "--fixture", "announcements").stderr, /no previous\/candidate run pair for fixture 'announcements'/);

  const bare = tempDir("harnessbench-judge-bare-");
  assert.match(cli(bare, ENV, "judge", "--fixture", "x").stderr, /inside a git repository/);
});

// --- judging with the mock model ---

test("judge runs every configured judge in order, writes judge.json and the per-judge files, and prints a line per verdict", async () => {
  const root = repo();
  const [previous, candidate] = writePair(root, "20260919-100000");
  const deps = mocks(
    [verdict("B", "B's diff adds a typed error; A's swallows it.")],
    [verdict("tie", "Both built and tested once.")],
    [verdict("A", "A's tests exercise the public surface.\nB's restate the implementation.")],
  );

  const { result, stdout } = await captured(() => judge({ cwd: root, runIds: [candidate, previous], json: false }, deps));

  // Every judge, in config order, each with the config's model; the key never leaves the environment.
  assert.deepEqual(
    deps.targets.map((target) => [target.provider, target.model, target.apiKeyEnv]),
    Array(3).fill(["anthropic", "claude-sonnet-4-5", KEY_ENV]),
  );

  const dirName = "20260919-100000-ttl-cache-judge";
  assert.deepEqual(judgeDirs(root), [dirName]);
  const stored = readJudgeRecord(root, dirName);
  assert.deepEqual(stored, result);
  assert.deepEqual(stored, {
    schema: 1,
    fixture: "ttl-cache",
    headSha: HEAD,
    previous: { runId: previous },
    candidate: { runId: candidate },
    mapping: { A: "previous", B: "candidate" },
    verdicts: [
      {
        judge: "code-quality",
        title: "Code quality",
        preference: "candidate",
        reason: "B's diff adds a typed error; A's swallows it.",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 100, output: 20 },
      },
      {
        judge: "engineering-practices",
        title: "Engineering practices",
        preference: "tie",
        reason: "Both built and tested once.",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 100, output: 20 },
      },
      {
        judge: "test-quality",
        title: "Test quality",
        preference: "previous",
        reason: "A's tests exercise the public surface.\nB's restate the implementation.",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 100, output: 20 },
      },
    ],
  });

  // What each judge was sent, and what came back, as files.
  for (const id of ["code-quality", "engineering-practices", "test-quality"]) {
    const dir = join(root, RUNS_DIR, dirName, id);
    const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
    assert.match(prompt, /^# System\n\n<!-- Draft rubric/);
    assert.match(prompt, /You are comparing two independent attempts, A and B/);
    assert.match(prompt, /# User\n\n# Task\n\nAdd a TTL cache\.\n\n# Attempt A\n\n## Diff\n\ndiff --git a\/previous\.ts/);
    assert.match(prompt, /# Attempt B\n\n## Diff\n\ndiff --git a\/candidate\.ts/);
    assert.equal(prompt.includes(previous), false, "run ids never reach the judge");
    const response = JSON.parse(readFileSync(join(dir, "response.json"), "utf8")) as { text: string; attempts: number };
    assert.equal(response.attempts, 1);
    assert.match(response.text, /"preference"/);
  }
  const practices = readFileSync(join(root, RUNS_DIR, dirName, "engineering-practices", "prompt.txt"), "utf8");
  assert.match(practices, /## Tool log\n\nread src\/cache\.ts/);
  const quality = readFileSync(join(root, RUNS_DIR, dirName, "code-quality", "prompt.txt"), "utf8");
  assert.doesNotMatch(quality, /## Tool log/);
  const tests = readFileSync(join(root, RUNS_DIR, dirName, "test-quality", "prompt.txt"), "utf8");
  assert.match(tests, /## Test result\n\npassed/);

  // The mock saw the system prompt as the system message and the context as the user message.
  const call = deps.models[0]?.doGenerateCalls[0];
  assert.equal(call?.prompt[0]?.role, "system");
  assert.match(String(call?.prompt[0]?.content), /Criterion: the quality of the code as written/);

  assert.match(stdout, /^harnessbench judge {2}ttl-cache · code 0123456\n/);
  assert.match(stdout, new RegExp(`Runs\\s+${previous} → ${candidate}`));
  assert.match(stdout, /Shown as\s+A = previous, B = candidate/);
  assert.match(stdout, /^Code quality {11}candidate preferred {3}B's diff adds a typed error; A's swallows it\.$/m);
  assert.match(stdout, /^Engineering practices {2}tie {19}Both built and tested once\.$/m);
  assert.match(stdout, /^Test quality {11}previous preferred {4}A's tests exercise the public surface\. B's restate the implementation\.$/m);
});

test("judge.json overrides the provider and model for its own judge only", async () => {
  const root = repo({}, ["code-quality", "test-quality"]);
  const path = join(root, JUDGES_DIR, "test-quality", "judge.json");
  const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...meta, provider: "openai", model: "gpt-5", apiKeyEnv: KEY_ENV }), "utf8");
  const [previous, candidate] = writePair(root, "20260919-100000");
  const deps = mocks([verdict("tie", "x")], [verdict("tie", "y")]);

  const { result } = await captured(() => judge({ cwd: root, runIds: [previous, candidate], json: true }, deps));

  assert.deepEqual(
    deps.targets.map((target) => [target.provider, target.model]),
    [
      ["anthropic", "claude-sonnet-4-5"],
      ["openai", "gpt-5"],
    ],
  );
  assert.deepEqual(
    result.verdicts.map((v) => [v.judge, v.provider, v.model]),
    [
      ["code-quality", "anthropic", "claude-sonnet-4-5"],
      ["test-quality", "openai", "gpt-5"],
    ],
  );
});

test("--json prints judge.json; re-judging replaces the directory", async () => {
  const root = repo({}, ["code-quality"]);
  const [previous, candidate] = writePair(root, "20260919-100000");

  const first = await captured(() => judge({ cwd: root, runIds: [previous, candidate], json: true }, mocks([verdict("A", "first")])));
  assert.deepEqual(JSON.parse(first.stdout), first.result);
  assert.equal(first.result.verdicts[0]?.preference, "previous");
  // Something in the directory that a second judging must not keep.
  writeFileSync(join(root, RUNS_DIR, "20260919-100000-ttl-cache-judge", "stale.txt"), "old", "utf8");

  const second = await captured(() => judge({ cwd: root, runIds: [previous, candidate], json: true }, mocks([verdict("B", "second")])));

  assert.deepEqual(judgeDirs(root), ["20260919-100000-ttl-cache-judge"]);
  assert.equal(readJudgeRecord(root, "20260919-100000-ttl-cache-judge").verdicts[0]?.reason, "second");
  assert.equal(second.result.verdicts[0]?.preference, "candidate");
  assert.equal(existsSync(join(root, RUNS_DIR, "20260919-100000-ttl-cache-judge", "stale.txt")), false);
});

test("a judge that never returns a valid verdict is a CliError naming it, with its reply kept and no judge.json", async () => {
  const root = repo({}, ["code-quality", "test-quality"]);
  const [previous, candidate] = writePair(root, "20260919-100000");
  const deps = mocks([reply("I prefer A."), reply('{"preference":"A"}')], [verdict("tie", "never reached")]);

  await assert.rejects(
    captured(() => judge({ cwd: root, runIds: [previous, candidate], json: false }, deps)),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /judge 'code-quality' did not return a verdict in the expected shape after two attempts/);
      assert.match(error.message, /its reply is kept in \.harnessbench\/runs\/20260919-100000-ttl-cache-judge\/code-quality\//);
      return true;
    },
  );

  const dir = join(root, RUNS_DIR, "20260919-100000-ttl-cache-judge");
  assert.equal(existsSync(join(dir, "judge.json")), false);
  const response = JSON.parse(readFileSync(join(dir, "code-quality", "response.json"), "utf8")) as { text: string; attempts: number };
  assert.equal(response.text, '{"preference":"A"}');
  assert.equal(response.attempts, 2);
  assert.ok(existsSync(join(dir, "code-quality", "prompt.txt")));
  assert.equal(deps.targets.length, 1, "the second judge never ran");
});

test("with --fixture, judge picks the latest pair and ignores -judge directories", async () => {
  const root = repo({}, ["code-quality"]);
  writePair(root, "20260918-100000");
  const [previous, candidate] = writePair(root, "20260919-100000");
  // An earlier judging, newer than the pair, is not a run; nor is a lone side or another fixture.
  mkdirSync(join(root, RUNS_DIR, "20260920-100000-ttl-cache-judge"));
  writeFileSync(join(root, RUNS_DIR, "20260920-100000-ttl-cache-judge", "judge.json"), "{}", "utf8");
  write(root, "20260921-100000", "candidate");
  writePair(root, "20260922-100000", {}, "announcements");

  const { result } = await captured(() => judge({ cwd: root, fixture: "ttl-cache", json: false }, mocks([verdict("tie", "same")])));

  assert.deepEqual([result.previous.runId, result.candidate.runId], [previous, candidate]);
  assert.deepEqual(judgeDirs(root), ["20260919-100000-ttl-cache-judge", "20260920-100000-ttl-cache-judge"]);
});

// --- run --judge ---

/** A fake agent or a recorded stream, from test/fixtures. */
function fixture(name: string): string {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  if (name.endsWith(".sh")) chmodSync(path, 0o755);
  return path;
}

/** A committed repository whose agent is the fake from test/fixtures, judges configured as given. */
function repoWithFakeAgent(judgePatch: Partial<Config["judge"]> = {}): string {
  const root = tempDir("harnessbench-run-judge-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: ENV, stdio: "ignore" });
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n", "utf8");
  const init = cli(root, ENV, "init", "--test", "echo tests ok", "--agent", "claude-code");
  assert.equal(init.status, 0, init.stderr);
  const path = join(root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  config.agent.command = fixture("fake-claude.sh");
  config.agent.env = ["FAKE_CLAUDE_STREAM", "FAKE_CLAUDE_DUMP"];
  config.judge = { ...config.judge, model: "claude-sonnet-4-5", apiKeyEnv: KEY_ENV, ...judgePatch };
  config.judges = ["code-quality", "test-quality"];
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  git("add", "-A");
  git("commit", "--quiet", "-m", "initial");
  return root;
}

// Fixtures other than ttl-cache: test files run in parallel, and run ids share $TMPDIR by the second.
const RUN_OPTIONS = { keep: false, json: false, judge: true };

test("run --judge judges the pair it just produced, after the comparison", async () => {
  // What the fake agent replays and needs; forwarded through config.agent.env.
  process.env["FAKE_CLAUDE_STREAM"] = fixture("claude-stream.jsonl");
  process.env["FAKE_CLAUDE_DUMP"] = join(tempDir("harnessbench-dump-"), "dump.txt");
  process.env["ANTHROPIC_API_KEY"] = "test-key"; // The agent's credential; preflight only checks it is set.
  const root = repoWithFakeAgent();
  const deps = mocks([verdict("B", "B's cache has a size limit.")], [verdict("tie", "Neither side added tests.")]);

  const { result: records, stdout, stderr } = await captured(() =>
    run({ cwd: root, fixtureId: "announcements", ...RUN_OPTIONS }, deps),
  );

  assert.equal(records.length, 2);
  const [previous, candidate] = records as [RunRecord, RunRecord];
  const dirs = judgeDirs(root);
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0], `${previous.runId.replace(/-previous$/, "")}-judge`);
  const stored = readJudgeRecord(root, dirs[0] as string);
  assert.deepEqual([stored.previous.runId, stored.candidate.runId], [previous.runId, candidate.runId]);
  assert.equal(stored.headSha, readRunRecord(join(root, RUNS_DIR, candidate.runId)).headSha);
  assert.deepEqual(
    stored.verdicts.map((v) => [v.judge, v.preference]),
    [
      ["code-quality", "candidate"],
      ["test-quality", "tie"],
    ],
  );
  // The judge saw the real artefacts: the fake agent's diff and the test result.
  const prompt = readFileSync(join(root, RUNS_DIR, dirs[0] as string, "test-quality", "prompt.txt"), "utf8");
  assert.match(prompt, /\+\+\+ b\/agent-was-here\.txt/);
  assert.match(prompt, /## Test result\n\npassed/);

  const compareAt = stdout.indexOf("harnessbench compare");
  const judgeAt = stdout.indexOf("harnessbench judge");
  assert.ok(compareAt > 0 && judgeAt > compareAt, "verdicts come after the comparison");
  assert.match(stdout, /Code quality {2}candidate preferred {3}B's cache has a size limit\./);
  assert.doesNotMatch(stderr, /judging skipped/);
});

test("run --judge on a refusal says judging was skipped and why, and the run is otherwise unchanged", async () => {
  process.env["FAKE_CLAUDE_STREAM"] = fixture("claude-stream.jsonl");
  process.env["FAKE_CLAUDE_DUMP"] = join(tempDir("harnessbench-dump-"), "dump.txt");
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  const root = repoWithFakeAgent({ model: "" });
  const deps = mocks([verdict("B", "never asked")]);

  const { result: records, stdout, stderr } = await captured(() =>
    run({ cwd: root, fixtureId: "holiday-api-client", ...RUN_OPTIONS, json: true }, deps),
  );

  assert.equal(records.length, 2);
  assert.deepEqual(judgeDirs(root), []);
  assert.equal(deps.targets.length, 0);
  assert.match(stderr, /^judging skipped: judge 'code-quality' has no model: set "judge\.model"/m);
  // --json still prints both records and the comparison, nothing more.
  const printed = JSON.parse(stdout) as unknown[];
  assert.equal(printed.length, 3);
});
