import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { CONFIG_FILE, ENV_EXAMPLE_FILE, type Config } from "../config.js";
import { listFixtures, packagedFixturesDir } from "../fixtures.js";
import { packagedJudgesDir } from "../judges.js";
import type { Report } from "../print.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const roots: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-init-")));
  roots.push(dir);
  return dir;
}

/** A git repository whose only harness file is a CLAUDE.md. */
function repo(): string {
  const root = tempDir();
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
  writeFileSync(join(root, "CLAUDE.md"), "# House rules\n", "utf8");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");
  return root;
}

function run(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, "init", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    // Piped, not echoed: a test that expects a failure should not print it to the terminal.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runJson(cwd: string, ...args: string[]): Report {
  return JSON.parse(run(cwd, "--json", ...args)) as Report;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("init sets up a repository, and a second run changes nothing", () => {
  const root = repo();
  const fixtureIds = listFixtures(packagedFixturesDir()).map((fixture) => fixture.id);
  assert.ok(fixtureIds.length > 0, "the package should ship fixtures");
  const judgeIds = listFixtures(packagedJudgesDir()).map((judge) => judge.id);
  assert.deepEqual(judgeIds, ["code-quality", "engineering-practices", "test-quality"]);

  const first = runJson(root, "--test", "npm test", "--agent", "claude-code");

  assert.deepEqual(first.harness, [{ path: "CLAUDE.md", source: "convention" }]);
  assert.deepEqual(first.testCommand, { value: "npm test", source: "--test flag" });
  assert.deepEqual(first.agent, { value: "claude-code", source: "--agent flag" });
  assert.deepEqual(first.baseBranch, {
    value: "main",
    source: "current branch main (no commits yet)",
  });
  assert.deepEqual(first.fixtures, { added: fixtureIds, present: [] });
  assert.deepEqual(first.judges, { added: judgeIds, present: [] });
  assert.deepEqual(first.files, [
    { path: ".harnessbench", status: "created" },
    { path: ".harnessbench/fixtures", status: "created" },
    { path: ".harnessbench/judges", status: "created" },
    { path: CONFIG_FILE, status: "created" },
    { path: ENV_EXAMPLE_FILE, status: "created" },
    { path: ".gitignore", status: "appended" },
  ]);
  assert.equal(first.dryRun, false);

  const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as Config;
  assert.deepEqual(config, {
    baseBranch: "main",
    testCommand: "npm test",
    testFiles: [],
    testLabel: "Agent's tests",
    setupCommand: "",
    agent: {
      name: "claude-code",
      command: "claude",
      model: null,
      maxTurns: null,
      timeoutMinutes: 20,
      args: [],
      env: [],
    },
    harness: { extraPaths: [] },
    judge: { provider: "anthropic", model: "", apiKeyEnv: "", baseUrl: "", structuredOutputs: true, maxContextKb: 512 },
    judges: ["code-quality", "engineering-practices", "test-quality"],
  });

  for (const id of fixtureIds) {
    const copied = join(root, ".harnessbench", "fixtures", id, "fixture.json");
    const packaged = join(packagedFixturesDir(), id, "fixture.json");
    assert.equal(readFileSync(copied, "utf8"), readFileSync(packaged, "utf8"));
  }
  for (const id of judgeIds) {
    for (const file of ["judge.json", "prompt.md"]) {
      const copied = join(root, ".harnessbench", "judges", id, file);
      const packaged = join(packagedJudgesDir(), id, file);
      assert.equal(readFileSync(copied, "utf8"), readFileSync(packaged, "utf8"));
    }
  }

  assert.equal(
    readFileSync(join(root, ".gitignore"), "utf8"),
    "node_modules/\n.harnessbench/runs/\n.harnessbench/.env\n",
  );

  const second = runJson(root, "--test", "npm test", "--agent", "claude-code");

  assert.deepEqual(second.fixtures, { added: [], present: fixtureIds });
  assert.deepEqual(second.judges, { added: [], present: judgeIds });
  assert.deepEqual(second.files, [
    { path: ".harnessbench", status: "present" },
    { path: ".harnessbench/fixtures", status: "present" },
    { path: ".harnessbench/judges", status: "present" },
    { path: CONFIG_FILE, status: "skipped" },
    { path: ENV_EXAMPLE_FILE, status: "skipped" },
    { path: ".gitignore", status: "present" },
  ]);
  assert.equal(
    readFileSync(join(root, ".gitignore"), "utf8"),
    "node_modules/\n.harnessbench/runs/\n.harnessbench/.env\n",
    "the second init adds nothing to .gitignore",
  );
});

test("a repository initialised before .env existed gets the gitignore line on the next init", () => {
  const root = repo();
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.harnessbench/runs/\n", "utf8");

  const report = runJson(root, "--test", "npm test", "--agent", "claude-code");

  assert.ok(report.files.some((file) => file.path === ".gitignore" && file.status === "appended"));
  assert.equal(
    readFileSync(join(root, ".gitignore"), "utf8"),
    "node_modules/\n.harnessbench/runs/\n.harnessbench/.env\n",
  );
});

test(".env.example lists the agent's and judge's variables, every line a comment, and is never overwritten", () => {
  const root = repo();
  run(root, "--test", "npm test", "--agent", "claude-code");

  const example = readFileSync(join(root, ENV_EXAMPLE_FILE), "utf8");
  for (const line of example.split("\n")) {
    assert.ok(line === "" || line.startsWith("#"), `not a comment: ${JSON.stringify(line)}`);
  }
  const names = [...example.matchAll(/^# ([A-Z_]+)=$/gm)].map((match) => match[1]);
  assert.deepEqual(names, [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]);
  assert.match(example, /claude setup-token/);

  writeFileSync(join(root, ENV_EXAMPLE_FILE), "# mine\n", "utf8");
  const second = runJson(root, "--test", "npm test", "--agent", "claude-code");
  assert.ok(second.files.some((file) => file.path === ENV_EXAMPLE_FILE && file.status === "skipped"));
  assert.equal(readFileSync(join(root, ENV_EXAMPLE_FILE), "utf8"), "# mine\n");
});

test(".env.example follows the judge in an existing config", () => {
  const root = repo();
  run(root, "--test", "npm test", "--agent", "claude-code");
  const path = join(root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  config.judge.provider = "openai";
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  rmSync(join(root, ENV_EXAMPLE_FILE));

  run(root, "--test", "npm test", "--agent", "claude-code");

  const example = readFileSync(join(root, ENV_EXAMPLE_FILE), "utf8");
  assert.match(example, /^# OPENAI_API_KEY=$/m);
  assert.match(example, /^# ANTHROPIC_API_KEY=$/m, "the agent's variables are still listed");
});

test("a lockfile gives the config its setup command; --setup overrides it", () => {
  const detected = repo();
  writeFileSync(join(detected, "package-lock.json"), "{}\n", "utf8");

  const report = runJson(detected, "--test", "npm test");

  assert.deepEqual(report.setupCommand, { value: "npm ci", source: "package-lock.json" });
  const config = JSON.parse(readFileSync(join(detected, CONFIG_FILE), "utf8")) as Config;
  assert.equal(config.setupCommand, "npm ci");
  assert.match(run(repo(), "--setup", "make deps"), /Setup command\s+make deps\s+--setup flag/);

  const overridden = repo();
  writeFileSync(join(overridden, "package-lock.json"), "{}\n", "utf8");
  runJson(overridden, "--setup", "make deps");
  const config2 = JSON.parse(readFileSync(join(overridden, CONFIG_FILE), "utf8")) as Config;
  assert.equal(config2.setupCommand, "make deps");
});

test("detected test files and a per-file test command land in a new config, and the summary says so", () => {
  const root = repo();
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"jest"},"devDependencies":{"jest":"^29"}}\n', "utf8");

  const report = runJson(root);

  assert.deepEqual(report.testCommand, { value: "npx jest {files}", source: "package.json scripts.test" });
  assert.deepEqual(report.testFiles, { value: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"], source: "package.json" });
  const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as Config;
  assert.equal(config.testCommand, "npx jest {files}");
  assert.deepEqual(config.testFiles, ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"]);

  const output = run(root, "--dry-run");
  assert.match(output, /Test command\s+npx jest \{files\}\s+package\.json scripts\.test/);
  assert.match(output, /Test files\s+\*\*\/\*\.test\.\* \*\*\/\*\.spec\.\* \*\*\/__tests__\/\*\*\s+package\.json/);
  assert.doesNotMatch(output, /fast mode not detected/);
});

test("the summary prints the hint when fast mode was not detected", () => {
  const root = repo();
  writeFileSync(join(root, "package.json"), '{"scripts":{"pretest":"npm run build","test":"node --test dist/"}}\n', "utf8");

  const output = run(root);

  assert.match(output, /Test command\s+npm test\s+package\.json scripts\.test\n\s+fast mode not detected: scripts\.pretest builds before the tests/);
  const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as Config;
  assert.equal(config.testCommand, "npm test");
});

test("--test-files overrides the detected globs, and repeats", () => {
  const root = repo();
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"jest"}}\n', "utf8");

  const report = runJson(root, "--test-files", "src/**/*.test.ts", "--test-files", "e2e/*.spec.ts");

  assert.deepEqual(report.testFiles, { value: ["src/**/*.test.ts", "e2e/*.spec.ts"], source: "--test-files flag" });
  const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as Config;
  assert.deepEqual(config.testFiles, ["src/**/*.test.ts", "e2e/*.spec.ts"]);
});

test("an existing config keeps its test command and test files", () => {
  const root = repo();
  run(root, "--test", "make check", "--test-files", "t/*.t");
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"jest"}}\n', "utf8");
  const before = readFileSync(join(root, CONFIG_FILE), "utf8");

  run(root);

  assert.equal(readFileSync(join(root, CONFIG_FILE), "utf8"), before);
  const config = JSON.parse(before) as Config;
  assert.equal(config.testCommand, "make check");
  assert.deepEqual(config.testFiles, ["t/*.t"]);
});

test("init on a repository whose config predates setupCommand still loads it", () => {
  const root = repo();
  writeFileSync(join(root, ".harnessbench"), "", "utf8");
  rmSync(join(root, ".harnessbench"));
  run(root, "--test", "npm test");
  const path = join(root, CONFIG_FILE);
  const { setupCommand: _dropped, ...older } = JSON.parse(readFileSync(path, "utf8")) as Config;
  writeFileSync(path, `${JSON.stringify(older, null, 2)}\n`, "utf8");

  const report = runJson(root, "--test", "npm test");

  assert.ok(report.files.some((file) => file.path === CONFIG_FILE && file.status === "skipped"));
});

test("--dry-run writes nothing", () => {
  const root = repo();

  const report = runJson(root, "--dry-run");

  assert.equal(report.dryRun, true);
  assert.ok(report.fixtures.added.length > 0);
  assert.ok(!existsSync(join(root, ".harnessbench")));
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\n");
});

test("a repository with nothing to detect warns instead of failing", () => {
  const root = repo();

  const report = runJson(root);

  assert.equal(report.testCommand, null);
  assert.ok(
    report.warnings.some((warning) => warning.startsWith("no test command detected")),
    `expected a test command warning, got ${JSON.stringify(report.warnings)}`,
  );
  // Whether an agent is installed depends on the machine; either way init succeeds.
  if (report.agent === null) {
    assert.ok(report.warnings.some((warning) => warning.startsWith("no agent found on PATH")));
  } else {
    assert.equal(report.agent.source, "PATH");
  }
});

test("the human summary reports what was found and what to do next", () => {
  const output = run(repo(), "--test", "npm test", "--agent", "claude-code");

  assert.match(output, /CLAUDE\.md\s+convention/);
  assert.match(output, /Test command\s+npm test\s+--test flag/);
  assert.match(output, /Setup command\s+none detected \(set setupCommand if the agent needs dependencies installed\)/);
  assert.match(output, /Base branch\s+main\s+current branch main/);
  assert.match(output, /Judges\s+added: code-quality, engineering-practices, test-quality/);
  assert.match(output, /^credentials: \.harnessbench\/\.env \(gitignored; see \.env\.example\)$/m);
  assert.match(output, /Next: harnessbench run/);
});

test("a judge the repository already has is left alone; the others are still copied", () => {
  const root = repo();
  const own = join(root, ".harnessbench", "judges", "code-quality");
  execFileSync("mkdir", ["-p", own]);
  writeFileSync(join(own, "prompt.md"), "my own rubric\n", "utf8");

  const report = runJson(root, "--test", "npm test");

  assert.deepEqual(report.judges, { added: ["engineering-practices", "test-quality"], present: ["code-quality"] });
  assert.equal(readFileSync(join(own, "prompt.md"), "utf8"), "my own rubric\n");
  assert.ok(!existsSync(join(own, "judge.json")));
  assert.ok(existsSync(join(root, ".harnessbench", "judges", "test-quality", "judge.json")));
});

test("an unknown --agent is refused, so no config that cannot run is written", () => {
  const root = repo();

  assert.throws(
    () => run(root, "--agent", "clod"),
    (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /unknown agent 'clod' - known agents: claude-code/);
      return true;
    },
  );
  assert.ok(!existsSync(join(root, CONFIG_FILE)));
});

test("outside a git repository init fails with exit code 1", () => {
  const root = tempDir();

  assert.throws(
    () => run(root),
    (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /inside a git repository/);
      return true;
    },
  );
});

test("an unusable config is reported clearly", () => {
  const root = repo();
  run(root);
  writeFileSync(join(root, CONFIG_FILE), '{"agent": {"timeoutMinutes": "soon"}}', "utf8");

  assert.throws(
    () => run(root),
    (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /"agent\.timeoutMinutes" must be a positive number/);
      return true;
    },
  );
});
