import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { Detection } from "./types.js";

/** Agents harnessbench knows how to drive, in the order they are preferred. */
export const KNOWN_AGENTS = ["claude", "codex", "aider", "gemini"] as const;

export type KnownAgent = (typeof KNOWN_AGENTS)[number];

function executableIn(dir: string, name: string, env: NodeJS.ProcessEnv): boolean {
  const extensions =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];

  return extensions.some((extension) => {
    try {
      const stats = statSync(join(dir, `${name}${extension}`));
      return stats.isFile() && (process.platform === "win32" || (stats.mode & 0o111) !== 0);
    } catch {
      return false;
    }
  });
}

/** Which known agents are installed, in KNOWN_AGENTS order. Null when none are. */
export function agentsOnPath(env: NodeJS.ProcessEnv = process.env): Detection<string[]> | null {
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  const found = KNOWN_AGENTS.filter((name) => dirs.some((dir) => executableIn(dir, name, env)));
  return found.length === 0 ? null : { value: [...found], source: "PATH" };
}
