import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { ENV_FILE } from "./config.js";
import { CliError } from "./errors.js";

/** A `KEY=value` line, optionally `export`ed; the value is what follows the first `=`. */
const ENTRY = /^\s*(?:export\s+)?[^\s=#]+\s*=(.*)$/;

/**
 * `util.parseEnv` drops what it cannot read rather than complaining, so a credential with a
 * typo would fail later as "not set". This finds the first line that is neither an entry, a
 * comment, blank, nor inside a quoted value that spans lines. Returns its number, never its text.
 */
function malformedLine(text: string): number | null {
  const lines = text.split("\n");
  let openQuote: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (openQuote !== null) {
      if (line.includes(openQuote)) openQuote = null;
      continue;
    }
    if (/^\s*(#|$)/.test(line)) continue;
    const entry = ENTRY.exec(line);
    if (entry === null) return i + 1;
    const value = (entry[1] as string).trimStart();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && !value.slice(1).includes(quote)) {
      openQuote = quote;
    }
  }
  return null;
}

/**
 * Reads `.harnessbench/.env` into `env`, without overriding a variable that is already set:
 * the shell wins, so CI stays exactly as configured. Returns the names it set, for tests.
 * A missing file is nothing; an unreadable or malformed one is an error naming the file and,
 * at most, a line number. Values never appear in a message.
 */
export function loadEnvFile(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, ENV_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    if (code === "ENOENT") return [];
    throw new CliError(`${ENV_FILE} could not be read (${code}) - fix its permissions or remove it`, 1);
  }

  const line = malformedLine(text);
  if (line !== null) {
    throw new CliError(
      `${ENV_FILE}: line ${line} is not a KEY=value assignment, a comment or blank - fix or remove it`,
      1,
    );
  }

  const set: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] !== undefined) continue;
    env[name] = value;
    set.push(name);
  }
  return set;
}
