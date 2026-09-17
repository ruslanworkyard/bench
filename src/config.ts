import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "./errors.js";
import type { FileOp } from "./plan.js";

export const STATE_DIR = ".harnessbench";
export const FIXTURES_DIR = `${STATE_DIR}/fixtures`;
export const RUNS_DIR = `${STATE_DIR}/runs`;
export const CONFIG_FILE = `${STATE_DIR}/config.json`;

export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_TIMEOUT_MINUTES = 20;

export type Config = {
  baseBranch: string;
  testCommand: string;
  agent: string;
  timeoutMinutes: number;
  harness: { extraPaths: string[] };
};

export function defaults(): Config {
  return {
    baseBranch: DEFAULT_BASE_BRANCH,
    testCommand: "",
    agent: "",
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    harness: { extraPaths: [] },
  };
}

export function configPath(root: string): string {
  return join(root, CONFIG_FILE);
}

function fail(message: string): never {
  throw new CliError(`${CONFIG_FILE}: ${message}`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/** Checks a parsed config, filling in defaults for anything absent. */
export function validate(value: unknown): Config {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`expected a JSON object, found ${describe(value)}`);
  }
  const raw = value as Record<string, unknown>;
  const config = defaults();

  for (const key of ["baseBranch", "testCommand", "agent"] as const) {
    const field = raw[key];
    if (field === undefined) continue;
    if (typeof field !== "string") fail(`"${key}" must be a string, found ${describe(field)}`);
    config[key] = field;
  }
  if (config.baseBranch.trim() === "") fail('"baseBranch" must not be empty');

  const timeout = raw["timeoutMinutes"];
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      fail(`"timeoutMinutes" must be a positive number, found ${describe(timeout)}`);
    }
    config.timeoutMinutes = timeout;
  }

  const harness = raw["harness"];
  if (harness !== undefined) {
    if (typeof harness !== "object" || harness === null || Array.isArray(harness)) {
      fail(`"harness" must be an object, found ${describe(harness)}`);
    }
    const extraPaths = (harness as Record<string, unknown>)["extraPaths"];
    if (extraPaths !== undefined) {
      if (!Array.isArray(extraPaths) || extraPaths.some((path) => typeof path !== "string")) {
        fail('"harness.extraPaths" must be an array of strings');
      }
      config.harness.extraPaths = [...(extraPaths as string[])];
    }
  }

  return config;
}

/** The config on disk, or null when there is none. Throws CliError when it is unusable. */
export function load(root: string): Config | null {
  const path = configPath(root);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`is not valid JSON (${(error as Error).message})`);
  }
  return validate(parsed);
}

/** The op that would save this config. Writing is plan.apply()'s job. */
export function saveOp(root: string, config: Config): FileOp {
  return {
    kind: "write",
    path: configPath(root),
    content: `${JSON.stringify(config, null, 2)}\n`,
  };
}
