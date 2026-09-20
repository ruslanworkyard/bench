import assert from "node:assert/strict";
import { test } from "node:test";

import type { Comparison, Row } from "./compare.js";
import { NOISE_LINE, formatComparison, formatComparisonMarkdown } from "./print.js";

function row(patch: Partial<Row> & { id: string; label: string }): Row {
  return { previous: "1", candidate: "1", delta: "", classification: "unchanged", ...patch };
}

/** A comparison with one very wide value in each column, to exercise the alignment. */
function comparison(warnings: string[] = []): Comparison {
  return {
    fixture: "ttl-cache",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    previous: { runId: "20260919-031455-ttl-cache-previous", harnessSha: "9c21e6389abcdef0123456789abcdef01234567", model: "claude-sonnet-4-5" },
    candidate: { runId: "20260919-031455-ttl-cache-candidate", harnessSha: "0123456789abcdef0123456789abcdef01234567", model: null },
    rows: [
      row({ id: "outcome", label: "Outcome", previous: "completed", candidate: "completed" }),
      row({ id: "tests", label: "Tests", previous: "not configured", candidate: "passed", classification: "n/a", note: "no test command configured" }),
      row({ id: "tokens.total", label: "Tokens", previous: "1,203,000", candidate: "960,000", delta: "-21%", classification: "improved" }),
      row({ id: "toolCalls", label: "Tool calls", previous: "18", candidate: "15", delta: "-3", note: "within noise" }),
      row({ id: "durationMs", label: "Duration", previous: "3m48s", candidate: "1h02m", delta: "+1,532%", classification: "regressed" }),
    ],
    warnings,
  };
}

/** The column at which `word` starts on each line that contains it. */
function columnOf(lines: string[], word: string): number[] {
  return lines.filter((line) => line.includes(word)).map((line) => line.indexOf(word));
}

test("formatComparison aligns every column to its widest value", () => {
  const text = formatComparison(comparison());
  const lines = text.split("\n");

  assert.equal(lines[0], "harnessbench compare  ttl-cache · code 0123456");
  assert.ok(lines.includes("Harness    previous 9c21e63 → candidate 0123456"));
  assert.ok(lines.includes("Model      previous claude-sonnet-4-5 → candidate not reported"));
  assert.ok(lines.includes("Runs       20260919-031455-ttl-cache-previous → 20260919-031455-ttl-cache-candidate"));
  assert.ok(lines.includes(NOISE_LINE));
  assert.ok(!text.includes("warning:"));

  const table = lines.slice(lines.indexOf(NOISE_LINE) + 2);
  assert.equal(table.length, 5);
  // Every column starts where it starts on the widest row: the arrow, the delta, the word.
  const arrows = table.map((line) => line.indexOf("→"));
  assert.equal(new Set(arrows).size, 1, `arrows at ${arrows.join(", ")}`);
  const words = table.map((line) => line.search(/unchanged|improved|regressed|n\/a/));
  assert.equal(new Set(words).size, 1, `classifications at ${words.join(", ")}`);
  assert.equal(columnOf(table, "-21%")[0], columnOf(table, "+1,532%")[0]);
  // The note sits after the classification, and lines carry no trailing padding.
  assert.match(table[3] as string, /Tool calls\s+18\s+→ 15\s+-3\s+unchanged\s+within noise$/);
  for (const line of table) assert.equal(line, line.trimEnd());
});

test("formatComparison prints warnings after the noise line, each prefixed", () => {
  const lines = formatComparison(comparison(["models differ", "same harness"])).split("\n");
  const at = lines.indexOf(NOISE_LINE);
  assert.equal(lines[at + 1], "warning: models differ");
  assert.equal(lines[at + 2], "warning: same harness");
  assert.equal(lines[at + 3], "");
});

test("formatComparisonMarkdown renders a valid GitHub table with the same content", () => {
  const text = formatComparisonMarkdown(comparison(["models | differ"]));
  const lines = text.split("\n");

  assert.equal(lines[0], "### harnessbench: `ttl-cache`");
  assert.match(text, /Harness `previous` 9c21e63 → `candidate` 0123456, both on code 0123456\./);
  assert.match(text, /Model: previous claude-sonnet-4-5 → candidate not reported\./);
  assert.match(text, /Runs `20260919-031455-ttl-cache-previous` and `20260919-031455-ttl-cache-candidate`\./);
  assert.ok(lines.includes(`_${NOISE_LINE}_`));
  assert.ok(lines.includes("> **warning:** models \\| differ"));

  const header = lines.indexOf("| Criterion | Previous | Candidate | Delta | Result | Note |");
  assert.notEqual(header, -1);
  assert.equal(lines[header + 1], "|---|---|---|---|---|---|");
  const body = lines.slice(header + 2);
  assert.equal(body.length, 5);
  for (const line of body) {
    assert.match(line, /^\| .* \|$/);
    assert.equal(line.split(" | ").length, 6, line);
  }
  assert.equal(body[1], "| Tests | not configured | passed |  | n/a | no test command configured |");
  assert.equal(body[2], "| Tokens | 1,203,000 | 960,000 | -21% | improved |  |");
  // A blank line separates every block, so the table is not glued to the paragraph above it.
  assert.equal(lines[header - 1], "");
});
