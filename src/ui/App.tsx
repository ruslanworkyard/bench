import { Static, Text, useApp, useStdout } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { RunEvent } from "../events.js";
import { formatSummaryReport } from "../print.js";
import type { BatchReport } from "../report.js";
import { Board } from "./Board.js";
import { Results } from "./Results.js";
import { initialState, reduce, type BoardState } from "./state.js";

/**
 * The root: the board while events arrive, the results once the report is shown, and on quit
 * the plain summary in `Static`, so the terminal's history keeps the result.
 */

export type Snapshot = {
  board: BoardState;
  report: { report: BatchReport; path: string | null } | null;
  /** The first event's clock, and when it arrived on this process's clock. */
  first: { at: number; wall: number } | null;
};

/** Holds the snapshot outside React so events can arrive before, and between, renders. */
export class Store {
  private snapshot: Snapshot = { board: initialState, report: null, first: null };
  private readonly listeners = new Set<() => void>();

  get = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(event: RunEvent, now = Date.now()): void {
    const first = this.snapshot.first ?? { at: event.at, wall: now };
    this.set({ ...this.snapshot, board: reduce(this.snapshot.board, event), first });
  }

  show(report: BatchReport, path: string | null): void {
    this.set({ ...this.snapshot, report: { report, path } });
  }

  private set(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export type AppProps = {
  store: Store;
  onAbort: () => void;
  onOpenReport: (path: string | null) => string;
  /** Event time runs this many times faster than wall time (a replay's `--speed`); 0 shows the events' own clock. */
  speed?: number;
  /** False in tests: no spinner, no ticking clock, so frames are deterministic. */
  animate?: boolean;
  /** Overrides the terminal's size, for tests. */
  columns?: number;
  rows?: number;
};

const TICK_MS = 100;

export function App({ store, onAbort, onOpenReport, speed = 1, animate = true, columns, rows }: AppProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [now, setNow] = useState(Date.now());
  const [quitting, setQuitting] = useState(false);
  const live = animate && snapshot.report === null && snapshot.board.done === null;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (quitting) exit();
  }, [quitting, exit]);

  const width = columns ?? stdout.columns ?? 80;
  const height = rows ?? stdout.rows ?? 24;

  if (snapshot.report !== null) {
    const { report, path } = snapshot.report;
    if (quitting) {
      return <Static items={[formatSummaryReport(report, path)]}>{(summary) => <Text key="summary">{summary}</Text>}</Static>;
    }
    return <Results report={report} columns={width} onOpenReport={() => onOpenReport(path)} onQuit={() => setQuitting(true)} />;
  }

  const { board, first } = snapshot;
  const running = first === null || speed === 0 ? board.lastAt : first.at + (now - first.wall) * speed;
  const elapsedMs = board.done?.durationMs ?? Math.max(board.lastAt, running);
  return (
    <Board
      state={board}
      elapsedMs={elapsedMs}
      frame={animate ? Math.floor(now / TICK_MS) : 0}
      columns={width}
      rows={height}
      onAbort={onAbort}
    />
  );
}
