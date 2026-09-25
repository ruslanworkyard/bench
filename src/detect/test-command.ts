import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { declares, readJson, requirementsFiles, testEcosystems, usesPest, usesRspec, type Ecosystem } from "./test-files.js";
import type { Detection } from "./types.js";

/** `npm init` seeds a scripts.test that only prints an error; it means "no tests". */
const NPM_PLACEHOLDER = /no test specified/i;
/** A `test:` recipe, but not a `test := ...` variable assignment. */
const MAKE_TEST_TARGET = /^test[ \t]*:(?!=)/m;

type Probe = (root: string) => Detection<string> | null;

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

const npmTest: Probe = (root) => {
  const raw = read(root, "package.json");
  if (raw === null) return null;
  let scripts: unknown;
  try {
    scripts = (JSON.parse(raw) as { scripts?: unknown }).scripts;
  } catch {
    return null;
  }
  if (typeof scripts !== "object" || scripts === null) return null;
  const test = (scripts as Record<string, unknown>)["test"];
  if (typeof test !== "string" || test.trim() === "" || NPM_PLACEHOLDER.test(test)) return null;
  return { value: "npm test", source: "package.json scripts.test" };
};

const pytest: Probe = (root) => {
  const pyproject = read(root, "pyproject.toml");
  if (pyproject !== null && pyproject.includes("pytest")) {
    return { value: "pytest", source: "pyproject.toml mentions pytest" };
  }
  if (has(root, "pytest.ini")) return { value: "pytest", source: "pytest.ini" };
  const setupCfg = read(root, "setup.cfg");
  if (setupCfg !== null && setupCfg.includes("pytest")) {
    return { value: "pytest", source: "setup.cfg mentions pytest" };
  }
  return null;
};

const goTest: Probe = (root) =>
  has(root, "go.mod") ? { value: "go test ./...", source: "go.mod" } : null;

const cargoTest: Probe = (root) =>
  has(root, "Cargo.toml") ? { value: "cargo test", source: "Cargo.toml" } : null;

const makeTest: Probe = (root) => {
  for (const name of ["Makefile", "makefile"]) {
    const makefile = read(root, name);
    if (makefile !== null && MAKE_TEST_TARGET.test(makefile)) {
      return { value: "make test", source: `${name} test target` };
    }
  }
  return null;
};

const phpunit: Probe = (root) => {
  for (const name of ["composer.json", "phpunit.xml"]) {
    if (has(root, name)) return { value: "vendor/bin/phpunit", source: name };
  }
  return null;
};

const gradleTest: Probe = (root) =>
  has(root, "gradlew") ? { value: "./gradlew test", source: "gradlew" } : null;

const mavenTest: Probe = (root) => {
  for (const name of ["mvnw", "pom.xml"]) {
    if (has(root, name)) return { value: "mvn test", source: name };
  }
  return null;
};

/** The first root entry whose name ends with one of `suffixes`: `App.sln`, `App.xcodeproj`. */
function withSuffix(root: string, suffixes: string[]): string | undefined {
  try {
    return readdirSync(root).sort().find((name) => suffixes.some((suffix) => name.endsWith(suffix)));
  } catch {
    return undefined;
  }
}

const dotnetTest: Probe = (root) => {
  const project = withSuffix(root, [".sln", ".csproj", ".fsproj"]);
  return project === undefined ? null : { value: "dotnet test", source: project };
};

const swiftTest: Probe = (root) =>
  has(root, "Package.swift") ? { value: "swift test", source: "Package.swift" } : null;

const PROBES: Probe[] = [
  npmTest,
  pytest,
  goTest,
  cargoTest,
  makeTest,
  phpunit,
  gradleTest,
  mavenTest,
  dotnetTest,
  swiftTest,
];

/** The command that runs this project's whole test suite. First match wins. */
function fullSuite(root: string): Detection<string> | null {
  for (const probe of PROBES) {
    const detected = probe(root);
    if (detected !== null) return detected;
  }
  return null;
}

// --- fast mode: the test command narrowed to the agent's test files ---

/** A runner that takes test file paths as they are, and the ecosystem whose files it takes. */
type Runner = { ecosystem: Ecosystem; value: string; source: string };

/** Why fast mode cannot be written for this repository, and what to do instead. */
type Blocked = { why: string; instead: string };

const BY_HAND =
  "keep the full suite, or narrow it by hand with {files}, {dirs} or HB_TEST_FILES (see the README)";
const COMPILED_EXAMPLE =
  `map sources to their build output by hand, e.g. "npm run build && node --test ` +
  `$(printf '%s\\n' {files} | sed 's#^src/#dist/#; s#\\.ts$#.js#')"`;

/** A build before the tests: `npm run build && ...`, `tsc && ...`. */
const BUILD_STEP = /\b(?:(?:npm|pnpm|yarn|bun) (?:run )?build|tsc)\b/;
/** A path into a compiled directory: `dist/`, `'dist/**'`, `./build/`. */
const COMPILED_DIR = /(?:^|[\s'"=])(?:\.\/)?(dist|build|out)\//;

function scripts(root: string): Record<string, unknown> {
  const found = readJson(root, "package.json")?.["scripts"];
  return typeof found === "object" && found !== null ? (found as Record<string, unknown>) : {};
}

function script(root: string, name: string): string | null {
  const found = scripts(root)[name];
  return typeof found === "string" ? found.trim() : null;
}

/** Conditions under which no per-file command is exact, checked before any runner. */
function blocked(root: string): Blocked | null {
  const test = script(root, "test") ?? "";
  const pretest = script(root, "pretest") ?? "";
  if (BUILD_STEP.test(pretest)) return { why: `scripts.pretest builds before the tests ("${pretest}")`, instead: COMPILED_EXAMPLE };
  const runner = test.search(/\b(?:node|jest|vitest|mocha|ava)\b/);
  const build = test.search(BUILD_STEP);
  if (build >= 0 && (runner < 0 || build < runner)) {
    return { why: `scripts.test builds before the tests ("${test}")`, instead: COMPILED_EXAMPLE };
  }
  const compiled = COMPILED_DIR.exec(test);
  if (compiled !== null) {
    return { why: `the tests run from the compiled ${compiled[1]}/ directory ("${test}")`, instead: COMPILED_EXAMPLE };
  }

  const monorepo =
    (readJson(root, "package.json")?.["workspaces"] !== undefined ? "package.json workspaces" : undefined) ??
    ["pnpm-workspace.yaml", "turbo.json", "nx.json", "go.work"].find((name) => has(root, name));
  if (monorepo !== undefined) {
    return {
      why: `a monorepo (${monorepo}): each package has its own runner and config`,
      instead: `write it by hand, e.g. "npx jest {files}" when one root config covers every package`,
    };
  }

  const builds: Array<[string, string | undefined]> = [
    ["Gradle", ["gradlew", "build.gradle", "build.gradle.kts"].find((name) => has(root, name))],
    ["Maven", ["pom.xml", "mvnw"].find((name) => has(root, name))],
    [".NET", withSuffix(root, [".sln", ".csproj", ".fsproj"])],
    ["Cargo", has(root, "Cargo.toml") ? "Cargo.toml" : undefined],
    ["Swift", has(root, "Package.swift") ? "Package.swift" : withSuffix(root, [".xcodeproj", ".xcworkspace"])],
  ];
  for (const [tool, evidence] of builds) {
    if (evidence !== undefined) {
      return { why: `a ${tool} project (${evidence}): no exact mapping from test files to its runner`, instead: BY_HAND };
    }
  }
  return null;
}

/** `jest`, `vitest` or `vitest run` alone in scripts.test is the runner; with anything after it, flags we would drop. */
function jsRunner(root: string, name: "jest" | "vitest", command: string): Runner | Blocked | null {
  const test = script(root, "test") ?? "";
  const pkg = readJson(root, "package.json");
  const called = new RegExp(`^${name}\\b`).test(test);
  if (!called && !declares(pkg, "devDependencies", name)) return null;
  const bare = name === "vitest" ? /^vitest(?: run)?$/ : /^jest$/;
  if (called && !bare.test(test)) {
    return {
      why: `scripts.test runs "${test}", whose options "${command}" would drop`,
      instead: `write it by hand keeping them, e.g. "npx ${test} {files}"`,
    };
  }
  return { ecosystem: "javascript", value: command, source: called ? "package.json scripts.test" : `package.json devDependencies.${name}` };
}

/** `node --test` followed only by source paths (or nothing), never flags or other commands. */
function nodeTest(root: string): Runner | Blocked | null {
  const test = script(root, "test") ?? "";
  if (!/^node\s(?:.*\s)?--test\b/.test(test)) return null;
  if (!/^node\s+--test(?:\s+[^\s&|;<>-][^\s&|;<>]*)*$/.test(test)) {
    return {
      why: `scripts.test runs "${test}", whose options or steps "node --test {files}" would drop`,
      instead: "write it by hand keeping them, with {files} in place of the paths",
    };
  }
  return { ecosystem: "javascript", value: "node --test {files}", source: "package.json scripts.test" };
}

function pytestRunner(root: string): Runner | null {
  const evidence = [
    (read(root, "pyproject.toml") ?? "").includes("pytest") ? "pyproject.toml mentions pytest" : undefined,
    requirementsFiles(root).find((name) => (read(root, name) ?? "").includes("pytest")),
    ["conftest.py", "pytest.ini"].find((name) => has(root, name)),
  ].find((each) => each !== undefined);
  return evidence === undefined ? null : { ecosystem: "python", value: "pytest {files}", source: evidence };
}

function phpRunner(root: string): Runner | null {
  if (usesPest(root)) return { ecosystem: "php", value: "vendor/bin/pest {files}", source: "composer.json require-dev pestphp/pest" };
  if (declares(readJson(root, "composer.json"), "require-dev", "phpunit/phpunit")) {
    return { ecosystem: "php", value: "vendor/bin/phpunit {files}", source: "composer.json require-dev phpunit/phpunit" };
  }
  return null;
}

/** Every per-file runner with evidence, or the reason one that is there cannot be used. */
function runners(root: string): Array<Runner | Blocked> {
  const all: Array<Runner | Blocked | null> = [
    jsRunner(root, "jest", "npx jest {files}"),
    jsRunner(root, "vitest", "npx vitest run {files}"),
    nodeTest(root),
    pytestRunner(root),
    phpRunner(root),
    usesRspec(root) ? { ecosystem: "ruby", value: "bundle exec rspec {files}", source: "Gemfile with rspec" } : null,
    has(root, "go.mod") ? { ecosystem: "go", value: "go test {dirs}", source: "go.mod" } : null,
  ];
  return all.filter((each): each is Runner | Blocked => each !== null);
}

/** The nearest per-file example for a repository fast mode found no runner for. */
const EXAMPLES: Record<Ecosystem, string> = {
  javascript: "npx jest {files}",
  python: "pytest {files}",
  php: "vendor/bin/phpunit {files}",
  ruby: "bundle exec rspec {files}",
  go: "go test {dirs}",
};

/**
 * The per-file runner, when exactly one is detected and the repository's test files are all of
 * its ecosystem; otherwise why not. Exact or not at all: a guess would run nothing or the wrong
 * thing, silently.
 */
function fastMode(root: string): Runner | Blocked {
  const reason = blocked(root);
  if (reason !== null) return reason;
  const found = runners(root);
  const unusable = found.find((each): each is Blocked => "why" in each);
  if (unusable !== undefined) return unusable;
  const usable = found as Runner[];
  const ecosystems = testEcosystems(root);
  if (ecosystems.length > 1) {
    return {
      why: `test files of several ecosystems (${ecosystems.join(", ")}), which one runner cannot take`,
      instead: "write a command that dispatches on HB_TEST_FILES, or keep the full suite",
    };
  }
  if (usable.length > 1) {
    return {
      why: `several runners (${usable.map((each) => each.value.split(" {")[0]).join(", ")})`,
      instead: `write it by hand for the one your tests use, e.g. "${usable[0]?.value}"`,
    };
  }
  const runner = usable[0];
  if (runner === undefined) {
    const example = EXAMPLES[ecosystems[0] ?? "python"];
    return { why: "no runner harnessbench can hand test files to", instead: `set it by hand, e.g. "${example}"` };
  }
  return runner;
}

/**
 * The test command: the per-file form (`{files}` / `{dirs}`) when fast mode is exact, else the
 * full suite, as detected before fast mode existed, with a hint saying why and what to write
 * instead. Null when there is neither.
 */
export function testCommand(root: string): Detection<string> | null {
  const fast = fastMode(root);
  if ("value" in fast) return { value: fast.value, source: fast.source };
  const suite = fullSuite(root);
  if (suite === null) return null;
  return { ...suite, hint: `fast mode not detected: ${fast.why}; ${fast.instead}` };
}
