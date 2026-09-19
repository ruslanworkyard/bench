import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { AgentConfig } from "../config.js";
import { createWorkspace, type Workspace } from "../workspace.js";
import { claudeCode } from "./claude-code.js";

/**
 * The real `claude` is never run here. Every test drives the adapter with a shell script
 * standing in for it, so what is under test is our end of the contract: the command line,
 * the environment, stdin, the raw stream on disk, and what the outcome is called.
 */

const hosts: string[] = [];
const scratches: string[] = [];
const workspaces: Workspace[] = [];
const OWN_ENV = ["FAKE_CLAUDE_STREAM", "FAKE_CLAUDE_DUMP", "ANTHROPIC_API_KEY", "LEAKED_SECRET"];
let runIds = 0;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "harnessbench",
  GIT_AUTHOR_EMAIL: "harnessbench@example.com",
  GIT_COMMITTER_NAME: "harnessbench",
  GIT_COMMITTER_EMAIL: "harnessbench@example.com",
};

/** A fake agent or a recorded stream, from test/fixtures. */
function fixture(name: string): string {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  if (name.endsWith(".sh")) chmodSync(path, 0o755); // Survives a checkout that lost the bit.
  return path;
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratches.push(dir);
  return dir;
}

/** A one-commit repository, cloned into a workspace the adapter can work in. */
async function workspace(): Promise<Workspace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-agent-host-")));
  hosts.push(root);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env: GIT_ENV });
  writeFileSync(join(root, "file.txt"), "version 1\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: root, env: GIT_ENV });

  const created = await createWorkspace({
    repoRoot: root,
    ref: "main",
    runId: `agent-test-${process.pid}-${runIds++}`,
  });
  workspaces.push(created);
  return created;
}

function config(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: "claude-code",
    command: "",
    model: null,
    maxTurns: null,
    timeoutMinutes: 1,
    args: [],
    env: [],
    ...overrides,
  };
}

function running(pattern: string): boolean {
  try {
    execFileSync("pgrep", ["-f", pattern], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  for (const ws of workspaces) await ws.destroy();
  for (const dir of [...hosts, ...scratches]) rmSync(dir, { recursive: true, force: true });
  for (const name of OWN_ENV) delete process.env[name];
});

test("a run reaches the agent, and its stream comes back whole", async () => {
  const ws = await workspace();
  const scratch = tempDir("harnessbench-agent-out-");
  const dump = join(scratch, "dump.txt");
  const rawOutputPath = join(scratch, "raw", "stream.jsonl");
  const stream = fixture("claude-stream.jsonl");

  process.env["FAKE_CLAUDE_STREAM"] = stream;
  process.env["FAKE_CLAUDE_DUMP"] = dump;
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  process.env["LEAKED_SECRET"] = "should not reach the agent";

  const result = await claudeCode.run({
    workspace: ws,
    prompt: "Add a TTL cache.\n",
    rawOutputPath,
    stderrPath: join(scratch, "agent.stderr.log"),
    config: config({
      command: fixture("fake-claude.sh"),
      model: "claude-opus-5",
      maxTurns: 12,
      args: ["--fake-extra"],
      env: ["FAKE_CLAUDE_STREAM", "FAKE_CLAUDE_DUMP"],
    }),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.model, "claude-opus-5");
  assert.equal(result.finalMessage, "Added a TTL cache and wired it into the expensive read.");
  assert.deepEqual(result.tokens, { input: 12, output: 345, cacheRead: 6789, cacheWrite: 1011 });
  assert.equal(result.costUsd, 0.4213);
  assert.equal(result.durationMs, 41234);
  assert.equal(result.turns, 7);
  assert.deepEqual(result.toolCalls, { Read: 1, Bash: 1 });
  assert.equal(result.toolFailures, 1);
  assert.equal(result.transcript.length, 6);

  // The stream is on disk exactly as the agent wrote it, before we made anything of it.
  assert.equal(readFileSync(rawOutputPath, "utf8"), readFileSync(stream, "utf8"));

  const seen = readFileSync(dump, "utf8");
  assert.match(
    seen,
    /^argv: -p --output-format stream-json --verbose --permission-mode bypassPermissions --model claude-opus-5 --max-turns 12 --fake-extra$/m,
  );
  assert.match(seen, new RegExp(`^cwd: ${ws.tree}$`, "m"));
  assert.match(seen, new RegExp(`^CLAUDE_CONFIG_DIR=${join(ws.dir, "claude-config")}$`, "m"));
  assert.match(seen, new RegExp(`^HOME=${ws.home}$`, "m"));
  assert.match(seen, /^ANTHROPIC_API_KEY=test-key$/m);
  assert.match(seen, /^CI=1$/m);
  assert.match(seen, /^DISABLE_TELEMETRY=1$/m);
  assert.match(seen, /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$/m);
  assert.doesNotMatch(seen, /LEAKED_SECRET/);

  assert.equal(readFileSync(`${dump}.stdin`, "utf8"), "Add a TTL cache.\n");

  const settings = join(ws.dir, "claude-config", "settings.json");
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { model: "claude-opus-5" });

  const diff = await ws.diff();
  assert.match(diff, /^\+\+\+ b\/agent-was-here\.txt$/m);
});

test("no model means no settings file and no --model", async () => {
  const ws = await workspace();
  const scratch = tempDir("harnessbench-agent-out-");
  const dump = join(scratch, "dump.txt");

  process.env["FAKE_CLAUDE_STREAM"] = fixture("claude-stream-no-result.jsonl");
  process.env["FAKE_CLAUDE_DUMP"] = dump;

  const result = await claudeCode.run({
    workspace: ws,
    prompt: "Go.\n",
    rawOutputPath: join(scratch, "raw.jsonl"),
    stderrPath: join(scratch, "agent.stderr.log"),
    config: config({
      command: fixture("fake-claude.sh"),
      env: ["FAKE_CLAUDE_STREAM", "FAKE_CLAUDE_DUMP"],
    }),
  });

  // No result event: the wall clock stands in, and the tokens nobody counted stay zero.
  assert.equal(result.outcome, "completed");
  assert.equal(result.turns, 2);
  assert.equal(result.costUsd, null);
  assert.ok(result.durationMs > 0 && result.durationMs < 60_000, `${result.durationMs}ms`);

  assert.equal(existsSync(join(ws.dir, "claude-config")), true);
  assert.equal(existsSync(join(ws.dir, "claude-config", "settings.json")), false);
  assert.doesNotMatch(readFileSync(dump, "utf8"), /--model|--max-turns/);
});

test("an agent that hangs is a timeout, and leaves nothing behind", async () => {
  const ws = await workspace();
  const scratch = tempDir("harnessbench-agent-out-");

  const result = await claudeCode.run({
    workspace: ws,
    prompt: "Go.\n",
    rawOutputPath: join(scratch, "raw.jsonl"),
    stderrPath: join(scratch, "agent.stderr.log"),
    config: config({ command: fixture("slow-claude.sh"), timeoutMinutes: 0.01 }),
  });

  assert.equal(result.outcome, "timeout");
  assert.equal(result.exitCode, null);
  assert.ok(result.durationMs >= 500 && result.durationMs < 10_000, `${result.durationMs}ms`);
  assert.equal(running("sleep 3137"), false);
  assert.deepEqual(result.transcript, [
    { type: "error", message: "timed out after 0.01 minutes" },
  ]);
});

test("an agent that exits non-zero is an error, explained by its stderr", async () => {
  const ws = await workspace();
  const scratch = tempDir("harnessbench-agent-out-");

  const result = await claudeCode.run({
    workspace: ws,
    prompt: "Go.\n",
    rawOutputPath: join(scratch, "raw.jsonl"),
    stderrPath: join(scratch, "logs", "agent.stderr.log"),
    config: config({ command: fixture("failing-claude.sh") }),
  });

  assert.equal(result.outcome, "error");
  // Its stderr is on disk whole, for the run directory to keep.
  assert.equal(readFileSync(join(scratch, "logs", "agent.stderr.log"), "utf8"), "claude: invalid API key\n");
  assert.equal(result.exitCode, 2);
  assert.equal(result.model, null);
  assert.equal(result.turns, 0);
  assert.equal(result.transcript.length, 1);
  assert.match(String(result.transcript[0]?.type), /error/);
  assert.match(
    (result.transcript[0] as { message: string }).message,
    /exited with code 2.*invalid API key/,
  );
});
