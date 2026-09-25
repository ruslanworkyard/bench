import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { claudeCode } from "./agents/claude-code.js";
import { CONFIG_FILE, FIXTURES_DIR, STATE_DIR, defaults } from "./config.js";
import { CliError } from "./errors.js";
import {
  requireAgent,
  requireAgentCommand,
  requireBaseBranch,
  requireConfig,
  requireCredentials,
  requireFixture,
  requireGit,
  requireHarnessSnapshot,
  requireJudgeKey,
  requireJudgeModel,
  requireMergeBase,
  requireRepo,
} from "./preflight.js";
import type { LoadedJudge } from "./judges.js";

const roots: string[] = [];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "harnessbench",
  GIT_AUTHOR_EMAIL: "harnessbench@example.com",
  GIT_COMMITTER_NAME: "harnessbench",
  GIT_COMMITTER_EMAIL: "harnessbench@example.com",
};

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, env: GIT_ENV, stdio: "ignore" });
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-preflight-")));
  roots.push(dir);
  return dir;
}

function write(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content, "utf8");
}

/** A repository on `main` with a committed CLAUDE.md and one unrelated file. */
function repo(): string {
  const root = tempDir();
  git(root, "init", "--quiet", "-b", "main");
  write(root, "CLAUDE.md", "# House rules\n");
  write(root, "src.txt", "code\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

function fixture(root: string, id: string, description: string): void {
  const dir = join(root, FIXTURES_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fixture.json"),
    `${JSON.stringify({ id, kind: "feature", description }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(dir, "prompt.md"), `Do ${id}.\n`, "utf8");
}

/** Asserts the thrown error is a CliError whose message matches. Returns it. */
function cliError(fn: () => unknown, pattern: RegExp): CliError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 1);
    return error;
  }
  return assert.fail("expected a CliError, but nothing was thrown");
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("requireGit passes when git is installed", () => {
  assert.doesNotThrow(() => requireGit());
});

test("requireRepo returns the root inside a repository, and throws outside one", () => {
  const root = repo();
  const nested = join(root, "packages", "api");
  mkdirSync(nested, { recursive: true });

  assert.equal(requireRepo(root), root);
  assert.equal(requireRepo(nested), root);

  cliError(() => requireRepo(tempDir()), /inside a git repository/);
});

test("requireConfig points at init when there is no config", () => {
  cliError(() => requireConfig(repo()), /no \.harnessbench\/config\.json .*harnessbench init/);
});

test("requireConfig reports malformed JSON", () => {
  const root = repo();
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  write(root, CONFIG_FILE, "{ not json");

  cliError(() => requireConfig(root), /is not valid JSON/);
});

test("requireConfig returns the config, defaults filled in", () => {
  const root = repo();
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  write(root, CONFIG_FILE, '{"baseBranch": "trunk", "agent": {"name": "claude-code"}}');

  assert.deepEqual(requireConfig(root), {
    ...defaults(),
    baseBranch: "trunk",
    agent: { ...defaults().agent, name: "claude-code" },
  });
});

test("requireAgent resolves an adapter, and lists them when the name is not one", () => {
  assert.equal(requireAgent("claude-code"), claudeCode);

  cliError(() => requireAgent(""), /no agent set - set "agent\.name"/);
  const error = cliError(() => requireAgent("clod"), /unknown agent 'clod'/);
  assert.match(error.message, /known agents: claude-code/);
});

test("requireAgentCommand prefers the configured command over the adapter's own", () => {
  const bin = tempDir();
  for (const name of ["claude", "claude-next"]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(path, 0o755);
  }
  const env = { PATH: bin };
  const agent = defaults().agent;

  assert.equal(requireAgentCommand(claudeCode, agent, env), join(bin, "claude"));
  assert.equal(
    requireAgentCommand(claudeCode, { ...agent, command: "claude-next" }, env),
    join(bin, "claude-next"),
  );

  const error = cliError(
    () => requireAgentCommand(claudeCode, { ...agent, command: "nowhere" }, env),
    /agent command 'nowhere' not found on PATH/,
  );
  assert.match(error.message, /"agent\.command"/);
});

test("requireAgentCommand takes a path to a binary as it is, without searching PATH", () => {
  const bin = tempDir();
  const script = join(bin, "fake-claude.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(script, 0o755);
  const agent = { ...defaults().agent, command: script };

  assert.equal(requireAgentCommand(claudeCode, agent, { PATH: "/nonexistent" }), script);

  cliError(
    () => requireAgentCommand(claudeCode, { ...agent, command: join(bin, "missing.sh") }, { PATH: bin }),
    /agent command '.*missing\.sh' not found/,
  );
});

test("requireCredentials accepts any one of the agent's variables, and names them all", () => {
  assert.doesNotThrow(() => requireCredentials(claudeCode, { ANTHROPIC_AUTH_TOKEN: "t" }));
  assert.doesNotThrow(() => requireCredentials(claudeCode, { CLAUDE_CODE_OAUTH_TOKEN: "t" }));

  const error = cliError(
    () => requireCredentials(claudeCode, { ANTHROPIC_API_KEY: "" }),
    /no credentials for claude-code: set one of/,
  );
  for (const name of claudeCode.credentialEnv) assert.match(error.message, new RegExp(name));
  assert.match(error.message, /in your environment or in \.harnessbench\/\.env/);
});

test("requireBaseBranch resolves an existing branch to a sha", () => {
  const root = repo();
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();

  assert.equal(requireBaseBranch(root, "main"), head);
});

test("requireBaseBranch names the branch it could not find", () => {
  const error = cliError(() => requireBaseBranch(repo(), "release/4.2"), /release\/4\.2/);
  assert.match(error.message, /--base/);
});

test("requireFixture reads the fixture, and lists what exists for an unknown id", () => {
  const root = repo();
  fixture(root, "ttl-cache", "In-process TTL cache");
  fixture(root, "announcements", "Persist in-app announcements");

  const loaded = requireFixture(root, "ttl-cache");
  assert.equal(loaded.fixture.description, "In-process TTL cache");
  assert.equal(loaded.prompt, "Do ttl-cache.\n");
  assert.equal(loaded.dir, join(root, FIXTURES_DIR, "ttl-cache"));

  const error = cliError(() => requireFixture(root, "nope"), /unknown fixture 'nope'/);
  assert.match(error.message, /available fixtures:\n {2}announcements\n {2}ttl-cache/);
});

test("requireMergeBase finds where the branch left main, and explains when there is none", () => {
  const root = repo();
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  git(root, "checkout", "--quiet", "-b", "feature");
  write(root, "CLAUDE.md", "# House rules, revised\n");
  git(root, "commit", "--quiet", "-am", "revise");

  assert.equal(requireMergeBase(root, "main"), base);

  git(root, "checkout", "--quiet", "--orphan", "unrelated");
  git(root, "commit", "--quiet", "-m", "fresh start");
  cliError(() => requireMergeBase(root, "main"), /no merge base between 'main' and HEAD.*--base/s);
});

test("requireHarnessSnapshot returns the snapshot, and names a ref that is not a commit", () => {
  const root = repo();

  const snapshot = requireHarnessSnapshot(root, "HEAD", []);
  assert.deepEqual(snapshot.files, ["CLAUDE.md"]);
  assert.match(snapshot.sha, /^[0-9a-f]{40}$/);

  cliError(() => requireHarnessSnapshot(root, "nope", []), /'nope' is not a commit/);
});

/** A judge as `judges.ts` would load it, with the given overrides. */
function judge(overrides: Partial<LoadedJudge["meta"]> = {}): LoadedJudge {
  return {
    dir: "",
    rubric: "",
    hash: "",
    meta: {
      id: "code-quality",
      title: "Code quality",
      description: "d",
      prompt: "prompt.md",
      context: ["prompt", "diff"],
      provider: null,
      model: null,
      apiKeyEnv: null,
      providerOptions: null,
      ...overrides,
    },
  };
}

const JUDGE_CONFIG = { ...defaults().judge, model: "claude-sonnet-4-5" };

test("requireJudgeModel resolves environment over judge.json over config, and the conventional key variable", () => {
  assert.deepEqual(requireJudgeModel(judge(), JUDGE_CONFIG, {}), {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "",
    structuredOutputs: true,
    providerOptions: {},
    timeoutSeconds: 180,
  });

  const overridden = judge({ provider: "openai", model: "gpt-5", apiKeyEnv: "TEAM_OPENAI_KEY" });
  assert.deepEqual(requireJudgeModel(overridden, JUDGE_CONFIG, {}), {
    provider: "openai",
    model: "gpt-5",
    apiKeyEnv: "TEAM_OPENAI_KEY",
    baseUrl: "",
    structuredOutputs: true,
    providerOptions: {},
    timeoutSeconds: 180,
  });

  const env = { HARNESSBENCH_JUDGE_PROVIDER: "google", HARNESSBENCH_JUDGE_MODEL: "gemini-3-pro" };
  const fromEnv = requireJudgeModel(overridden, JUDGE_CONFIG, env);
  assert.equal(fromEnv.provider, "google");
  assert.equal(fromEnv.model, "gemini-3-pro");
  assert.equal(fromEnv.apiKeyEnv, "TEAM_OPENAI_KEY"); // judge.json still names the variable.
  assert.equal(requireJudgeModel(judge(), { ...JUDGE_CONFIG, provider: "google" }, {}).apiKeyEnv, "GOOGLE_GENERATIVE_AI_API_KEY");
  assert.equal(requireJudgeModel(judge(), { ...JUDGE_CONFIG, apiKeyEnv: "MY_KEY" }, {}).apiKeyEnv, "MY_KEY");
  // An empty environment variable is "not set", not an override.
  assert.equal(requireJudgeModel(judge(), JUDGE_CONFIG, { HARNESSBENCH_JUDGE_MODEL: "" }).model, "claude-sonnet-4-5");
});

test("requireJudgeModel refuses a missing model, a bad provider override, and openai-compatible without a URL", () => {
  const error = cliError(() => requireJudgeModel(judge(), defaults().judge, {}), /judge 'code-quality' has no model/);
  assert.match(error.message, /"judge\.model" in \.harnessbench\/config\.json/);
  assert.match(error.message, /"model" in \.harnessbench\/judges\/code-quality\/judge\.json/);
  assert.match(error.message, /HARNESSBENCH_JUDGE_MODEL/);

  cliError(
    () => requireJudgeModel(judge(), JUDGE_CONFIG, { HARNESSBENCH_JUDGE_PROVIDER: "bedrock" }),
    /HARNESSBENCH_JUDGE_PROVIDER is 'bedrock'; judge providers are anthropic, openai, google, openai-compatible/,
  );

  const compatible = { ...JUDGE_CONFIG, provider: "openai-compatible" as const };
  cliError(() => requireJudgeModel(judge(), compatible, {}), /openai-compatible provider, which needs "judge\.baseUrl"/);
  const resolved = requireJudgeModel(judge(), { ...compatible, baseUrl: "http://localhost:11434/v1" }, {});
  assert.equal(resolved.baseUrl, "http://localhost:11434/v1");
  assert.equal(resolved.structuredOutputs, true);
  const plain = requireJudgeModel(
    judge(),
    { ...compatible, baseUrl: "http://localhost:11434/v1", structuredOutputs: false },
    {},
  );
  assert.equal(plain.structuredOutputs, false);
  assert.equal(resolved.apiKeyEnv, "OPENAI_API_KEY");
});

test("requireJudgeKey checks only that the variable is set, and names it when it is not", () => {
  const resolved = requireJudgeModel(judge(), JUDGE_CONFIG, {});
  requireJudgeKey(judge(), resolved, { ANTHROPIC_API_KEY: "sk-test" });
  const error = cliError(() => requireJudgeKey(judge(), resolved, { ANTHROPIC_API_KEY: "" }), /no API key for judge 'code-quality' \(anthropic\): set ANTHROPIC_API_KEY/);
  assert.match(error.message, /"judge\.apiKeyEnv"/);
  assert.match(error.message, /set ANTHROPIC_API_KEY in your environment or in \.harnessbench\/\.env/);
});
