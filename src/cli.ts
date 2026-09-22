#!/usr/bin/env node
import { writeSync } from "node:fs";

import { compare, compareBatch } from "./commands/compare.js";
import { init } from "./commands/init.js";
import { judge, judgeBatch } from "./commands/judge.js";
import { run } from "./commands/run.js";
import { loadEnvFile } from "./env.js";
import { CliError } from "./errors.js";
import { requireGit, requireRepo } from "./preflight.js";
import { abortAll, liveWorkspaces } from "./workspace.js";

const VALUE_FLAGS = new Set(["base", "test", "setup", "agent", "max-turns", "model", "fixture", "stamp", "concurrency", "tag"]);
/** Value flags that may be given more than once; the values are collected in order. */
const REPEATABLE_FLAGS = new Set(["tag"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "json", "keep", "markdown", "judge", "all", "help"]);

const HELP = `harnessbench - Regression tests for your CLAUDE.md.

Usage:
  harnessbench init [options]
  harnessbench run [<fixture-id>...] [--tag <tag>]... [options]
  harnessbench compare [<previous-run-id> <candidate-run-id> | --fixture <id> | --stamp <s>] [options]
  harnessbench judge [<previous-run-id> <candidate-run-id> | --fixture <id> | --stamp <s>] [options]

run drives a set of fixtures on HEAD's code, every side of every fixture at once under one
stamp: with the harness as committed at the merge base with the base branch (previous), and
with the harness at HEAD (candidate). No ids and no --tag means every fixture in
.harnessbench/fixtures; ids name fixtures; --tag picks those carrying the tag; both together
is the intersection. Progress goes to stderr as it happens; the output ends with one
comparison table per fixture and, for several fixtures, a roll-up above them saying which
fixtures improved and which regressed on each criterion. Ctrl-C stops every agent, removes
their workspaces (unless --keep) and exits 130.

compare prints the tables again: with no arguments, for the latest batch that has a complete
pair; --stamp <s> for that batch; --fixture <id> for the latest pair of one fixture; two run
ids for that pair. judge shows each pair, blind, to every judge in the config's "judges"
list and prints the tables with one row per judge; run --judge does that for each fixture as
soon as its two sides are in. judge is incremental: a verdict whose rubric has not changed
since is kept, the rest are judged; --all judges every configured judge again. Over a
batch, pairs are judged concurrently; a pair with a missing side is listed as skipped.

Options:
  --base <branch>   Base branch to compare against (overrides config/detection)
  --test <command>  Test command (init only; overrides detection)
  --setup <command> Setup command run before the agent, e.g. npm ci (init only; overrides detection)
  --agent <name>    Agent to drive, by adapter name (overrides config/detection)
  --tag <tag>       Run the fixtures carrying this tag; repeatable, any tag matches (run only)
  --concurrency <n> Sides in flight at once; unlimited by default (run only)
  --max-turns <n>   Agent turn limit for this run (run only; overrides config)
  --model <name>    Model for this run (run only; overrides config)
  --keep            Leave the runs' workspaces on disk (run only; paths printed)
  --judge           Run the configured judges on each pair once its sides are in (run only)
  --all             Judge every configured judge, not only those without a fresh verdict (judge only)
  --fixture <id>    Use the latest run pair of this fixture (compare and judge)
  --stamp <s>       Use the batch with this stamp, YYYYMMDD-HHMMSS (compare and judge)
  --markdown        Print the comparison as GitHub-flavoured markdown (compare only)
  --dry-run         Report what init would do, without writing anything
  --json            Print the summary as one JSON document
  -h, --help        Show this help

Exit codes (run): 0 completed, 2 agent timed out, 3 agent error, 4 agent hit the turn
limit, 1 anything else; the worst side across the batch wins. A failing test suite is a
result, not an error: it does not change the exit code. A failing setup command is exit 1
with no run.json for that side, once every other fixture has finished and been reported; an
interrupted run is exit 130 with no run.json for any unfinished side. compare exits 0 after
printing: it reports, it does not gate. judge exits 0 with verdicts, 1 when it refuses (a
side that did not complete, no model or key, context over the size limit); with run --judge
or over a batch a refusal is one line for that fixture and the exit code is otherwise
unchanged.`;

type Flags = Record<string, string | string[] | true>;

function parse(argv: readonly string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h") {
      flags["help"] = true;
    } else if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
        throw new CliError(`unknown option "${arg}"\n\n${HELP}`, 2);
      }
      let given: string | true;
      if (equals !== -1) given = arg.slice(equals + 1);
      else if (!VALUE_FLAGS.has(name)) given = true;
      else {
        const value = argv[++i];
        if (value === undefined) throw new CliError(`option "--${name}" needs a value`, 2);
        given = value;
      }
      if (REPEATABLE_FLAGS.has(name) && given !== true) {
        const previous = flags[name];
        flags[name] = [...(Array.isArray(previous) ? previous : []), given];
      } else {
        flags[name] = given;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function value(flags: Flags, name: string): string | undefined {
  const flag = flags[name];
  if (flag === undefined) return undefined;
  if (flag === true) throw new CliError(`option "--${name}" needs a value`, 2);
  return Array.isArray(flag) ? flag.at(-1) : flag;
}

/** Every value a repeatable flag was given, in order; none when it was not. */
function values(flags: Flags, name: string): string[] {
  const flag = flags[name];
  if (flag === undefined) return [];
  if (flag === true) throw new CliError(`option "--${name}" needs a value`, 2);
  return Array.isArray(flag) ? flag : [flag];
}

function positiveInteger(flags: Flags, name: string): number | undefined {
  const raw = value(flags, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`option "--${name}" needs a positive integer, got "${raw}"`, 2);
  }
  return parsed;
}

/**
 * Credentials from `.harnessbench/.env`, for every command that could need them, before
 * any preflight looks for them. init is left out: it may run before the repository has one.
 */
function loadCredentials(): void {
  requireGit();
  loadEnvFile(requireRepo(process.cwd()));
}

/** What the shell learns from a run: the agent's outcome, never the test suite's. */
const RUN_EXIT_CODES = { completed: 0, timeout: 2, error: 3, max_turns: 4 } as const;

/** The conventional exit code for a process ended by SIGINT (128 + 2). */
const INTERRUPTED_EXIT_CODE = 130;

/**
 * Ctrl-C reaches this process, not the agents: they run detached, in their own process
 * groups, so left alone they would keep running and spending. On the first signal, kill
 * them all, clean up (or keep, with --keep) and exit; a second signal during that is ignored.
 * Written with writeSync: on macOS a piped stderr is asynchronous and process.exit would
 * cut the message off.
 */
function stopRunsOnSignal(keep: boolean): void {
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    writeSync(process.stderr.fd, `harnessbench: interrupted, stopping ${liveWorkspaces()} run(s)\n`);
    const paths = abortAll({ keep });
    if (keep) for (const path of paths) writeSync(process.stderr.fd, `workspace kept at ${path}\n`);
    process.exit(INTERRUPTED_EXIT_CODE);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv);
  const command = positional[0];
  if (flags["help"] === true || command === undefined || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "init") {
    init({
      cwd: process.cwd(),
      base: value(flags, "base"),
      test: value(flags, "test"),
      setup: value(flags, "setup"),
      agent: value(flags, "agent"),
      dryRun: flags["dry-run"] === true,
      json: flags["json"] === true,
    });
    return 0;
  }
  if (command === "run") {
    loadCredentials();
    stopRunsOnSignal(flags["keep"] === true);
    const result = await run({
      cwd: process.cwd(),
      fixtureIds: positional.slice(1),
      tags: values(flags, "tag"),
      concurrency: positiveInteger(flags, "concurrency"),
      base: value(flags, "base"),
      agent: value(flags, "agent"),
      maxTurns: positiveInteger(flags, "max-turns"),
      model: value(flags, "model"),
      keep: flags["keep"] === true,
      json: flags["json"] === true,
      judge: flags["judge"] === true,
    });
    const records = result.fixtures.flatMap((fixture) => fixture.records);
    return Math.max(0, ...records.map((record) => RUN_EXIT_CODES[record.outcome]));
  }
  if (command === "judge" || command === "compare") {
    const ids = positional.slice(1);
    if (ids.length !== 0 && ids.length !== 2) {
      throw new CliError(`${command} takes two run ids or none\n\n${HELP}`, 2);
    }
    const fixture = value(flags, "fixture");
    const stamp = value(flags, "stamp");
    const given = [ids.length === 2 ? "two run ids" : null, fixture === undefined ? null : "--fixture", stamp === undefined ? null : "--stamp"]
      .filter((each) => each !== null);
    if (given.length > 1) {
      throw new CliError(`${given.join(" and ")} are exclusive; pick one way to say which runs`, 2);
    }
    if (flags["json"] === true && flags["markdown"] === true) {
      throw new CliError("--json and --markdown are exclusive; pick one", 2);
    }
    loadCredentials();
    const pair = ids.length === 2 || fixture !== undefined;
    const addressing = { cwd: process.cwd(), runIds: ids.length === 2 ? (ids as [string, string]) : undefined, fixture };
    const json = flags["json"] === true;
    if (command === "judge") {
      if (pair) await judge({ ...addressing, json, all: flags["all"] === true });
      else await judgeBatch({ cwd: process.cwd(), stamp, json, all: flags["all"] === true });
      return 0;
    }
    const markdown = flags["markdown"] === true;
    if (pair) compare({ ...addressing, json, markdown });
    else compareBatch({ cwd: process.cwd(), stamp, json, markdown });
    return 0;
  }
  throw new CliError(`unknown command "${command}"\n\n${HELP}`, 2);
}

// The exit code is set, not forced: on macOS a piped stdout is written asynchronously, and
// process.exit() would cut a long --json document off at the first 8 KB.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof CliError) {
      console.error(`harnessbench: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  },
);
