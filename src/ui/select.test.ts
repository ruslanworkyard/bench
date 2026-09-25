import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { selectRenderer, type RendererInput } from "./select.js";

const TERMINAL: RendererInput = { stdoutTTY: true, stdinTTY: true, json: false, plain: false, detail: false, env: {} };

test("a person at a terminal gets the UI", () => {
  assert.equal(selectRenderer(TERMINAL), "ui");
  assert.equal(selectRenderer({ ...TERMINAL, env: { CI: "" } }), "ui");
});

test("no TTY, --json, --plain, --detail or CI each select plain", () => {
  assert.equal(selectRenderer({ ...TERMINAL, stdoutTTY: false }), "plain");
  assert.equal(selectRenderer({ ...TERMINAL, stdinTTY: false }), "plain");
  assert.equal(selectRenderer({ ...TERMINAL, json: true }), "plain");
  assert.equal(selectRenderer({ ...TERMINAL, plain: true }), "plain");
  assert.equal(selectRenderer({ ...TERMINAL, detail: true }), "plain");
  assert.equal(selectRenderer({ ...TERMINAL, env: { CI: "1" } }), "plain");
  assert.equal(selectRenderer({ ...TERMINAL, env: { CI: "true" } }), "plain");
});

test("nothing outside src/ui/ imports ink or react, and .tsx lives only there", () => {
  const src = fileURLToPath(new URL("../../src/", import.meta.url));
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((path) => /\.tsx?$/.test(path));
  const offenders = files
    .filter((path) => !path.startsWith("ui/"))
    .filter((path) => path.endsWith(".tsx") || /from "(ink|react|ink-testing-library)(\/[^"]*)?"/.test(readFileSync(join(src, path), "utf8")));
  assert.deepEqual(offenders, []);
});
