import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ToolKind } from "./agents/types.js";
import type { Environment, RunOutcome } from "./run-record.js";

/**
 * Every meaningful moment of a command as a typed fact. Work emits events; rendering and
 * recording subscribe to them. Nothing that renders ever computes: it reads events and, at
 * the end, the batch's `BatchReport`.
 */

export type SideRef = { fixture: string; environment: Environment };

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** An event without its clock; `emitter` stamps it. */
export type RunEventBody =
  | {
      type: "batch.start";
      stamp: string;
      fixtures: string[];
      harness: { previous: string; candidate: string };
      sameHarness: boolean;
      /** Harness files whose contents differ between the two sides; absent in older recordings. */
      harnessFilesChanged?: number;
      agent: { name: string; model: string | null };
    }
  /**
   * A side entering a phase. `detail` says how the phase before it ended, in the words the
   * progress line uses (`setup ok (npm ci, 4.1s)`, `agent completed (30 turns)`, `tests passed
   * (0.8s)`); on `failed` it is the setup failure, absent for any other failure.
   */
  | {
      type: "side.phase";
      side: SideRef;
      phase: "queued" | "setup" | "agent" | "tests" | "done" | "failed";
      detail?: string;
    }
  /** An assistant message completed; `tokens` are running totals, `costUsd` the latest the stream reported. */
  | { type: "side.turn"; side: SideRef; turn: number; tokens: Tokens; costUsd: number | null }
  /** A tool call, or (`failed`) a tool call whose result was an error. */
  | { type: "side.tool"; side: SideRef; thread: string; kind: ToolKind; label: string; failed: boolean }
  | { type: "side.done"; side: SideRef; outcome: RunOutcome; runId: string }
  | { type: "judge.start"; fixture: string; judge: string }
  | {
      type: "judge.verdict";
      fixture: string;
      judge: string;
      preference: Environment | "tie";
      durationMs: number;
      /** Who served the call behind a router; the progress line names it. */
      upstream: string | null;
    }
  | { type: "judge.failed"; fixture: string; judge: string; message: string; durationMs: number }
  | { type: "batch.done"; durationMs: number; exitCode: number };

/** `at`: milliseconds since the command started. */
export type RunEvent = { at: number } & RunEventBody;

/** Emits an event body, stamped on the caller's clock. */
export type Emit = (body: RunEventBody) => void;

export type Subscriber = (event: RunEvent) => void;

/**
 * The line `judge` writes before its first event in a batch's `events.jsonl`: its events' `at`
 * count from its own start, so a replay can tell the sessions apart.
 */
export type SessionLine = { type: "session"; command: "judge" | "compare"; startedAt: string };

/** A tiny typed emitter. A subscriber that throws is reported as a warning; the others still hear the event. */
export class EventBus {
  private readonly subscribers: Subscriber[] = [];

  emit(event: RunEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        process.emitWarning(`an event subscriber failed on ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  subscribe(subscriber: Subscriber): void {
    this.subscribers.push(subscriber);
  }
}

/** `emit` for a command whose clock started at `startedAt` (`Date.now()`). */
export function emitter(bus: EventBus, startedAt: number): Emit {
  return (body) => bus.emit({ at: Date.now() - startedAt, ...body });
}

/**
 * Appends every event to `path` as one JSON line, creating its directory on the first. With a
 * `session`, that line goes first, and only once there is an event to follow it.
 */
export function recorder(path: string, session?: SessionLine): Subscriber {
  let started = false;
  return (event) => {
    if (!started) {
      mkdirSync(dirname(path), { recursive: true });
      if (session !== undefined) appendFileSync(path, `${JSON.stringify(session)}\n`, "utf8");
      started = true;
    }
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  };
}
