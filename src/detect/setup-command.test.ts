import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { setupCommand } from "./setup-command.js";

const roots: string[] = [];

/** A project directory containing exactly the given files. */
function project(...names: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-setup-command-")));
  roots.push(root);
  for (const name of names) writeFileSync(join(root, name), "", "utf8");
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("nothing to install from", () => {
  assert.equal(setupCommand(project()), null);
});

test("one lockfile, one command", () => {
  const rows: [string, string][] = [
    ["package-lock.json", "npm ci"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["go.sum", "go mod download"],
    ["Gemfile.lock", "bundle install"],
    ["composer.lock", "composer install"],
    ["poetry.lock", "poetry install"],
    ["requirements.txt", "pip install -r requirements.txt"],
  ];
  for (const [lockfile, command] of rows) {
    assert.deepEqual(setupCommand(project(lockfile)), { value: command, source: lockfile }, lockfile);
  }
});

test("a manifest without a lockfile is not enough", () => {
  assert.equal(setupCommand(project("package.json")), null);
  assert.equal(setupCommand(project("go.mod")), null);
  assert.equal(setupCommand(project("Gemfile")), null);
  assert.equal(setupCommand(project("composer.json")), null);
  assert.equal(setupCommand(project("pyproject.toml")), null);
});

test("build tools that fetch during the build have no setup command", () => {
  assert.equal(setupCommand(project("Cargo.toml", "Cargo.lock")), null);
  assert.equal(setupCommand(project("gradlew", "build.gradle")), null);
  assert.equal(setupCommand(project("pom.xml", "mvnw")), null);
});

test("several lockfiles join their commands in table order, and the reason says so", () => {
  const detected = setupCommand(project("go.sum", "package-lock.json"));

  assert.equal(detected?.value, "npm ci && go mod download");
  assert.match(detected?.source ?? "", /^package-lock\.json, go\.sum: several lockfiles/);
});

test("requirements.txt beside poetry.lock is a poetry project", () => {
  assert.deepEqual(setupCommand(project("requirements.txt", "poetry.lock")), {
    value: "poetry install",
    source: "poetry.lock",
  });
});
