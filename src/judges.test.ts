import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { JUDGES_DIR } from "./config.js";
import { CliError } from "./errors.js";
import { listJudges, packagedJudgesDir, requireJudge, validateJudge, type JudgeMeta } from "./judges.js";
import { listFixtures } from "./fixtures.js";

const roots: string[] = [];

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harnessbench-judges-")));
  roots.push(dir);
  mkdirSync(join(dir, JUDGES_DIR), { recursive: true });
  return dir;
}

/** A judge directory under the host's catalogue; `meta` is written as given, unchecked. */
function judgeDir(host: string, dir: string, meta: unknown, prompt: string | null = "Criterion: x.\n"): void {
  const path = join(host, JUDGES_DIR, dir);
  mkdirSync(path, { recursive: true });
  if (meta !== null) writeFileSync(join(path, "judge.json"), `${JSON.stringify(meta)}\n`, "utf8");
  if (prompt !== null) writeFileSync(join(path, "prompt.md"), prompt, "utf8");
}

function cliError(fn: () => unknown, pattern: RegExp): CliError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected a CliError");
}

const VALID = { id: "code-quality", title: "Code quality", description: "one line", context: ["prompt", "diff"] };

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("a minimal judge.json validates with prompt.md and no overrides", () => {
  const meta: JudgeMeta = validateJudge(VALID, "j");
  assert.deepEqual(meta, {
    id: "code-quality",
    title: "Code quality",
    description: "one line",
    prompt: "prompt.md",
    context: ["prompt", "diff"],
    provider: null,
    model: null,
    apiKeyEnv: null,
  });
});

test("the override fields and a custom prompt path round-trip", () => {
  const meta = validateJudge(
    { ...VALID, prompt: "rubric.md", provider: "openai", model: "gpt-5", apiKeyEnv: "MY_KEY" },
    "j",
  );
  assert.equal(meta.prompt, "rubric.md");
  assert.equal(meta.provider, "openai");
  assert.equal(meta.model, "gpt-5");
  assert.equal(meta.apiKeyEnv, "MY_KEY");
  assert.equal(validateJudge({ ...VALID, provider: null, model: null }, "j").provider, null);
});

test("every validation error names the file and what is wrong", () => {
  const where = ".harnessbench/judges/x/judge.json";
  cliError(() => validateJudge([], where), /judges\/x\/judge\.json: expected a JSON object, found an array/);
  cliError(() => validateJudge({ ...VALID, id: "" }, where), /"id" must be a non-empty string, found a string/);
  cliError(() => validateJudge({ ...VALID, title: 3 }, where), /"title" must be a non-empty string, found a number/);
  cliError(() => validateJudge({ id: "a", title: "b" }, where), /"description" must be a non-empty string, found nothing/);
  cliError(() => validateJudge({ ...VALID, rubric: "x" }, where), /unknown key "rubric"/);
  cliError(() => validateJudge({ ...VALID, prompt: "" }, where), /"prompt" must be a non-empty string/);
  cliError(() => validateJudge({ ...VALID, context: [] }, where), /"context" must be a non-empty array of prompt, diff, tests, finalMessage, toolLog, transcript/);
  cliError(() => validateJudge({ ...VALID, context: "diff" }, where), /"context" must be a non-empty array/);
  cliError(() => validateJudge({ ...VALID, context: ["diff", "testLog"] }, where), /"context" entry "testLog" is not one of prompt, diff, tests, finalMessage, toolLog, transcript/);
  cliError(() => validateJudge({ ...VALID, provider: "bedrock" }, where), /"provider" must be one of anthropic, openai, google, openai-compatible, found "bedrock"/);
  cliError(() => validateJudge({ ...VALID, model: "" }, where), /"model" must be a non-empty string or null/);
  cliError(() => validateJudge({ ...VALID, apiKeyEnv: 7 }, where), /"apiKeyEnv" must be a non-empty string or null, found a number/);
});

test("a repeated context item is kept once", () => {
  assert.deepEqual(validateJudge({ ...VALID, context: ["diff", "prompt", "diff"] }, "j").context, ["diff", "prompt"]);
});

test("listJudges reads every judge with its rubric, by directory name", () => {
  const host = root();
  judgeDir(host, "b-judge", { ...VALID, id: "b-judge", title: "B" }, "B rubric\n");
  judgeDir(host, "a-judge", { ...VALID, id: "a-judge", title: "A", prompt: "rubric.md" }, null);
  writeFileSync(join(host, JUDGES_DIR, "a-judge", "rubric.md"), "A rubric\n", "utf8");
  writeFileSync(join(host, JUDGES_DIR, "README.md"), "not a judge\n", "utf8");

  const judges = listJudges(host);

  assert.deepEqual(judges.map((judge) => judge.meta.id), ["a-judge", "b-judge"]);
  assert.deepEqual(judges.map((judge) => judge.rubric), ["A rubric\n", "B rubric\n"]);
  assert.equal(judges[0]?.dir, join(host, JUDGES_DIR, "a-judge"));
  assert.deepEqual(listJudges(root()), []);
});

test("listJudges refuses a directory without judge.json, invalid JSON, a bad file, or a missing prompt", () => {
  const noMeta = root();
  judgeDir(noMeta, "x", null);
  cliError(() => listJudges(noMeta), /\.harnessbench\/judges\/x has no judge\.json/);

  const badJson = root();
  mkdirSync(join(badJson, JUDGES_DIR, "x"));
  writeFileSync(join(badJson, JUDGES_DIR, "x", "judge.json"), "{ nope", "utf8");
  cliError(() => listJudges(badJson), /\.harnessbench\/judges\/x\/judge\.json is not valid JSON/);

  const invalid = root();
  judgeDir(invalid, "x", { ...VALID, context: ["log"] });
  cliError(() => listJudges(invalid), /\.harnessbench\/judges\/x\/judge\.json: "context" entry "log"/);

  const noPrompt = root();
  judgeDir(noPrompt, "x", { ...VALID, prompt: "rubric.md" });
  cliError(
    () => listJudges(noPrompt),
    /judge 'code-quality' names prompt "rubric\.md", but \.harnessbench\/judges\/x\/rubric\.md does not exist/,
  );
});

test("two directories claiming one id are refused, naming both", () => {
  const host = root();
  judgeDir(host, "one", VALID);
  judgeDir(host, "two", VALID);

  cliError(
    () => listJudges(host),
    /judge id 'code-quality' is claimed by both \.harnessbench\/judges\/one and \.harnessbench\/judges\/two/,
  );
});

test("requireJudge finds a judge by id, and lists what exists for an unknown one", () => {
  const host = root();
  judgeDir(host, "code-quality", VALID);
  judgeDir(host, "tests", { ...VALID, id: "test-quality", title: "Tests" });

  assert.equal(requireJudge(host, "test-quality").meta.title, "Tests");
  const error = cliError(() => requireJudge(host, "nope"), /unknown judge 'nope'/);
  assert.match(error.message, /available judges:\n {2}code-quality\n {2}test-quality/);
  cliError(() => requireJudge(root(), "nope"), /no judges in \.harnessbench\/judges - run `harnessbench init` first/);
});

test("the packaged judges are valid, each with the context its rubric needs", () => {
  const packaged = listFixtures(packagedJudgesDir());
  assert.deepEqual(packaged.map((entry) => entry.id), ["code-quality", "engineering-practices", "test-quality"]);

  const host = root();
  rmSync(join(host, JUDGES_DIR), { recursive: true });
  cpSync(packagedJudgesDir(), join(host, JUDGES_DIR), { recursive: true });
  const judges = listJudges(host);
  const context = Object.fromEntries(judges.map((judge) => [judge.meta.id, judge.meta.context]));
  assert.deepEqual(context, {
    "code-quality": ["prompt", "diff"],
    "engineering-practices": ["prompt", "diff", "toolLog"],
    "test-quality": ["prompt", "diff", "tests"],
  });
  for (const judge of judges) {
    assert.match(judge.rubric, /^<!-- Draft rubric/, `${judge.meta.id} should say it is a draft`);
    assert.match(judge.rubric, /Criterion:/);
    assert.equal(judge.meta.provider, null);
  }
});
