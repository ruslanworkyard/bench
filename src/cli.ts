#!/usr/bin/env node
import { init } from "./commands/init.js";
import { run } from "./commands/run.js";
import { CliError } from "./errors.js";

const VALUE_FLAGS = new Set(["base", "test", "agent"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "json", "help"]);

const HELP = `harnessbench - Regression tests for your CLAUDE.md.

Usage:
  harnessbench init [options]
  harnessbench run <fixture-id> [options]

Options:
  --base <branch>   Base branch to compare against (overrides config/detection)
  --test <command>  Test command (init only; overrides detection)
  --agent <name>    Coding agent to run (overrides config/detection)
  --dry-run         Report what init would do, without writing anything
  --json            Print the summary as one JSON object
  -h, --help        Show this help`;

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

function main(argv: string[]): number {
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
    run({
      cwd: process.cwd(),
      fixtureId,
      base: value(flags, "base"),
      agent: value(flags, "agent"),
    });
    return 0;
  }
  throw new CliError(`unknown command "${command}"\n\n${HELP}`, 2);
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  if (error instanceof CliError) {
    console.error(`harnessbench: ${error.message}`);
    process.exit(error.exitCode);
  }
  throw error;
}
