import type { AgentConfig } from "../config.js";
import type { RunOutcome } from "../run-record.js";
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
  /** And its stderr here, whole; the run keeps it to explain an agent that failed. */
  stderrPath: string;
  /** Hears each turn and tool call as the agent makes it; the caller says whose side it is. */
  onEvent?: ((event: AgentEvent) => void) | undefined;
};

/** A live moment of the agent's run: a completed turn, or a tool call (`failed` when its result was an error). */
export type AgentEvent =
  | { type: "side.turn"; turn: number; tokens: Usage; costUsd: number | null }
  | { type: "side.tool"; thread: string; kind: ToolKind; label: string; failed: boolean };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type AgentResult = {
  outcome: RunOutcome;
  /** Null when the agent was killed by a signal, including on timeout. */
  exitCode: number | null;
  /** What actually ran, as the agent itself reported it; null when it did not. */
  model: string | null;
  finalMessage: string;
  tokens: Usage;
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

/** What a tool does, in adapter-neutral terms, so telemetry never needs a tool's name. */
export type ToolKind = "read" | "write" | "search" | "shell" | "spawn" | "other";

/** The thread every event on the main conversation belongs to. */
export const MAIN_THREAD = "main";

type EventBase = {
  /** "main", or the id of the `spawn` tool call whose sub-agent produced the event. */
  thread: string;
  /** Milliseconds since the agent process started, stamped when the line arrived. */
  at: number;
};

/**
 * The normalised transcript: the same shape for every adapter, so everything derived from
 * it (telemetry, later the judge) is written once. One `assistant` event per assistant
 * message, even one that only calls tools, so its model and usage are never lost. A stream
 * that splits one model response over several events gives them all the same `turn`.
 */
export type TranscriptEvent =
  | (EventBase & {
      type: "assistant";
      /** Which model response this came from, as the adapter numbers them; telemetry counts distinct values. */
      turn: number;
      text: string;
      model: string | null;
      /** This message's own usage, as the stream reports it per message; null when absent. */
      usage: Usage | null;
    })
  | (EventBase & {
      type: "tool_call";
      id: string;
      tool: string;
      input: unknown;
      kind: ToolKind;
      /** For read/write: the file, relative to the workspace tree; null otherwise or when unknown. */
      path: string | null;
    })
  | (EventBase & { type: "tool_result"; id: string; isError: boolean; output: string })
  | (EventBase & { type: "error"; message: string });

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
