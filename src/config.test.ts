import assert from "node:assert/strict";
import { test } from "node:test";

import { defaults, validate } from "./config.js";
import { CliError } from "./errors.js";

/** Asserts validate() rejects this config, with a message that names what is wrong. */
function rejects(value: unknown, pattern: RegExp): void {
  try {
    validate(value);
  } catch (error) {
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return;
  }
  assert.fail("expected validate to throw");
}

test("an empty config is all defaults", () => {
  assert.deepEqual(validate({}), defaults());
  assert.deepEqual(validate({}).agent, {
    name: "",
    command: "",
    model: null,
    maxTurns: null,
    timeoutMinutes: 20,
    args: [],
    env: [],
  });
});

test("a config without setupCommand loads as no setup; with it, the command round-trips", () => {
  const before = { baseBranch: "main", testCommand: "npm test" };
  assert.equal(validate(before).setupCommand, "");
  assert.equal(validate({ ...before, setupCommand: "npm ci" }).setupCommand, "npm ci");
  rejects({ setupCommand: ["npm", "ci"] }, /"setupCommand" must be a string, found an array/);
});

test("a config without a judge block loads with the judge defaults; a full block round-trips", () => {
  const older = validate({ baseBranch: "main", testCommand: "npm test" });
  assert.deepEqual(older.judge, {
    provider: "anthropic",
    model: "",
    apiKeyEnv: "",
    baseUrl: "",
    structuredOutputs: true,
    maxContextKb: 512,
  });
  assert.deepEqual(older.judges, ["code-quality", "engineering-practices", "test-quality"]);

  const judge = {
    provider: "openai-compatible",
    model: "llama-3.3-70b",
    apiKeyEnv: "LOCAL_KEY",
    baseUrl: "http://localhost:11434/v1",
    structuredOutputs: false,
    maxContextKb: 64,
  };
  assert.deepEqual(validate({ judge, judges: ["code-quality"] }).judge, judge);
  assert.deepEqual(validate({ judge, judges: ["code-quality"] }).judges, ["code-quality"]);
  assert.deepEqual(validate({ judges: [] }).judges, []);
});

test("the judge block's types are checked", () => {
  rejects({ judge: "anthropic" }, /"judge" must be an object, found a string/);
  rejects({ judge: { provider: "bedrock" } }, /"judge\.provider" must be one of anthropic, openai, google, openai-compatible, found "bedrock"/);
  rejects({ judge: { model: null } }, /"judge\.model" must be a string, found null/);
  rejects({ judge: { maxContextKb: 0 } }, /"judge\.maxContextKb" must be a positive number/);
  rejects({ judge: { structuredOutputs: "yes" } }, /"judge\.structuredOutputs" must be true or false, found a string/);
  rejects({ judge: { baseURL: "x" } }, /unknown key "judge\.baseURL"/);
  rejects({ judges: "code-quality" }, /"judges" must be an array of strings/);
});

test("a full agent block survives validation unchanged", () => {
  const agent = {
    name: "claude-code",
    command: "/usr/local/bin/claude",
    model: "claude-opus-5",
    maxTurns: 40,
    timeoutMinutes: 5,
    args: ["--debug"],
    env: ["MY_PROXY"],
  };

  assert.deepEqual(validate({ agent }).agent, agent);
});

test("an unknown key is named, at every level", () => {
  rejects({ timeoutMinutes: 20 }, /unknown key "timeoutMinutes"/);
  rejects({ agnet: "claude-code" }, /unknown key "agnet"/);
  rejects({ agent: { name: "claude-code", maxTokens: 10 } }, /unknown key "agent\.maxTokens"/);
  rejects({ harness: { extra: [] } }, /unknown key "harness\.extra"/);
});

test("the agent block's types are checked", () => {
  rejects({ agent: "claude" }, /"agent" must be an object, found a string/);
  rejects({ agent: { env: "MY_PROXY" } }, /"agent\.env" must be an array of strings/);
  rejects({ agent: { env: ["MY_PROXY", 3] } }, /"agent\.env" must be an array of strings/);
  rejects({ agent: { args: [null] } }, /"agent\.args" must be an array of strings/);
  rejects({ agent: { model: 5 } }, /"agent\.model" must be a string or null/);
  rejects({ agent: { maxTurns: 1.5 } }, /"agent\.maxTurns" must be a positive integer or null/);
  rejects({ agent: { maxTurns: 0 } }, /"agent\.maxTurns" must be a positive integer or null/);
  rejects({ agent: { timeoutMinutes: "soon" } }, /"agent\.timeoutMinutes" must be a positive number/);
  rejects({ agent: { timeoutMinutes: 0 } }, /"agent\.timeoutMinutes" must be a positive number/);
  rejects({ agent: { name: 1 } }, /"agent\.name" must be a string/);
});

test("the rest of the config is checked too", () => {
  rejects([], /expected a JSON object, found an array/);
  rejects({ baseBranch: "  " }, /"baseBranch" must not be empty/);
  rejects({ testCommand: 7 }, /"testCommand" must be a string/);
  rejects({ harness: { extraPaths: [7] } }, /"harness\.extraPaths" must be an array of strings/);
});
