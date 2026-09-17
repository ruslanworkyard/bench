#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = "harnessbench.config.json";

/** Harness files we look for, in the order they are reported. */
const HARNESS_FILES = ["CLAUDE.md", ".claude/", "AGENTS.md", ".mcp.json"] as const;

type HarnessFile = (typeof HARNESS_FILES)[number];

const HELP = `harnessbench - Regression tests for your CLAUDE.md.

Usage:
  harnessbench <command> [options]

Commands:
  init          Create ${CONFIG_FILE} in the current directory

Options:
  -h, --help    Show this help
`;

function isGitRepo(cwd: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function detectHarnessFiles(cwd: string): HarnessFile[] {
  // A trailing "/" marks a directory; existsSync accepts the path either way.
  return HARNESS_FILES.filter((name) => existsSync(join(cwd, name)));
}

function detectTestCommand(cwd: string): string {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return "";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.test ? "npm test" : "";
  } catch {
    return "";
  }
}

function init(cwd: string): number {
  if (!isGitRepo(cwd)) {
    console.error(
      `harnessbench: ${cwd} is not a git repository.\n` +
        `Run harnessbench from inside a git repo (or run "git init" first).`,
    );
    return 1;
  }

  const harnessFiles = detectHarnessFiles(cwd);
  const testCommand = detectTestCommand(cwd);

  const configPath = join(cwd, CONFIG_FILE);
  const exists = existsSync(configPath);
  if (!exists) {
    const config = {
      version: 1,
      harnessFiles,
      testCommand,
      tests: [] as unknown[],
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  console.log("Harness files:");
  for (const name of HARNESS_FILES) {
    console.log(`  ${harnessFiles.includes(name) ? "found  " : "missing"}  ${name}`);
  }
  console.log(`Test command: ${testCommand || "(none detected)"}`);
  console.log(
    exists
      ? `\n${CONFIG_FILE} already exists - left unchanged.`
      : `\nWrote ${CONFIG_FILE}.`,
  );
  console.log(`Next: edit ${CONFIG_FILE} to add your first test.`);
  return 0;
}

function main(argv: string[]): number {
  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "init") {
    return init(process.cwd());
  }

  console.error(`harnessbench: unknown command "${command}"\n`);
  console.error(HELP);
  return 2;
}

process.exit(main(process.argv.slice(2)));
