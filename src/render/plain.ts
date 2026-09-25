import type { RunEvent, Subscriber } from "../events.js";
import {
  formatBatchPlan,
  formatProgressLine,
  formatProgressText,
  formatRunsFinished,
  formatSameHarness,
} from "../print.js";

/**
 * The stderr progress lines, as a subscriber: exactly what `run` and `judge` have always
 * printed, one line per event, on the event's own clock. Turns and tool calls are not printed.
 */

export type PlainOptions = {
  /** Where each line goes; stderr by default. */
  write?: (line: string) => void;
  /** The fixture column's width until a `batch.start` says otherwise. */
  fixtureWidth?: number;
};

export function plainRenderer(options: PlainOptions = {}): Subscriber {
  const write = options.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let width = options.fixtureWidth ?? 0;
  let recorded = 0;
  const side = (at: number, fixture: string, environment: string, text: string): void =>
    write(formatProgressLine(at, fixture, width, environment, null, text));
  const judge = (at: number, fixture: string, id: string, text: string): void =>
    write(formatProgressLine(at, fixture, width, "judge", id, text));

  return (event: RunEvent) => {
    switch (event.type) {
      case "batch.start":
        width = Math.max(...event.fixtures.map((id) => id.length));
        if (event.sameHarness) write(formatSameHarness(event.harness.previous));
        write(formatBatchPlan(event.fixtures));
        return;
      case "side.phase": {
        const { fixture, environment } = event.side;
        if (event.phase === "setup") side(event.at, fixture, environment, formatProgressText({ kind: "started" }));
        else if (event.phase !== "queued" && event.detail !== undefined) side(event.at, fixture, environment, event.detail);
        return;
      }
      case "side.done":
        recorded++;
        side(event.at, event.side.fixture, event.side.environment, formatProgressText({ kind: "recorded", runId: event.runId }));
        return;
      case "judge.verdict":
        judge(event.at, event.fixture, event.judge, formatProgressText({ kind: "judged", ...event }));
        return;
      case "judge.failed":
        judge(event.at, event.fixture, event.judge, formatProgressText({ kind: "judge failed", ...event }));
        return;
      case "batch.done":
        write(formatRunsFinished(recorded, event.durationMs));
        return;
      case "side.turn":
      case "side.tool":
      case "judge.start":
        return;
    }
  };
}
