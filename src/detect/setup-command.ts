import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Detection } from "./types.js";

/**
 * A dependency install we can claim from a lockfile alone. A manifest without a lockfile is
 * not enough: a non-frozen install rewrites the lockfile, and every run's diff would start
 * with that. Cargo, Gradle and Maven fetch during the build, so they have no row here.
 */
type Rule = {
  /** Any one of these present is the evidence. */
  lockfiles: string[];
  command: string;
  /** A rule that is skipped when another lockfile is present: pip yields to poetry. */
  unless?: string[];
};

const RULES: Rule[] = [
  { lockfiles: ["package-lock.json"], command: "npm ci" },
  { lockfiles: ["pnpm-lock.yaml"], command: "pnpm install --frozen-lockfile" },
  { lockfiles: ["yarn.lock"], command: "yarn install --frozen-lockfile" },
  { lockfiles: ["bun.lock", "bun.lockb"], command: "bun install --frozen-lockfile" },
  { lockfiles: ["go.sum"], command: "go mod download" },
  { lockfiles: ["Gemfile.lock"], command: "bundle install" },
  { lockfiles: ["composer.lock"], command: "composer install" },
  { lockfiles: ["poetry.lock"], command: "poetry install" },
  { lockfiles: ["requirements.txt"], command: "pip install -r requirements.txt", unless: ["poetry.lock"] },
];

/**
 * The command that installs this project's dependencies, from the lockfiles present. Several
 * lockfiles (say a Node front end beside a Go service) give one command joined with ` && `,
 * in the order of the table above.
 */
export function setupCommand(root: string): Detection<string> | null {
  const matched: { lockfile: string; command: string }[] = [];
  for (const rule of RULES) {
    if (rule.unless?.some((name) => existsSync(join(root, name)))) continue;
    const lockfile = rule.lockfiles.find((name) => existsSync(join(root, name)));
    if (lockfile !== undefined) matched.push({ lockfile, command: rule.command });
  }
  if (matched.length === 0) return null;
  if (matched.length === 1) {
    const [only] = matched as [{ lockfile: string; command: string }];
    return { value: only.command, source: only.lockfile };
  }
  return {
    value: matched.map((match) => match.command).join(" && "),
    source: `${matched.map((match) => match.lockfile).join(", ")}: several lockfiles, so each install runs in turn`,
  };
}
