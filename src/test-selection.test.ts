import assert from "node:assert/strict";
import { test } from "node:test";

import { expandTestCommand, globToRegex, selectTests, shellQuote } from "./test-selection.js";

test("globs: ** spans directories, including none; * and ? stay in one segment; both ends anchored", () => {
  const matches = (glob: string, path: string): boolean => globToRegex(glob).test(path);
  assert.ok(matches("src/**/*.test.ts", "src/a.test.ts"));
  assert.ok(matches("src/**/*.test.ts", "src/cache/deep/a.test.ts"));
  assert.ok(matches("**/*_test.py", "test_x_test.py"));
  assert.ok(matches("**/*_test.py", "pkg/mod/x_test.py"));
  assert.ok(matches("tests/**", "tests/unit/x.php"));
  assert.ok(!matches("src/*.test.ts", "src/cache/a.test.ts"), "* does not cross a slash");
  assert.ok(matches("src/?.ts", "src/a.ts"));
  assert.ok(!matches("src/?.ts", "src/ab.ts"));
  assert.ok(!matches("src/**/*.test.ts", "lib/src/a.test.ts"), "anchored at the start");
  assert.ok(!matches("src/**/*.test.ts", "src/a.test.ts.bak"), "anchored at the end");
  assert.ok(!matches("src/*.test.ts", "src/aXtest.ts"), "a dot is literal");
});

test("selectTests keeps added and modified test files, sorted; deleted and non-test files are out", () => {
  const diff = [
    "M\tsrc/z.test.ts",
    "A\tsrc/cache/a.test.ts",
    "D\tsrc/gone.test.ts",
    "A\tsrc/cache/a.ts",
    "M\tREADME.md",
    "T\tsrc/t.test.ts",
    "A\tsrc/with space.test.ts",
  ];
  assert.deepEqual(selectTests(diff, ["src/**/*.test.ts"]), [
    "src/cache/a.test.ts",
    "src/t.test.ts",
    "src/with space.test.ts",
    "src/z.test.ts",
  ]);
  assert.deepEqual(selectTests(diff, ["**/*.md", "src/cache/*"]), ["README.md", "src/cache/a.test.ts", "src/cache/a.ts"]);
  assert.deepEqual(selectTests(diff, []), [], "no globs select nothing");
  assert.deepEqual(selectTests([], ["**"]), []);
});

test("expandTestCommand fills {files} and {dirs}, sorted and shell-quoted", () => {
  const files = ["src/b.test.ts", "src/with space/a.test.ts", "src/a.test.ts", "root.test.ts"];
  assert.equal(
    expandTestCommand("node --test {files}", files),
    "node --test root.test.ts src/a.test.ts src/b.test.ts 'src/with space/a.test.ts'",
  );
  assert.equal(expandTestCommand("pytest {dirs}", files), "pytest . ./src './src/with space'");
  assert.equal(
    expandTestCommand("lint {dirs} && run {files}", ["x/a.ts", "x/b.ts"]),
    "lint ./x && run x/a.ts x/b.ts",
  );
  // The quoting holds against the shell: a quote in a name, a placeholder in a name.
  assert.equal(expandTestCommand("cat {files}", ["it's.test.ts"]), `cat 'it'\\''s.test.ts'`);
  assert.equal(expandTestCommand("cat {files}", ["{dirs}.test.ts"]), "cat '{dirs}.test.ts'");
});

test("expandTestCommand with a placeholder and no files is null; without a placeholder it is unchanged", () => {
  assert.equal(expandTestCommand("node --test {files}", []), null);
  assert.equal(expandTestCommand("pytest {dirs}", []), null);
  assert.equal(expandTestCommand("npm test", []), "npm test");
  assert.equal(expandTestCommand("npm test", ["src/a.test.ts"]), "npm test");
});

test("shellQuote leaves a plain word alone and single-quotes anything else", () => {
  assert.equal(shellQuote("src/a.test.ts"), "src/a.test.ts");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
});
