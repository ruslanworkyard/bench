import { MAX_EVENT_CHARS, type TranscriptEvent } from "./types.js";

/**
 * Claude Code's `--output-format stream-json`, normalised. One JSON object per line;
 * anything we do not recognise is skipped, because the format grows between releases and
 * a new event type is not a reason to fail a run.
 */

export type ParsedStream = {
  model: string | null;
  finalMessage: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  /** Null when there was no result event, so the caller supplies the wall clock. */
  durationMs: number | null;
  turns: number;
  toolCalls: Record<string, number>;
  toolFailures: number;
  transcript: TranscriptEvent[];
  /** The agent's own verdict from the result event; false when there was none. */
  isError: boolean;
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

function contentBlocks(event: Json): Json[] {
  const message = event["message"];
  if (!isObject(message)) return [];
  const content = message["content"];
  return Array.isArray(content) ? content.filter(isObject) : [];
}

/**
 * Accumulates a stream line by line, so a long run is never held in memory at once.
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
  };

  private assistantMessages = 0;
  private sawResult = false;

  push(line: string): void {
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
        this.assistant(event);
        return;
      case "user":
        this.user(event);
        return;
      case "result":
        this.result(event);
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

  private assistant(event: Json): void {
    this.assistantMessages++;
    for (const block of contentBlocks(event)) {
      if (block["type"] === "text") {
        const text = str(block["text"]) ?? "";
        if (text === "") continue;
        this.parsed.transcript.push({ type: "assistant", text: truncate(text) });
        this.parsed.finalMessage = text;
      } else if (block["type"] === "tool_use") {
        const tool = str(block["name"]) ?? "unknown";
        this.parsed.transcript.push({
          type: "tool_call",
          id: str(block["id"]) ?? "",
          tool,
          input: toolInput(block["input"]),
        });
        this.parsed.toolCalls[tool] = (this.parsed.toolCalls[tool] ?? 0) + 1;
      }
    }
  }

  private user(event: Json): void {
    for (const block of contentBlocks(event)) {
      if (block["type"] !== "tool_result") continue;
      const isError = block["is_error"] === true;
      if (isError) this.parsed.toolFailures++;
      this.parsed.transcript.push({
        type: "tool_result",
        id: str(block["tool_use_id"]) ?? "",
        isError,
        output: truncate(resultText(block["content"])),
      });
    }
  }

  private result(event: Json): void {
    this.sawResult = true;
    const usage = isObject(event["usage"]) ? event["usage"] : {};
    this.parsed.tokens = {
      input: num(usage["input_tokens"]) ?? 0,
      output: num(usage["output_tokens"]) ?? 0,
      cacheRead: num(usage["cache_read_input_tokens"]) ?? 0,
      cacheWrite: num(usage["cache_creation_input_tokens"]) ?? 0,
    };
    this.parsed.costUsd = num(event["total_cost_usd"]);
    this.parsed.durationMs = num(event["duration_ms"]);
    this.parsed.turns = num(event["num_turns"]) ?? this.assistantMessages;

    const final = str(event["result"]);
    if (final !== null) this.parsed.finalMessage = final;

    this.parsed.isError = event["is_error"] === true;
    if (this.parsed.isError) {
      const subtype = str(event["subtype"]) ?? "error";
      this.parsed.transcript.push({
        type: "error",
        message: truncate(final !== null && final !== "" ? final : subtype),
      });
    }
  }
}

export function parseStreamJson(lines: Iterable<string>): ParsedStream {
  const parser = new StreamParser();
  for (const line of lines) parser.push(line);
  return parser.finish();
}
