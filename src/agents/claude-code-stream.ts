import { isAbsolute, relative } from "node:path";

import { MAIN_THREAD, MAX_EVENT_CHARS, type ToolKind, type TranscriptEvent, type Usage } from "./types.js";

/**
 * Claude Code's `--output-format stream-json`, normalised. One JSON object per line;
 * anything we do not recognise is skipped, because the format grows between releases and
 * a new event type is not a reason to fail a run.
 */

export type ParsedStream = {
  model: string | null;
  finalMessage: string;
  tokens: Usage;
  costUsd: number | null;
  /** Null when there was no result event, so the caller supplies the wall clock. */
  durationMs: number | null;
  turns: number;
  toolCalls: Record<string, number>;
  toolFailures: number;
  transcript: TranscriptEvent[];
  /** The agent's own verdict from the result event; false when there was none. */
  isError: boolean;
  /** The result event's `subtype` ("success", "error_max_turns", ...); null when there was none. */
  resultSubtype: string | null;
};

/** The result subtype Claude Code reports when `--max-turns` cut the run off. */
export const MAX_TURNS_SUBTYPE = "error_max_turns";

/** What a cut-off run says instead of the half-sentence it was in the middle of. */
export function cutOffMessage(turns: number): string {
  return `cut off by the turn limit after ${turns} turns`;
}

export type StreamOptions = {
  /** The workspace tree; a tool's `file_path` under it is recorded relative to it. */
  tree?: string | undefined;
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncate(text: string): string {
  return text.length <= MAX_EVENT_CHARS ? text : text.slice(0, MAX_EVENT_CHARS);
}

/** A tool result's content is a string, or the content blocks a tool returned. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isObject(block) ? (str(block["text"]) ?? JSON.stringify(block)) : String(block)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/** A tool call's input, kept whole when it is small and as truncated JSON when it is not. */
function toolInput(input: unknown): unknown {
  const serialised = JSON.stringify(input ?? null);
  return serialised.length <= MAX_EVENT_CHARS ? input : serialised.slice(0, MAX_EVENT_CHARS);
}

function message(event: Json): Json {
  return isObject(event["message"]) ? event["message"] : {};
}

function contentBlocks(event: Json): Json[] {
  const content = message(event)["content"];
  return Array.isArray(content) ? content.filter(isObject) : [];
}

/** Usage as the API reports it on a message; null when the message carries none. */
function usage(value: unknown): Usage | null {
  if (!isObject(value)) return null;
  return {
    input: num(value["input_tokens"]) ?? 0,
    output: num(value["output_tokens"]) ?? 0,
    cacheRead: num(value["cache_read_input_tokens"]) ?? 0,
    cacheWrite: num(value["cache_creation_input_tokens"]) ?? 0,
  };
}

/** Claude Code's built-in tool names, by what they do. Anything else, including MCP, is other. */
export function toolKind(tool: string): ToolKind {
  switch (tool) {
    case "Read":
      return "read";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "write";
    case "Grep":
    case "Glob":
      return "search";
    case "Bash":
      return "shell";
    case "Task":
    case "Agent":
      return "spawn";
    default:
      return "other";
  }
}

/** The file a read or write touches, relative to the tree; a path outside it stays absolute. */
function toolPath(kind: ToolKind, input: unknown, tree: string | undefined): string | null {
  if (kind !== "read" && kind !== "write") return null;
  if (!isObject(input)) return null;
  const path = str(input["file_path"]) ?? str(input["notebook_path"]);
  if (path === null || path === "") return null;
  if (tree === undefined || !isAbsolute(path)) return path;
  const rel = relative(tree, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/** A sub-agent's events carry the id of the call that spawned it; the main thread's do not. */
function thread(event: Json): string {
  return str(event["parent_tool_use_id"]) ?? MAIN_THREAD;
}

/**
 * Accumulates a stream line by line, so a long run is never held in memory at once. The
 * parser reads no clock: `at` comes from the caller, so a test can say when a line arrived.
 * parseStreamJson is the whole-input form of the same thing.
 */
export class StreamParser {
  private readonly parsed: ParsedStream = {
    model: null,
    finalMessage: "",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    durationMs: null,
    turns: 0,
    toolCalls: {},
    toolFailures: 0,
    transcript: [],
    isError: false,
    resultSubtype: null,
  };

  private readonly tree: string | undefined;
  /** API message id → turn index. Claude Code emits one `assistant` event per content block. */
  private readonly turns = new Map<string, number>();
  private assistantMessages = 0;
  private sawResult = false;

  constructor(options: StreamOptions = {}) {
    this.tree = options.tree;
  }

  /** One line of the stream; `at` is milliseconds since the agent started, per the caller. */
  push(line: string, at = 0): void {
    if (line.trim() === "") return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // A partial or non-JSON line: the agent's own logging, not our business.
    }
    if (!isObject(event)) return;

    switch (event["type"]) {
      case "system":
        if (event["subtype"] === "init") this.parsed.model = str(event["model"]) ?? this.parsed.model;
        return;
      case "assistant":
        this.assistant(event, at);
        return;
      case "user":
        this.user(event, at);
        return;
      case "result":
        this.result(event, at);
        return;
      default:
        return;
    }
  }

  /** The parsed stream. Safe to call at any point; the adapter calls it once, at the end. */
  finish(): ParsedStream {
    if (!this.sawResult) this.parsed.turns = this.assistantMessages;
    return this.parsed;
  }

  /** The turn an assistant event belongs to: one per API message id, a new one when there is none. */
  private turn(own: Json): number {
    const id = str(own["id"]);
    const known = id === null ? undefined : this.turns.get(id);
    if (known !== undefined) return known;
    const turn = this.assistantMessages++;
    if (id !== null) this.turns.set(id, turn);
    return turn;
  }

  private assistant(event: Json, at: number): void {
    const own = message(event);
    const turn = this.turn(own);
    const base = { thread: thread(event), at };
    const texts: string[] = [];
    const calls: TranscriptEvent[] = [];
    for (const block of contentBlocks(event)) {
      if (block["type"] === "text") {
        const text = str(block["text"]) ?? "";
        if (text !== "") texts.push(text);
      } else if (block["type"] === "tool_use") {
        const tool = str(block["name"]) ?? "unknown";
        const kind = toolKind(tool);
        calls.push({
          ...base,
          type: "tool_call",
          id: str(block["id"]) ?? "",
          tool,
          input: toolInput(block["input"]),
          kind,
          path: toolPath(kind, block["input"], this.tree),
        });
        this.parsed.toolCalls[tool] = (this.parsed.toolCalls[tool] ?? 0) + 1;
      }
    }
    const text = texts.join("\n");
    this.parsed.transcript.push({
      ...base,
      type: "assistant",
      turn,
      text: truncate(text),
      model: str(own["model"]),
      usage: usage(own["usage"]),
    });
    if (text !== "" && base.thread === MAIN_THREAD) this.parsed.finalMessage = text;
    this.parsed.transcript.push(...calls);
  }

  private user(event: Json, at: number): void {
    for (const block of contentBlocks(event)) {
      if (block["type"] !== "tool_result") continue;
      const isError = block["is_error"] === true;
      if (isError) this.parsed.toolFailures++;
      this.parsed.transcript.push({
        thread: thread(event),
        at,
        type: "tool_result",
        id: str(block["tool_use_id"]) ?? "",
        isError,
        output: truncate(resultText(block["content"])),
      });
    }
  }

  /**
   * Claude Code emits a result when the main thread yields to a background sub-agent and
   * another at the very end; the last one wins, and turns and tokens come from it.
   */
  private result(event: Json, at: number): void {
    this.sawResult = true;
    this.parsed.tokens = usage(event["usage"]) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.parsed.costUsd = num(event["total_cost_usd"]);
    this.parsed.durationMs = num(event["duration_ms"]);
    this.parsed.turns = num(event["num_turns"]) ?? this.assistantMessages;
    this.parsed.resultSubtype = str(event["subtype"]);

    // A cut-off run's trailing text is whatever it was in the middle of, not a summary.
    const final =
      this.parsed.resultSubtype === MAX_TURNS_SUBTYPE ? cutOffMessage(this.parsed.turns) : str(event["result"]);
    if (final !== null) this.parsed.finalMessage = final;

    this.parsed.isError = event["is_error"] === true;
    if (this.parsed.isError) {
      this.parsed.transcript.push({
        thread: MAIN_THREAD,
        at,
        type: "error",
        message: truncate(final !== null && final !== "" ? final : (this.parsed.resultSubtype ?? "error")),
      });
    }
  }
}

export function parseStreamJson(lines: Iterable<string>, options: StreamOptions = {}): ParsedStream {
  const parser = new StreamParser(options);
  for (const line of lines) parser.push(line);
  return parser.finish();
}
