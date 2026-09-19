import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { testCommand } from "./test-command.js";

const roots: string[] = [];

/** A project directory containing exactly the given files. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-test-command-")));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
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

test("package.json scripts.test", () => {
  const detected = testCommand(project({ "package.json": '{"scripts":{"test":"vitest run"}}' }));
  assert.deepEqual(detected, { value: "npm test", source: "package.json scripts.test" });
});

test("npm's placeholder test script is not a test command", () => {
  const placeholder = '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}';
  assert.equal(testCommand(project({ "package.json": placeholder })), null);
});

test("package.json without a test script, or unreadable", () => {
  assert.equal(testCommand(project({ "package.json": '{"scripts":{"build":"tsc"}}' })), null);
  assert.equal(testCommand(project({ "package.json": "{not json" })), null);
});

test("python projects", () => {
  assert.deepEqual(testCommand(project({ "pyproject.toml": "[tool.pytest.ini_options]\n" })), {
    value: "pytest",
    source: "pyproject.toml mentions pytest",
  });
  assert.deepEqual(testCommand(project({ "pytest.ini": "[pytest]\n" })), {
    value: "pytest",
    source: "pytest.ini",
  });
  assert.deepEqual(testCommand(project({ "setup.cfg": "[tool:pytest]\n" })), {
    value: "pytest",
    source: "setup.cfg mentions pytest",
  });
  // A pyproject.toml that never mentions pytest is not a pytest project.
  assert.equal(testCommand(project({ "pyproject.toml": "[project]\nname='x'\n" })), null);
});

test("go, rust, make, php, gradle and maven projects", () => {
  assert.deepEqual(testCommand(project({ "go.mod": "module example.com/x\n" })), {
    value: "go test ./...",
    source: "go.mod",
  });
  assert.deepEqual(testCommand(project({ "Cargo.toml": "[package]\n" })), {
    value: "cargo test",
    source: "Cargo.toml",
  });
  assert.deepEqual(testCommand(project({ Makefile: "build:\n\tcc\n\ntest:\n\t./run\n" })), {
    value: "make test",
    source: "Makefile test target",
  });
  assert.deepEqual(testCommand(project({ "composer.json": "{}" })), {
    value: "vendor/bin/phpunit",
    source: "composer.json",
  });
  assert.deepEqual(testCommand(project({ "phpunit.xml": "<phpunit/>" })), {
    value: "vendor/bin/phpunit",
    source: "phpunit.xml",
  });
  assert.deepEqual(testCommand(project({ gradlew: "#!/bin/sh\n" })), {
    value: "./gradlew test",
    source: "gradlew",
  });
  assert.deepEqual(testCommand(project({ mvnw: "#!/bin/sh\n" })), {
    value: "mvn test",
    source: "mvnw",
  });
  assert.deepEqual(testCommand(project({ "pom.xml": "<project/>" })), {
    value: "mvn test",
    source: "pom.xml",
  });
});

test("a Makefile without a test target does not count", () => {
  assert.equal(testCommand(project({ Makefile: "build:\n\tcc\ntests:\n\t./run\n" })), null);
});

test("first match wins", () => {
  const root = project({
    "package.json": '{"scripts":{"test":"jest"}}',
    "go.mod": "module example.com/x\n",
    "Cargo.toml": "[package]\n",
  });
  assert.equal(testCommand(root)?.value, "npm test");
});
