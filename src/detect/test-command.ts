import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const PROBES: Probe[] = [
  npmTest,
  pytest,
  goTest,
  cargoTest,
  makeTest,
  phpunit,
  gradleTest,
  mavenTest,
];

/** The command that runs this project's test suite. First match wins. */
export function testCommand(root: string): Detection<string> | null {
  for (const probe of PROBES) {
    const detected = probe(root);
    if (detected !== null) return detected;
  }
  return null;
}
