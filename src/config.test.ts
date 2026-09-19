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
