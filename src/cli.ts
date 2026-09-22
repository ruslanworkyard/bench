#!/usr/bin/env node
import { compare } from "./commands/compare.js";
import { init } from "./commands/init.js";
import { judge } from "./commands/judge.js";
import { run } from "./commands/run.js";
import { loadEnvFile } from "./env.js";
import { CliError } from "./errors.js";
import { requireGit, requireRepo } from "./preflight.js";

const VALUE_FLAGS = new Set(["base", "test", "setup", "agent", "max-turns", "model", "fixture"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "json", "keep", "markdown", "judge", "help"]);

const HELP = `harnessbench - Regression tests for your CLAUDE.md.

Usage:
  harnessbench init [options]
  harnessbench run <fixture-id> [options]
  harnessbench compare [<previous-run-id> <candidate-run-id>] [options]
  harnessbench judge [<previous-run-id> <candidate-run-id>] [options]

run drives the fixture twice on HEAD's code: first with the harness as committed at the
merge base with the base branch (previous), then with the harness at HEAD (candidate),
and ends with the comparison of the two. compare prints that table again for two run ids,
or for the latest run of --fixture <id>. judge shows the same pair, blind, to every judge
in the config's "judges" list and prints one verdict per judge; run --judge does that as
soon as both sides are in.

Options:
  --base <branch>   Base branch to compare against (overrides config/detection)
  --test <command>  Test command (init only; overrides detection)
  --setup <command> Setup command run before the agent, e.g. npm ci (init only; overrides detection)
  --agent <name>    Agent to drive, by adapter name (overrides config/detection)
  --max-turns <n>   Agent turn limit for this run (run only; overrides config)
  --model <name>    Model for this run (run only; overrides config)
  --keep            Leave the run's workspace on disk (run only; path printed)
  --judge           Run the configured judges once both sides are in (run only)
  --fixture <id>    Use the latest run pair of this fixture (compare and judge)
  --markdown        Print the comparison as a GitHub-flavoured markdown table (compare only)
  --dry-run         Report what init would do, without writing anything
  --json            Print the summary as one JSON document
  -h, --help        Show this help

Exit codes (run): 0 completed, 2 agent timed out, 3 agent error, 4 agent hit the turn
limit, 1 anything else; the worse of the two sides wins. A failing test suite is a result,
not an error: it does not change the exit code. A failing setup command is exit 1 with no
run.json for that side. compare exits 0 after printing: it reports,
it does not gate. judge exits 0 with verdicts, 1 when it refuses (a side that did not
complete, no model or key, context over the size limit); with run --judge a refusal is
one line on stderr and the run's own exit code.`;

type Flags = Record<string, string | true>;

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
      if (equals !== -1) flags[name] = arg.slice(equals + 1);
      else if (!VALUE_FLAGS.has(name)) flags[name] = true;
      else {
        const value = argv[++i];
        if (value === undefined) throw new CliError(`option "--${name}" needs a value`, 2);
        flags[name] = value;
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
  return flag;
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
    const fixtureId = positional[1];
    if (fixtureId === undefined) {
      throw new CliError(`run needs a fixture id\n\n${HELP}`, 2);
    }
    loadCredentials();
    const records = await run({
      cwd: process.cwd(),
      fixtureId,
      base: value(flags, "base"),
      agent: value(flags, "agent"),
      maxTurns: positiveInteger(flags, "max-turns"),
      model: value(flags, "model"),
      keep: flags["keep"] === true,
      json: flags["json"] === true,
      judge: flags["judge"] === true,
    });
    return Math.max(...records.map((record) => RUN_EXIT_CODES[record.outcome]));
  }
  if (command === "judge") {
    const ids = positional.slice(1);
    if (ids.length !== 0 && ids.length !== 2) {
      throw new CliError(`judge takes two run ids or none\n\n${HELP}`, 2);
    }
    if (ids.length === 0 && value(flags, "fixture") === undefined) {
      throw new CliError(`judge needs two run ids, or --fixture <id>\n\n${HELP}`, 2);
    }
    loadCredentials();
    await judge({
      cwd: process.cwd(),
      runIds: ids.length === 2 ? (ids as [string, string]) : undefined,
      fixture: value(flags, "fixture"),
      json: flags["json"] === true,
    });
    return 0;
  }
  if (command === "compare") {
    const ids = positional.slice(1);
    if (ids.length !== 0 && ids.length !== 2) {
      throw new CliError(`compare takes two run ids or none\n\n${HELP}`, 2);
    }
    if (ids.length === 0 && value(flags, "fixture") === undefined) {
      throw new CliError(`compare needs two run ids, or --fixture <id>\n\n${HELP}`, 2);
    }
    if (flags["json"] === true && flags["markdown"] === true) {
      throw new CliError("--json and --markdown are exclusive; pick one", 2);
    }
    loadCredentials();
    compare({
      cwd: process.cwd(),
      runIds: ids.length === 2 ? (ids as [string, string]) : undefined,
      fixture: value(flags, "fixture"),
      json: flags["json"] === true,
      markdown: flags["markdown"] === true,
    });
    return 0;
  }
  throw new CliError(`unknown command "${command}"\n\n${HELP}`, 2);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof CliError) {
      console.error(`harnessbench: ${error.message}`);
      process.exit(error.exitCode);
    }
    throw error;
  },
);
