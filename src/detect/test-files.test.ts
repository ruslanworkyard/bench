import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { testFiles } from "./test-files.js";

const roots: string[] = [];

/** A project directory containing exactly the given files. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-test-files-")));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content, "utf8");
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const JS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"];
const PYTHON = ["**/test_*.py", "**/*_test.py"];

test("each ecosystem's globs, from its evidence, exactly", () => {
  const rows: Array<[Record<string, string>, { value: string[]; source: string }]> = [
    [{ "package.json": "{}" }, { value: JS, source: "package.json" }],
    [{ "pyproject.toml": "[project]\n" }, { value: PYTHON, source: "pyproject.toml" }],
    [{ "setup.py": "" }, { value: PYTHON, source: "setup.py" }],
    [{ "requirements.txt": "requests\n" }, { value: PYTHON, source: "requirements.txt" }],
    [{ "requirements-dev.txt": "pytest\n" }, { value: PYTHON, source: "requirements-dev.txt" }],
    [{ "composer.json": "{}" }, { value: ["tests/**/*Test.php"], source: "composer.json" }],
    [
      { "composer.json": '{"require-dev":{"pestphp/pest":"^2"}}' },
      { value: ["tests/**/*Test.php", "tests/**/*.php"], source: "composer.json with Pest" },
    ],
    [{ Gemfile: 'gem "rspec"\n' }, { value: ["spec/**/*_spec.rb"], source: "Gemfile with rspec" }],
    [{ "go.mod": "module example.com/x\n" }, { value: ["**/*_test.go"], source: "go.mod" }],
  ];
  for (const [files, expected] of rows) {
    assert.deepEqual(testFiles(project(files)), expected, Object.keys(files).join(", "));
  }
});

test("a Gemfile without rspec is not evidence", () => {
  assert.equal(testFiles(project({ Gemfile: 'gem "minitest"\n' })), null);
});

test("several ecosystems are the union, and the source names each", () => {
  const detected = testFiles(project({ "package.json": "{}", "pyproject.toml": "", "go.mod": "" }));
  assert.deepEqual(detected, { value: [...JS, ...PYTHON, "**/*_test.go"], source: "package.json, pyproject.toml, go.mod" });
});

test("no ecosystem is null", () => {
  assert.equal(testFiles(project({})), null);
  assert.equal(testFiles(project({ "README.md": "# x\n" })), null);
});

test("no glob reaches into node_modules, vendor or .harnessbench", () => {
  const detected = testFiles(
    project({ "package.json": "{}", "pyproject.toml": "", "composer.json": '{"require-dev":{"pestphp/pest":"^2"}}', Gemfile: "gem 'rspec'\n", "go.mod": "" }),
  );
  for (const glob of detected?.value ?? []) assert.doesNotMatch(glob, /node_modules|vendor|\.harnessbench/);
});
