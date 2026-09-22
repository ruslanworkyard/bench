import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ENV_FILE } from "./config.js";
import { loadEnvFile } from "./env.js";
import { CliError } from "./errors.js";

const roots: string[] = [];

function repoWithEnv(contents: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "harnessbench-env-"));
  roots.push(root);
  mkdirSync(join(root, ".harnessbench"), { recursive: true });
  if (contents !== null) writeFileSync(join(root, ENV_FILE), contents, "utf8");
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("variables come from the file, and one already in the environment is not overridden", () => {
  const root = repoWithEnv("ANTHROPIC_API_KEY=from-file\nOPENAI_API_KEY=also-from-file\n");
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "from-shell" };

  const set = loadEnvFile(root, env);

  assert.deepEqual(set, ["OPENAI_API_KEY"]);
  assert.equal(env["ANTHROPIC_API_KEY"], "from-shell");
  assert.equal(env["OPENAI_API_KEY"], "also-from-file");
});

test("quoted values, export prefixes, comments and blank lines parse", () => {
  const root = repoWithEnv(
    [
      "# the agent",
      "",
      'ANTHROPIC_API_KEY="sk-with spaces"',
      "export OPENAI_API_KEY='single quoted'",
      "GOOGLE_GENERATIVE_AI_API_KEY=plain # trailing comment",
      'MULTI="first',
      'second"',
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {};

  const set = loadEnvFile(root, env).sort();

  assert.deepEqual(set, ["ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MULTI", "OPENAI_API_KEY"]);
  assert.equal(env["ANTHROPIC_API_KEY"], "sk-with spaces");
  assert.equal(env["OPENAI_API_KEY"], "single quoted");
  assert.equal(env["GOOGLE_GENERATIVE_AI_API_KEY"], "plain");
  assert.equal(env["MULTI"], "first\nsecond");
});

test("a missing file sets nothing", () => {
  const env: NodeJS.ProcessEnv = { KEEP: "1" };

  assert.deepEqual(loadEnvFile(repoWithEnv(null), env), []);
  assert.deepEqual(env, { KEEP: "1" });
});

test("a malformed file is a CliError naming the file and the line number, never the contents", () => {
  const root = repoWithEnv("ANTHROPIC_API_KEY=sk-fine\nsk-pasted-without-a-name\n");
  const env: NodeJS.ProcessEnv = {};

  assert.throws(
    () => loadEnvFile(root, env),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /\.harnessbench\/\.env/);
      assert.match(error.message, /line 2/);
      assert.doesNotMatch(error.message, /sk-/);
      return true;
    },
  );
  assert.deepEqual(env, {}, "nothing is set from a file that is refused");
});
