import { posix } from "node:path";

/**
 * Which of the agent's files are tests, and the test command narrowed to them. Pure: the diff's
 * `git diff --name-status` lines in, paths or a command out; `commands/run.ts` runs it.
 */

const PLACEHOLDERS = /\{files\}|\{dirs\}/;

/**
 * The paths from `git diff --name-status` lines (`M\tsrc/a.test.ts`) that were added or
 * modified, not deleted, and match any of `globs`; sorted, each once.
 */
export function selectTests(diffPaths: string[], globs: string[]): string[] {
  const patterns = globs.map(globToRegex);
  const selected = new Set<string>();
  for (const line of diffPaths) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const status = line.slice(0, tab);
    const path = line.slice(tab + 1);
    if (status.startsWith("D")) continue;
    if (patterns.some((pattern) => pattern.test(path))) selected.add(path);
  }
  return [...selected].sort();
}

/**
 * A repo-relative glob as an anchored regex: `**` spans directories (`**\/` also matches none),
 * `*` and `?` stay within one path segment, everything else is literal.
 */
export function globToRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function hasPlaceholder(command: string): boolean {
  return PLACEHOLDERS.test(command);
}

/**
 * `command` with `{files}` (the files) and `{dirs}` (their directories, `./`-prefixed) filled
 * in, each shell-quoted, sorted, space-separated. A command without either comes back unchanged; one
 * with a placeholder and no files is null: there is nothing to run.
 */
export function expandTestCommand(command: string, files: string[]): string | null {
  if (!hasPlaceholder(command)) return command;
  if (files.length === 0) return null;
  const sorted = [...new Set(files)].sort();
  const dirs = [...new Set(sorted.map(directory))].sort();
  const lists = { files: sorted, dirs };
  // One pass, so a file whose name contains a placeholder is never expanded again.
  return command.replace(/\{(files|dirs)\}/g, (_, key: "files" | "dirs") => lists[key].map(shellQuote).join(" "));
}

/** `./src/cache`; `.` for a file at the root. */
function directory(file: string): string {
  const dir = posix.dirname(file);
  return dir === "." ? "." : `./${dir}`;
}

/** As is when the shell would read it as one plain word, single-quoted otherwise. */
export function shellQuote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
