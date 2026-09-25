import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Detection } from "./types.js";

/**
 * Which files are tests, as `testFiles` globs, from the ecosystems a repository shows evidence
 * of. The globs name test files by convention only; none reaches into `node_modules/`,
 * `vendor/` or `.harnessbench/`.
 */

export type Ecosystem = "javascript" | "python" | "php" | "ruby" | "go";

type Found = { ecosystem: Ecosystem; evidence: string; globs: string[] };

function read(root: string, name: string): string | null {
  try {
    return readFileSync(join(root, name), "utf8");
  } catch {
    return null;
  }
}

function has(root: string, name: string): boolean {
  return existsSync(join(root, name));
}

/** A JSON manifest as an object, or null when it is absent or unreadable. */
export function readJson(root: string, name: string): Record<string, unknown> | null {
  const raw = read(root, name);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `section[name]` of a JSON manifest exists: a dependency in `devDependencies`, `require-dev`. */
export function declares(manifest: Record<string, unknown> | null, section: string, name: string): boolean {
  const deps = manifest?.[section];
  return typeof deps === "object" && deps !== null && name in deps;
}

export function usesPest(root: string): boolean {
  return declares(readJson(root, "composer.json"), "require-dev", "pestphp/pest");
}

/** `gem "rspec"` or `gem 'rspec-rails'` in the Gemfile. */
export function usesRspec(root: string): boolean {
  return /\brspec\b/.test(read(root, "Gemfile") ?? "");
}

/** Every `requirements*.txt` at the root (`requirements.txt`, `requirements-dev.txt`), by name. */
export function requirementsFiles(root: string): string[] {
  try {
    return readdirSync(root).filter((name) => /^requirements.*\.txt$/.test(name)).sort();
  } catch {
    return [];
  }
}

function found(root: string): Found[] {
  const all: Found[] = [];
  if (has(root, "package.json")) {
    all.push({ ecosystem: "javascript", evidence: "package.json", globs: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"] });
  }
  // conftest.py and pytest.ini as well: whatever makes the command detector pick pytest must
  // also give it test files to run.
  const python = ["pyproject.toml", "setup.py", ...requirementsFiles(root), "conftest.py", "pytest.ini"].find((name) => has(root, name));
  if (python !== undefined) {
    all.push({ ecosystem: "python", evidence: python, globs: ["**/test_*.py", "**/*_test.py"] });
  }
  if (has(root, "composer.json")) {
    const pest = usesPest(root);
    all.push({
      ecosystem: "php",
      evidence: pest ? "composer.json with Pest" : "composer.json",
      globs: pest ? ["tests/**/*Test.php", "tests/**/*.php"] : ["tests/**/*Test.php"],
    });
  }
  if (usesRspec(root)) all.push({ ecosystem: "ruby", evidence: "Gemfile with rspec", globs: ["spec/**/*_spec.rb"] });
  if (has(root, "go.mod")) all.push({ ecosystem: "go", evidence: "go.mod", globs: ["**/*_test.go"] });
  return all;
}

/** The ecosystems with test-file evidence, in the order `testFiles` lists them. */
export function testEcosystems(root: string): Ecosystem[] {
  return found(root).map((each) => each.ecosystem);
}

/** The union of every present ecosystem's globs; null when none is present. */
export function testFiles(root: string): Detection<string[]> | null {
  const all = found(root);
  if (all.length === 0) return null;
  return { value: all.flatMap((each) => each.globs), source: all.map((each) => each.evidence).join(", ") };
}
