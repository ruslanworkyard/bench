import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { JUDGE_ROW_PREFIX, type Row } from "../compare.js";
import { reportHeader, verdictLines } from "../print.js";
import type { BatchReport, ReportFixture } from "../report.js";
import { CHIP, DELTA, Toned, type Tone } from "./style.js";

/**
 * The batch's report, once it exists: the verdict lines, one row per fixture with its headline
 * deltas and judge chips, and below the selected fixture's judge reasons or (`⇥`) its full
 * comparison table. Everything shown is read from the `BatchReport`; nothing is computed.
 */

export type ResultsProps = {
  report: BatchReport;
  columns: number;
  /** `r`: opens the report, or says where it is; returns the line to show. */
  onOpenReport: () => string;
  onQuit: () => void;
};

/** The rows a fixture line shows, by id, with a short label. */
const HEADLINE: Array<[string, string]> = [
  ["turns", "turns"],
  ["costUsd", "cost"],
  ["readsBeforeFirstEdit", "reads before edit"],
];

function isJudgeRow(row: Row): boolean {
  return row.id.startsWith(JUDGE_ROW_PREFIX);
}

/**
 * The tone and arrow of one ` · `-separated part of a verdict line, by the word it opens with:
 * improved and candidate are better, regressed and previous worse; a zero count is quiet.
 */
function segmentLook(segment: string): { glyph: string; tone: Tone } {
  if (/\s0$/.test(segment)) return { glyph: "", tone: "quiet" };
  const word = segment.split(/[\s:]/)[0];
  if (word === "improved" || word === "candidate") return { glyph: "▲ ", tone: "better" };
  if (word === "regressed" || word === "previous") return { glyph: "▼ ", tone: "worse" };
  if (word === "unchanged" || word === "tie" || word === "not") return { glyph: "", tone: "quiet" };
  return { glyph: "", tone: "plain" };
}

export function Results({ report, columns, onOpenReport, onQuit }: ResultsProps) {
  const [selected, setSelected] = useState(0);
  const [pane, setPane] = useState<"reasons" | "table">("reasons");
  const [status, setStatus] = useState<string | null>(null);
  const fixture = report.fixtures[Math.min(selected, report.fixtures.length - 1)];

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) onQuit();
    else if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(report.fixtures.length - 1, i + 1));
    else if (key.tab) setPane((each) => (each === "reasons" ? "table" : "reasons"));
    else if (input === "r") setStatus(onOpenReport());
  });

  const nameWidth = Math.max(0, ...report.fixtures.map((each) => each.fixture.length));
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>{reportHeader(report)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {report.rollup.warnings.map((warning, i) => (
          <Toned key={i} tone="warning">{`⚠ ${warning}`}</Toned>
        ))}
        {verdictLines(report).map(([label, text]) => (
          <Text key={label} wrap="wrap">
            {label.padEnd(12)}
            {text.split(" · ").map((segment, i) => {
              const look = segmentLook(segment);
              return (
                <Text key={i}>
                  {i === 0 ? "" : " · "}
                  <Toned tone={look.tone}>{`${look.glyph}${segment}`}</Toned>
                </Text>
              );
            })}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {report.fixtures.map((each, i) => (
          <FixtureLine key={each.fixture} fixture={each} nameWidth={nameWidth} selected={i === selected} />
        ))}
      </Box>
      {fixture === undefined ? null : pane === "reasons" ? (
        <Reasons fixture={fixture} columns={columns} />
      ) : (
        <Table fixture={fixture} columns={columns} />
      )}
      <Box marginTop={1} columnGap={3} flexWrap="wrap">
        <Toned tone="quiet">{`↑↓ select  ⇥ ${pane === "reasons" ? "table" : "reasons"}  r report  q quit`}</Toned>
        {status === null ? null : <Text>{status}</Text>}
      </Box>
    </Box>
  );
}

function FixtureLine({ fixture, nameWidth, selected }: { fixture: ReportFixture; nameWidth: number; selected: boolean }) {
  const rows = fixture.comparison?.rows ?? [];
  const judges = rows.filter(isJudgeRow);
  const trouble = fixture.error ?? (fixture.comparison === null ? "not compared" : null);
  return (
    <Box flexWrap="wrap" columnGap={2}>
      <Text bold={selected}>{`${selected ? "›" : " "} ${fixture.fixture.padEnd(nameWidth)}`}</Text>
      {trouble !== null ? <Toned tone="warning">{`⚠ ${trouble.split("\n")[0] ?? ""}`}</Toned> : null}
      {HEADLINE.map(([id, label]) => {
        const row = rows.find((each) => each.id === id);
        if (row === undefined) return null;
        const look = DELTA[row.classification];
        const change = row.delta === "" ? `${row.previous}→${row.candidate}` : row.delta;
        return <Toned key={id} tone={look.tone}>{`${label} ${change} ${look.glyph}`}</Toned>;
      })}
      {judges.length > 0 ? (
        <Text>
          {judges.map((row, i) => (
            <Toned key={row.id} tone={CHIP[row.classification].tone}>{`${i === 0 ? "" : " "}${CHIP[row.classification].glyph}`}</Toned>
          ))}
        </Text>
      ) : null}
    </Box>
  );
}

function Reasons({ fixture, columns }: { fixture: ReportFixture; columns: number }) {
  const judges = (fixture.comparison?.rows ?? []).filter(isJudgeRow);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Toned tone="quiet">{`─ ${fixture.fixture}: judges ${"─".repeat(Math.max(0, columns - fixture.fixture.length - 12))}`}</Toned>
      {judges.length === 0 ? <Toned tone="quiet">no judge verdicts</Toned> : null}
      {judges.map((row) => {
        const chip = CHIP[row.classification];
        return (
          <Box key={row.id} flexDirection="column" marginBottom={1}>
            <Toned tone={chip.tone} bold>{`${chip.glyph} ${row.label}: ${chip.word}`}</Toned>
            <Box paddingLeft={2} width={columns}>
              <Text wrap="wrap">{row.note ?? ""}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Table({ fixture, columns }: { fixture: ReportFixture; columns: number }) {
  const rows = fixture.comparison?.rows ?? [];
  const width = (pick: (row: Row) => string): number => Math.max(0, ...rows.map((row) => pick(row).length));
  const label = width((row) => row.label);
  const previous = width((row) => row.previous);
  const candidate = width((row) => row.candidate);
  const delta = width((row) => row.delta);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Toned tone="quiet">{`─ ${fixture.fixture}: comparison ${"─".repeat(Math.max(0, columns - fixture.fixture.length - 16))}`}</Toned>
      {rows.length === 0 ? <Toned tone="quiet">no comparison</Toned> : null}
      {rows.map((row) => {
        const look = DELTA[row.classification];
        const cells = `${row.label.padEnd(label)}  ${row.previous.padEnd(previous)}  ${row.candidate.padEnd(candidate)}  ${row.delta.padEnd(delta)}`;
        return (
          <Text key={row.id} wrap="truncate-end">
            {cells}
            {"  "}
            <Toned tone={look.tone}>{`${look.glyph} ${row.classification}`}</Toned>
          </Text>
        );
      })}
    </Box>
  );
}
