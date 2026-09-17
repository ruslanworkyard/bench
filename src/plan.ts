import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The only changes harnessbench init makes. Paths are absolute. */
export type FileOp =
  | { kind: "mkdir"; path: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "appendLine"; path: string; line: string };

export type OpStatus = "created" | "skipped" | "present" | "appended";

export type AppliedOp = { op: FileOp; status: OpStatus };

export type ApplyOptions = { dryRun: boolean };

function applyOne(op: FileOp, dryRun: boolean): OpStatus {
  switch (op.kind) {
    case "mkdir": {
      if (existsSync(op.path)) return "present";
      if (!dryRun) mkdirSync(op.path, { recursive: true });
      return "created";
    }
    case "write": {
      // Never clobber: an existing file is the user's, not ours.
      if (existsSync(op.path)) return "skipped";
      if (!dryRun) {
        mkdirSync(dirname(op.path), { recursive: true });
        writeFileSync(op.path, op.content, "utf8");
      }
      return "created";
    }
    case "appendLine": {
      const existing = existsSync(op.path) ? readFileSync(op.path, "utf8") : null;
      if (existing !== null && existing.split("\n").some((line) => line.trim() === op.line)) {
        return "present";
      }
      if (!dryRun) {
        const separator = existing === null || existing === "" || existing.endsWith("\n") ? "" : "\n";
        appendFileSync(op.path, `${separator}${op.line}\n`, "utf8");
      }
      return "appended";
    }
  }
}

/** The one place that touches the filesystem. With dryRun, only reports what would happen. */
export function apply(ops: readonly FileOp[], options: ApplyOptions): AppliedOp[] {
  return ops.map((op) => ({ op, status: applyOne(op, options.dryRun) }));
}
