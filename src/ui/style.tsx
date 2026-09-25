import { Text } from "ink";
import { createContext, useContext, type ReactNode } from "react";

import type { Classification } from "../compare.js";
import type { Environment } from "../run-record.js";
import type { Phase } from "./state.js";

/**
 * Colour is semantic only, and every signal also has a glyph, so `NO_COLOR` loses nothing:
 * green better, red worse, amber warning, dim unchanged or noise.
 */

export type Tone = "better" | "worse" | "warning" | "quiet" | "plain";

const COLOURS: Record<Tone, string | undefined> = { better: "green", worse: "red", warning: "yellow", quiet: undefined, plain: undefined };

/** True under `NO_COLOR`: tones keep their glyphs and lose their colour. */
export const NoColor = createContext(false);

export function Toned({ tone, bold, children }: { tone: Tone; bold?: boolean; children: ReactNode }) {
  const noColor = useContext(NoColor);
  const color = noColor ? undefined : COLOURS[tone];
  return (
    <Text {...(color === undefined ? {} : { color })} dimColor={tone === "quiet"} bold={bold === true}>
      {children}
    </Text>
  );
}

export const PHASE_GLYPH: Record<Phase, string> = { queued: "○", setup: "◐", agent: "●", tests: "◆", done: "✓", failed: "✗" };

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function isActive(phase: Phase): boolean {
  return phase === "setup" || phase === "agent" || phase === "tests";
}

const BARS = "▁▂▃▄▅▆▇█";

/** One bar per value, scaled to the largest; empty for no values. */
export function sparkline(values: number[]): string {
  const max = Math.max(0, ...values);
  if (max === 0) return values.map(() => BARS[0]).join("");
  return values.map((n) => BARS[Math.min(BARS.length - 1, Math.floor((n / max) * (BARS.length - 1)))]).join("");
}

/** A delta's arrow and tone: `▲` improved, `▼` regressed, `=` unchanged, `–` no verdict. */
export const DELTA: Record<Classification, { glyph: string; tone: Tone }> = {
  improved: { glyph: "▲", tone: "better" },
  regressed: { glyph: "▼", tone: "worse" },
  unchanged: { glyph: "=", tone: "quiet" },
  "n/a": { glyph: "–", tone: "quiet" },
};

/** A judge row's chip: `⬤` candidate preferred, `○` previous, `·` tie, `–` not judged. */
export const CHIP: Record<Classification, { glyph: string; tone: Tone; word: string }> = {
  improved: { glyph: "⬤", tone: "better", word: "candidate" },
  regressed: { glyph: "○", tone: "worse", word: "previous" },
  unchanged: { glyph: "·", tone: "quiet", word: "tie" },
  "n/a": { glyph: "–", tone: "quiet", word: "not judged" },
};

/** A live verdict on the board, in the same glyphs; `◌` while the call is in flight. */
export function liveChip(verdict: Environment | "tie" | "failed" | null): { glyph: string; tone: Tone; word: string } {
  switch (verdict) {
    case null:
      return { glyph: "◌", tone: "quiet", word: "judging" };
    case "candidate":
      return CHIP.improved;
    case "previous":
      return CHIP.regressed;
    case "tie":
      return CHIP.unchanged;
    case "failed":
      return { glyph: "✗", tone: "warning", word: "failed" };
  }
}
