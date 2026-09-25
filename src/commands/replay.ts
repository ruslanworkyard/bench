import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { RUNS_DIR } from "../config.js";
import { CliError } from "../errors.js";
import { EventBus, type RunEvent, type SessionLine } from "../events.js";
import { requireConfig, requireGit, requireRepo } from "../preflight.js";
import { plainRenderer } from "../render/plain.js";
import type { BatchReport } from "../report.js";
import { EVENTS_FILE, REPORT_JSON, REPORT_MARKDOWN, latestBatch, listBatches, reportDir } from "../run-record.js";
import { printReport, type ReportOutput } from "./compare.js";

export type ReplayOptions = ReportOutput & {
  cwd: string;
  /** The batch with this stamp; when absent, the latest batch. */
  stamp?: string | undefined;
  /** Original spacing divided by this; 0 replays at once. */
  speed: number;
  /** The plain renderer; for now the only one. */
  plain: boolean;
};

export type ReplayResult = { stamp: string; events: number; report: BatchReport };

/**
 * A batch's recorded `events.jsonl` re-emitted on a bus with its original spacing divided by
 * `speed`, then its `report.json` printed as the final state, as `run` would have. A session
 * line (a later `judge`) restarts the clock: the gap between commands is not replayed.
 */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  requireGit();
  const root = requireRepo(options.cwd);
  requireConfig(root);
  const stamp = options.stamp ?? latestStamp(root);
  const dir = join(root, reportDir(stamp));
  if (options.stamp !== undefined && !listBatches(join(root, RUNS_DIR)).some((each) => each.stamp === stamp)) {
    throw new CliError(`no runs with stamp '${stamp}' in ${RUNS_DIR}; replay takes a stamp as \`run\` printed it`, 1);
  }
  const path = join(dir, EVENTS_FILE);
  if (!existsSync(path)) {
    throw new CliError(
      `batch ${stamp} has no ${EVENTS_FILE}: it predates event recording. ` +
        `\`harnessbench compare --stamp ${stamp}\` still prints its report; a new \`harnessbench run\` records its events.`,
      1,
    );
  }
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, i) => (line.trim() === "" ? [] : [parseLine(line, i + 1, stamp)]));

  const bus = new EventBus();
  bus.subscribe(plainRenderer());
  let previousAt = 0;
  let events = 0;
  for (const line of lines) {
    if (line.type === "session") {
      previousAt = 0;
      continue;
    }
    if (options.speed > 0 && line.at > previousAt) await sleep((line.at - previousAt) / options.speed);
    previousAt = line.at;
    bus.emit(line);
    events++;
  }

  const reportPath = join(dir, REPORT_JSON);
  if (!existsSync(reportPath)) {
    throw new CliError(`batch ${stamp} has no ${REPORT_JSON}; \`harnessbench compare --stamp ${stamp}\` writes it again`, 1);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as BatchReport;
  printReport(report, options, `${reportDir(stamp)}/${REPORT_MARKDOWN}`);
  return { stamp, events, report };
}

function latestStamp(root: string): string {
  const batch = latestBatch(join(root, RUNS_DIR));
  if (batch === null) throw new CliError(`no runs in ${RUNS_DIR} - run \`harnessbench run\` first`, 1);
  return batch.stamp;
}

function parseLine(line: string, number: number, stamp: string): RunEvent | SessionLine {
  try {
    return JSON.parse(line) as RunEvent | SessionLine;
  } catch {
    throw new CliError(`${reportDir(stamp)}/${EVENTS_FILE} line ${number} is not JSON; the file was cut short or edited`, 1);
  }
}
