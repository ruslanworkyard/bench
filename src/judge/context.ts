import { MAIN_THREAD, type TranscriptEvent } from "../agents/types.js";
import type { ContextItem } from "../judges.js";
import type { Environment, RunRecord } from "../run-record.js";

/**
 * What a judge reads, assembled from two runs. Pure: everything comes in as strings and
 * records. The two sides are shown as A and B in a fixed layout; nothing here says which is
 * which, and the words that would (previous, candidate, run ids, harness hashes) are kept out.
 */

/** Fixed by design: a first-position tilt, if any, favours the incumbent. Recorded in judge.json. */
export const MAPPING = { A: "previous", B: "candidate" } as const;
export type Position = keyof typeof MAPPING;

/** One side's artefacts, as the run directory holds them. */
export type SideMaterial = {
  record: RunRecord;
  /** `diff.patch`, verbatim. */
  diff: string;
  /** `transcript.jsonl`, parsed. */
  transcript: TranscriptEvent[];
};

export type PairMaterial = {
  /** The fixture's prompt.md. */
  prompt: string;
  previous: SideMaterial;
  candidate: SideMaterial;
};

/** An item that would not fit; `side` is null for the shared prompt. */
export type Oversize = { side: Environment | null; item: ContextItem; bytes: number };

type SideItem = Exclude<ContextItem, "prompt">;

/** The layout order. A judge's `context` list is shown in this order, whatever its own order. */
const ORDER: readonly ContextItem[] = ["prompt", "diff", "tests", "finalMessage", "toolLog", "transcript"];

const HEADINGS: Record<SideItem, string> = {
  diff: "Diff",
  tests: "Test result",
  finalMessage: "Final message",
  toolLog: "Tool log",
  transcript: "Transcript",
};

/** One context item for one side, as the judge sees it. */
export function renderItem(item: SideItem, side: SideMaterial): string {
  switch (item) {
    case "diff":
      return side.diff.trim() === "" ? "(no changes)" : side.diff.trimEnd();
    case "tests":
      return testResult(side.record);
    case "finalMessage":
      return side.record.finalMessage.trim() === "" ? "(none)" : side.record.finalMessage.trimEnd();
    case "toolLog":
      return toolLog(side.transcript);
    case "transcript":
      return transcript(side.transcript);
  }
}

/** Every item over `maxKb`, on either side. Nothing is truncated: a hit fails the command. */
export function oversized(items: readonly ContextItem[], pair: PairMaterial, maxKb: number): Oversize[] {
  const limit = maxKb * 1024;
  const hits: Oversize[] = [];
  const measure = (side: Environment | null, item: ContextItem, text: string): void => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limit) hits.push({ side, item, bytes });
  };
  for (const item of ordered(items)) {
    if (item === "prompt") measure(null, item, pair.prompt);
    else {
      measure("previous", item, renderItem(item, pair.previous));
      measure("candidate", item, renderItem(item, pair.candidate));
    }
  }
  return hits;
}

/** The user message: the task once, then every other item for A, then the same for B. */
export function assembleContext(items: readonly ContextItem[], pair: PairMaterial): string {
  const wanted = ordered(items);
  const sections: string[] = [];
  if (wanted.includes("prompt")) sections.push(`# Task\n\n${pair.prompt.trimEnd()}`);
  const perSide = wanted.filter((item): item is SideItem => item !== "prompt");
  for (const position of Object.keys(MAPPING) as Position[]) {
    const side = pair[MAPPING[position]];
    const parts = perSide.map((item) => `## ${HEADINGS[item]}\n\n${renderItem(item, side)}`);
    sections.push([`# Attempt ${position}`, ...parts].join("\n\n"));
  }
  return scrub(sections.join("\n\n") + "\n", pair);
}

function ordered(items: readonly ContextItem[]): ContextItem[] {
  return ORDER.filter((item) => items.includes(item));
}

/** Run ids and harness hashes can leak through paths and messages; they never reach the judge. */
function scrub(text: string, pair: PairMaterial): string {
  const secrets = [
    pair.previous.record.runId,
    pair.candidate.record.runId,
    pair.previous.record.harness.hash,
    pair.candidate.record.harness.hash,
  ];
  let out = text;
  for (const secret of secrets) {
    if (secret !== "") out = out.split(secret).join("<redacted>");
  }
  return out;
}

/** The fact only, never the log: the judge weighs the tests, the suite reports on them. */
function testResult(record: RunRecord): string {
  if (record.tests === null) return "not configured";
  return record.tests.exitCode === 0 && !record.tests.timedOut ? "passed" : "failed";
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** What a tool call was about: its file, else its command's first line, else its name. */
function detail(event: Extract<TranscriptEvent, { type: "tool_call" }>): string {
  if (event.path !== null) return event.path;
  const input = event.input;
  if (typeof input === "object" && input !== null) {
    const command = (input as Record<string, unknown>)["command"];
    if (typeof command === "string" && command !== "") return firstLine(command);
  }
  return event.tool;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** One line per main-thread call; a sub-agent is one line, at the call that spawned it. */
function toolLog(events: TranscriptEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== "tool_call" || event.thread !== MAIN_THREAD) continue;
    if (event.kind === "spawn") {
      const calls = events.filter((each) => each.type === "tool_call" && each.thread === event.id).length;
      const model =
        events.find(
          (each): each is Extract<TranscriptEvent, { type: "assistant" }> =>
            each.type === "assistant" && each.thread === event.id,
        )?.model ?? "model not reported";
      lines.push(`spawn ${event.tool} (${plural(calls, "call")} on ${model})`);
    } else {
      lines.push(`${event.kind} ${detail(event)}`);
    }
  }
  return lines.length === 0 ? "(no tool calls)" : lines.join("\n");
}

/** `label: text`, with every further line of text indented under the first. */
function block(label: string, text: string): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") return label;
  return [`${label} ${lines[0] ?? ""}`, ...lines.slice(1).map((line) => `  ${line}`)].join("\n");
}

/** A tool's input as `key: value` lines; strings verbatim, anything else compact. */
function renderInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return String(JSON.stringify(input));
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => block(`${key}:`, typeof value === "string" ? value : String(JSON.stringify(value))))
    .join("\n");
}

/** Every event as a line or block of readable text, tagged with its thread. No JSON. */
function transcript(events: TranscriptEvent[]): string {
  if (events.length === 0) return "(empty)";
  const subAgents: string[] = [];
  const threadName = (thread: string): string => {
    if (thread === MAIN_THREAD) return "main";
    if (!subAgents.includes(thread)) subAgents.push(thread);
    return `sub-agent ${subAgents.indexOf(thread) + 1}`;
  };
  const lines: string[] = [];
  for (const event of events) {
    const who = threadName(event.thread);
    switch (event.type) {
      case "assistant":
        lines.push(block(`[${who}] assistant:`, event.text.trim() === "" ? "(no text)" : event.text));
        break;
      case "tool_call": {
        const input = renderInput(event.input);
        lines.push(`[${who}] tool call ${event.tool}${input === "" ? "" : `\n${indent(input)}`}`);
        break;
      }
      case "tool_result":
        lines.push(block(`[${who}] tool result${event.isError ? " (error)" : ""}:`, event.output));
        break;
      case "error":
        lines.push(block(`[${who}] error:`, event.message));
        break;
    }
  }
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
