import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { Detection } from "./types.js";

/** Agents harnessbench knows how to drive, in the order they are preferred. */
export const KNOWN_AGENTS = ["claude", "codex", "aider", "gemini"] as const;

export type KnownAgent = (typeof KNOWN_AGENTS)[number];

function executableIn(dir: string, name: string, env: NodeJS.ProcessEnv): string | null {
  const extensions =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];

  for (const extension of extensions) {
    const path = join(dir, `${name}${extension}`);
    try {
      const stats = statSync(path);
      if (stats.isFile() && (process.platform === "win32" || (stats.mode & 0o111) !== 0)) {
        return path;
      }
    } catch {
      // Not here; try the next extension.
    }
  }
  return null;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
}

/** Where `name` is on PATH, or null when it is not. Any name, not just a known agent. */
export function agentPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of pathDirs(env)) {
    const path = executableIn(dir, name, env);
    if (path !== null) return path;
  }
  return null;
}

/** Which known agents are installed, in KNOWN_AGENTS order. Null when none are. */
export function agentsOnPath(env: NodeJS.ProcessEnv = process.env): Detection<string[]> | null {
  const found = KNOWN_AGENTS.filter((name) => agentPath(name, env) !== null);
  return found.length === 0 ? null : { value: [...found], source: "PATH" };
}
