import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { testCommand } from "./test-command.js";

const roots: string[] = [];

/** A project directory containing exactly the given files. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-test-command-")));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content, "utf8");
  }
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("no manifest at all", () => {
  assert.equal(testCommand(project({})), null);
});

/** A package.json with these scripts and devDependencies. */
function pkg(scripts: Record<string, string>, devDependencies: Record<string, string> = {}, extra: object = {}): string {
  return JSON.stringify({ scripts, devDependencies, ...extra });
}

// --- the per-file runners: one repository per row ---

test("each per-file runner, from its evidence, exactly", () => {
  const rows: Array<[string, Record<string, string>, { value: string; source: string }]> = [
    ["Jest in devDependencies", { "package.json": pkg({ test: "eslint . && jest" }, { jest: "^29" }) }, { value: "npx jest {files}", source: "package.json devDependencies.jest" }],
    ["Jest as scripts.test", { "package.json": pkg({ test: "jest" }) }, { value: "npx jest {files}", source: "package.json scripts.test" }],
    ["Vitest in devDependencies", { "package.json": pkg({ test: "vitest" }, { vitest: "^2" }) }, { value: "npx vitest run {files}", source: "package.json scripts.test" }],
    ["Vitest as scripts.test", { "package.json": pkg({ test: "vitest run" }) }, { value: "npx vitest run {files}", source: "package.json scripts.test" }],
    ["node --test on source paths", { "package.json": pkg({ test: "node --test 'src/**/*.test.js'" }) }, { value: "node --test {files}", source: "package.json scripts.test" }],
    ["pytest in pyproject.toml", { "pyproject.toml": "[tool.pytest.ini_options]\n" }, { value: "pytest {files}", source: "pyproject.toml mentions pytest" }],
    ["pytest in requirements", { "requirements-dev.txt": "pytest==8.0\n" }, { value: "pytest {files}", source: "requirements-dev.txt" }],
    ["conftest.py", { "conftest.py": "" }, { value: "pytest {files}", source: "conftest.py" }],
    ["pytest.ini", { "pytest.ini": "[pytest]\n" }, { value: "pytest {files}", source: "pytest.ini" }],
    ["Pest", { "composer.json": '{"require-dev":{"pestphp/pest":"^2","phpunit/phpunit":"^10"}}' }, { value: "vendor/bin/pest {files}", source: "composer.json require-dev pestphp/pest" }],
    ["PHPUnit", { "composer.json": '{"require-dev":{"phpunit/phpunit":"^10"}}' }, { value: "vendor/bin/phpunit {files}", source: "composer.json require-dev phpunit/phpunit" }],
    ["RSpec", { Gemfile: "gem 'rspec-rails'\n" }, { value: "bundle exec rspec {files}", source: "Gemfile with rspec" }],
    ["Go", { "go.mod": "module example.com/x\n" }, { value: "go test {dirs}", source: "go.mod" }],
  ];
  for (const [name, files, expected] of rows) {
    assert.deepEqual(testCommand(project(files)), expected, name);
  }
});

// --- the full-suite fallback, each with a hint naming why ---

function fallback(files: Record<string, string>, value: string, why: RegExp): void {
  const detected = testCommand(project(files));
  assert.equal(detected?.value, value, JSON.stringify(files));
  assert.match(detected?.hint ?? "", /^fast mode not detected: /);
  assert.match(detected?.hint ?? "", why);
}

test("a build before the tests, or tests run from a compiled directory, fall back to the suite", () => {
  fallback({ "package.json": pkg({ test: "npm run build && jest" }, { jest: "^29" }) }, "npm test", /scripts\.test builds before the tests/);
  fallback({ "package.json": pkg({ test: "tsc && node --test src" }) }, "npm test", /scripts\.test builds before the tests/);
  fallback({ "package.json": pkg({ pretest: "npm run build", test: "jest" }) }, "npm test", /scripts\.pretest builds before the tests/);
  for (const dir of ["dist", "build", "out"]) {
    fallback({ "package.json": pkg({ test: `node --test ${dir}/` }) }, "npm test", new RegExp(`compiled ${dir}/ directory`));
  }
  fallback({ "package.json": pkg({ test: "jest --rootDir ./dist/" }, { jest: "^29" }) }, "npm test", /compiled dist\/ directory/);
});

test("a monorepo falls back to the suite, naming what made it one", () => {
  const jest = { jest: "^29" };
  fallback({ "package.json": pkg({ test: "jest" }, jest, { workspaces: ["packages/*"] }) }, "npm test", /monorepo \(package\.json workspaces\)/);
  for (const marker of ["pnpm-workspace.yaml", "turbo.json", "nx.json"]) {
    fallback({ "package.json": pkg({ test: "jest" }, jest), [marker]: "" }, "npm test", new RegExp(`monorepo \\(${marker.replace(".", "\\.")}\\)`));
  }
  fallback({ "go.mod": "module example.com/x\n", "go.work": "go 1.22\n" }, "go test ./...", /monorepo \(go\.work\)/);
});

test("Gradle, Maven, .NET, Cargo and Swift fall back to their suite", () => {
  fallback({ gradlew: "#!/bin/sh\n" }, "./gradlew test", /a Gradle project \(gradlew\)/);
  fallback({ "pom.xml": "<project/>" }, "mvn test", /a Maven project \(pom\.xml\)/);
  fallback({ "App.csproj": "<Project/>" }, "dotnet test", /a \.NET project \(App\.csproj\)/);
  fallback({ "Cargo.toml": "[package]\n" }, "cargo test", /a Cargo project \(Cargo\.toml\)/);
  fallback({ "Package.swift": "// swift-tools-version:5.9\n" }, "swift test", /a Swift project \(Package\.swift\)/);
  // Even beside a runner we could map: the build tool decides how tests run.
  fallback({ "package.json": pkg({ test: "jest" }), "Cargo.toml": "[package]\n" }, "npm test", /a Cargo project/);
});

test("a runner called with options, several runners, or several ecosystems fall back rather than guess", () => {
  fallback({ "package.json": pkg({ test: "jest --coverage" }) }, "npm test", /"jest --coverage".*"npx jest --coverage \{files\}"/);
  fallback({ "package.json": pkg({ test: "node --import tsx --test src" }) }, "npm test", /options or steps/);
  fallback({ "package.json": pkg({ test: "vitest" }, { jest: "^29", vitest: "^2" }) }, "npm test", /several runners \(npx jest, npx vitest run\)/);
  fallback({ "package.json": pkg({ test: "jest" }), "pyproject.toml": "[tool.pytest]\n" }, "npm test", /several ecosystems \(javascript, python\)/);
});

test("no runner we can hand files to: the suite, with the nearest example", () => {
  fallback({ "package.json": pkg({ test: "mocha" }) }, "npm test", /no runner.*"npx jest \{files\}"/);
  fallback({ "composer.json": "{}" }, "vendor/bin/phpunit", /"vendor\/bin\/phpunit \{files\}"/);
  fallback({ "setup.cfg": "[tool:pytest]\n" }, "pytest", /"pytest \{files\}"/);
  fallback({ Makefile: "test:\n\t./run\n" }, "make test", /no runner/);
});

test("this repository builds to dist/ before its tests, so it gets the suite and a hint", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const detected = testCommand(repo);
  assert.equal(detected?.value, "npm test");
  assert.match(detected?.hint ?? "", /builds before the tests/);
});

// --- no command at all ---

test("npm's placeholder test script is not a test command", () => {
  const placeholder = '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}';
  assert.equal(testCommand(project({ "package.json": placeholder })), null);
});

test("package.json without a test script, or unreadable", () => {
  assert.equal(testCommand(project({ "package.json": '{"scripts":{"build":"tsc"}}' })), null);
  assert.equal(testCommand(project({ "package.json": "{not json" })), null);
  // A pyproject.toml that never mentions pytest is not a pytest project.
  assert.equal(testCommand(project({ "pyproject.toml": "[project]\nname='x'\n" })), null);
});

test("a Makefile without a test target does not count", () => {
  assert.equal(testCommand(project({ Makefile: "build:\n\tcc\ntests:\n\t./run\n" })), null);
});
