import type { AgentConfig } from "../config.js";
import type { Workspace } from "../workspace.js";

/**
 * The contract every coding agent is driven through. An adapter turns one prompt into one
 * AgentResult; it never decides whether the run was a success, never prints, and writes
 * only inside the workspace it is given.
 */

export type AgentRequest = {
  workspace: Workspace;
  prompt: string;
  config: AgentConfig;
  /** The adapter streams the agent's untouched stdout here, as it arrives. */
  rawOutputPath: string;
};

export type AgentResult = {
  outcome: "completed" | "timeout" | "error";
  /** Null when the agent was killed by a signal, including on timeout. */
  exitCode: number | null;
  /** What actually ran, as the agent itself reported it; null when it did not. */
  model: string | null;
  finalMessage: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Null when the agent does not report cost. */
  costUsd: number | null;
  durationMs: number;
  turns: number;
  toolCalls: Record<string, number>;
  toolFailures: number;
  transcript: TranscriptEvent[];
};

/** How much of a tool's input or output is kept: enough to read, bounded per event. */
export const MAX_EVENT_CHARS = 2000;

export type TranscriptEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_call"; id: string; tool: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; output: string }
  | { type: "error"; message: string };

export type AgentAdapter = {
  name: string;
  defaultCommand: string;
  /** Host environment variable names forwarded to the agent when they are set. */
  forwardEnv: readonly string[];
  /** At least one of these must be set, or preflight fails naming all of them. */
  credentialEnv: readonly string[];
  /** Resolves for every outcome the agent can have. Throws only for our own bugs. */
  run(request: AgentRequest): Promise<AgentResult>;
};
