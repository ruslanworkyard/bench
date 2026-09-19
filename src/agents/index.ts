import { CliError } from "../errors.js";
import { claudeCode } from "./claude-code.js";
import type { AgentAdapter } from "./types.js";

/** Every agent harnessbench can drive, by the name a config's `agent.name` uses. */
const ADAPTERS: readonly AgentAdapter[] = [claudeCode];

export function adapterNames(): string[] {
  return ADAPTERS.map((adapter) => adapter.name);
}

/** The adapter called `name`, or a CliError listing the ones that exist. */
export function getAdapter(name: string): AgentAdapter {
  const adapter = ADAPTERS.find((each) => each.name === name);
  if (adapter === undefined) {
    throw new CliError(`unknown agent '${name}' - known agents: ${adapterNames().join(", ")}`);
  }
  return adapter;
}

/** The adapter that drives `command` by default; how a binary found on PATH is recognised. */
export function adapterForCommand(command: string): AgentAdapter | null {
  return ADAPTERS.find((adapter) => adapter.defaultCommand === command) ?? null;
}
