import { Box, Text, useInput } from "ink";
import { useReducer, useRef } from "react";

import { MAIN_THREAD } from "../agents/types.js";
import { clock, formatUsd } from "../print.js";
import { ENVIRONMENTS, type Environment } from "../run-record.js";
import { progress, type BoardState, type FixtureState, type SideState, type ToolLine } from "./state.js";
import { PHASE_GLYPH, SPINNER, Toned, isActive, liveChip, sparkline } from "./style.js";

/**
 * The live board: a header, one row per fixture with a card per side, judge chips as verdicts
 * arrive, and a footer with progress and keys. `⏎` follows the selected side's tool calls in a
 * lower pane; `q` asks, then aborts through the CLI's interruption path.
 */

/** Below this many columns the cards stack and the sparklines drop. */
export const NARROW = 100;
/** From this many columns a card also shows the side's latest tool call. */
export const WIDE = 160;

export type BoardProps = {
  state: BoardState;
  elapsedMs: number;
  /** The spinner's frame; the caller ticks it. */
  frame: number;
  columns: number;
  rows: number;
  /** After `q` and `y`, or Ctrl-C: stop every run. */
  onAbort: () => void;
};

type SideKey = { fixture: string; environment: Environment };

function short(sha: string): string {
  return sha.slice(0, 7);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function Board({ state, elapsedMs, frame, columns, rows, onAbort }: BoardProps) {
  // Keys can arrive faster than frames, so they act on a ref, not on the last render's state.
  const keys = useRef<{ selected: number; following: SideKey | null; confirming: boolean }>({
    selected: 0,
    following: null,
    confirming: false,
  });
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // A `judge` session has no batch.start and no sides to select, only chips.
  const hasSides = state.stamp !== null;
  const sides: SideKey[] = hasSides
    ? state.fixtures.flatMap((each) => ENVIRONMENTS.map((environment) => ({ fixture: each.id, environment })))
    : [];
  const { following, confirming } = keys.current;
  const current = sides[Math.min(keys.current.selected, sides.length - 1)];

  useInput((input, key) => {
    const now = keys.current;
    if (key.ctrl && input === "c") return onAbort();
    if (now.confirming) {
      if (input === "y") return onAbort();
      if (input === "n" || key.escape) now.confirming = false;
    } else if (input === "q") now.confirming = true;
    else if (key.upArrow) now.selected = Math.max(0, Math.min(now.selected, sides.length - 1) - 1);
    else if (key.downArrow) now.selected = Math.max(0, Math.min(sides.length - 1, now.selected + 1));
    else if (key.return) now.following = sides[Math.min(now.selected, sides.length - 1)] ?? null;
    else if (key.escape) now.following = null;
    else return;
    redraw();
  });

  const narrow = columns < NARROW;
  const nameWidth = Math.max(0, ...state.fixtures.map((each) => each.id.length));
  const followed =
    following === null ? undefined : state.fixtures.find((each) => each.id === following.fixture)?.sides[following.environment];

  return (
    <Box flexDirection="column" width={columns}>
      <Header state={state} elapsedMs={elapsedMs} />
      {state.sameHarness ? (
        <Box width={columns} borderStyle="single" paddingX={1}>
          <Toned tone="warning" bold>
            ⚠ A/A run: both sides use the same harness — deltas are noise
          </Toned>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {state.fixtures.map((each) => (
          <FixtureRow
            key={each.id}
            fixture={each}
            nameWidth={nameWidth}
            columns={columns}
            narrow={narrow}
            hasSides={hasSides}
            selected={current?.fixture === each.id ? current.environment : null}
            frame={frame}
          />
        ))}
      </Box>
      {following !== null && followed !== undefined ? (
        <FollowPane side={following} tools={followed.tools} columns={columns} height={Math.max(5, Math.floor(rows / 2) - 2)} />
      ) : null}
      <Footer state={state} columns={columns} confirming={confirming} following={following !== null} />
    </Box>
  );
}

function Header({ state, elapsedMs }: { state: BoardState; elapsedMs: number }) {
  const parts = [clock(elapsedMs)];
  if (state.harness !== null) parts.push(`previous ${short(state.harness.previous)} → candidate ${short(state.harness.candidate)}`);
  if (state.harnessFilesChanged !== null) parts.push(`${plural(state.harnessFilesChanged, "harness file")} changed`);
  if (state.stamp !== null) parts.push(state.model ?? "model not reported");
  return (
    <Text>
      <Text bold>harnessbench</Text>
      {`  ${parts.join("  ·  ")}`}
    </Text>
  );
}

type FixtureRowProps = {
  fixture: FixtureState;
  nameWidth: number;
  columns: number;
  narrow: boolean;
  hasSides: boolean;
  selected: Environment | null;
  frame: number;
};

function FixtureRow({ fixture, nameWidth, columns, narrow, hasSides, selected, frame }: FixtureRowProps) {
  const cardWidth = narrow ? columns - 2 : Math.floor((columns - nameWidth - 2) / 2);
  const cards = ENVIRONMENTS.map((environment) => (
    <Card
      key={environment}
      environment={environment}
      side={fixture.sides[environment]}
      width={cardWidth}
      sparkline={!narrow}
      latestTool={columns >= WIDE}
      selected={selected === environment}
      frame={frame}
    />
  ));
  return (
    <Box flexDirection="column" marginBottom={narrow ? 1 : 0}>
      {narrow || !hasSides ? (
        <>
          <Text bold>{fixture.id}</Text>
          {hasSides ? <Box flexDirection="column" paddingLeft={2}>{cards}</Box> : null}
        </>
      ) : (
        <Box>
          <Box width={nameWidth + 2}>
            <Text bold>{fixture.id}</Text>
          </Box>
          {cards}
        </Box>
      )}
      {fixture.judges.length > 0 ? <Chips fixture={fixture} indent={narrow || !hasSides ? 2 : nameWidth + 2} /> : null}
    </Box>
  );
}

type CardProps = {
  environment: Environment;
  side: SideState;
  width: number;
  sparkline: boolean;
  latestTool: boolean;
  selected: boolean;
  frame: number;
};

function Card({ environment, side, width, sparkline: spark, latestTool, selected, frame }: CardProps) {
  const active = isActive(side.phase);
  const glyph = PHASE_GLYPH[side.phase];
  const cost = side.costUsd === null ? null : formatUsd(side.costUsd);
  const figures = [plural(side.turns, "turn"), ...(cost === null ? [] : [cost])].join(" · ");
  const tone = side.phase === "failed" ? "worse" : side.phase === "queued" ? "quiet" : "plain";
  let body: string;
  if (side.phase === "done") body = [side.outcome ?? "done", figures].join(" · ");
  else if (side.phase === "failed") body = side.detail ?? "failed";
  else if (side.phase === "queued") body = "queued";
  else body = `${side.phase} ${SPINNER[frame % SPINNER.length]} ${figures}`;
  const warn = side.phase === "done" && side.outcome !== null && side.outcome !== "completed";
  const last = side.tools.at(-1);
  return (
    <Box width={width} paddingRight={1}>
      <Text wrap="truncate-end">
        {selected ? "› " : "  "}
        <Toned tone={warn ? "warning" : tone}>{`${glyph} ${environment.padEnd(9)} `}</Toned>
        <Toned tone={warn ? "warning" : tone}>{warn ? `! ${body}` : body}</Toned>
        {spark && side.outputs.length > 0 ? <Toned tone="quiet">{`  ${sparkline(side.outputs)}`}</Toned> : null}
        {latestTool && active && last !== undefined ? <Toned tone="quiet">{`  ${last.label}`}</Toned> : null}
      </Text>
    </Box>
  );
}

function Chips({ fixture, indent }: { fixture: FixtureState; indent: number }) {
  return (
    <Box paddingLeft={indent} flexWrap="wrap" columnGap={2}>
      {fixture.judges.map((chip) => {
        const look = liveChip(chip.verdict);
        return (
          <Toned key={chip.judge} tone={look.tone}>
            {`${look.glyph} ${chip.judge} ${look.word}`}
          </Toned>
        );
      })}
    </Box>
  );
}

function FollowPane({ side, tools, columns, height }: { side: SideKey; tools: ToolLine[]; columns: number; height: number }) {
  const title = `─ ${side.fixture} ${side.environment} `;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Toned tone="quiet">{`${title}${"─".repeat(Math.max(0, columns - title.length))}`}</Toned>
      {tools.length === 0 ? <Toned tone="quiet">no tool calls yet</Toned> : null}
      {tools.slice(-height).map((tool, i) => (
        <Text key={i} wrap="truncate-middle">
          {tool.thread === MAIN_THREAD ? "" : "    "}
          {tool.failed ? <Toned tone="worse">{`✗ ${tool.label}`}</Toned> : `  ${tool.label}`}
        </Text>
      ))}
    </Box>
  );
}

function Footer({ state, columns, confirming, following }: { state: BoardState; columns: number; confirming: boolean; following: boolean }) {
  const { done, total, unit } = progress(state);
  const width = Math.max(10, Math.min(40, columns - 50));
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return (
    <Box marginTop={1} columnGap={3} flexWrap="wrap">
      <Text>
        {"█".repeat(filled)}
        <Toned tone="quiet">{"░".repeat(width - filled)}</Toned>
        {` ${done}/${total} ${unit}`}
      </Text>
      {confirming ? (
        <Toned tone="warning" bold>
          abort all runs? y/n
        </Toned>
      ) : (
        <Toned tone="quiet">{`↑↓ select  ⏎ follow  ${following ? "esc close  " : ""}q abort`}</Toned>
      )}
    </Box>
  );
}
