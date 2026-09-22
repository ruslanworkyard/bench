import assert from "node:assert/strict";
import { test } from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import { CliError } from "../errors.js";
import { INSTRUCTIONS, VerdictError, modelJudge, systemPrompt, translate } from "./judge.js";

/** The AI SDK's mock model: scripted replies, no network. */

type Reply = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

function reply(text: string, tokens = { input: 10, output: 5 }): Reply {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: {
      inputTokens: { total: tokens.input, noCache: tokens.input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: tokens.output, text: tokens.output, reasoning: 0 },
    },
    warnings: [],
  };
}

function mock(...replies: Reply[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: replies });
}

const REQUEST = { id: "code-quality", rubric: "Criterion: quality.\n", context: "# Task\n\nDo it.\n" };

test("a valid object is the verdict, with what was sent and the usage", async () => {
  const model = mock(reply('{"preference":"B","reason":"B named its tests."}'));

  const response = await modelJudge(model).judge(REQUEST);

  assert.deepEqual(response.verdict, { preference: "B", reason: "B named its tests." });
  assert.equal(response.attempts, 1);
  assert.deepEqual(response.usage, { input: 10, output: 5 });
  assert.equal(response.text, '{"preference":"B","reason":"B named its tests."}');
  assert.equal(response.system, systemPrompt(REQUEST.rubric));
  assert.equal(response.user, REQUEST.context);
  assert.equal(model.doGenerateCalls.length, 1);
});

test("the system prompt is the rubric followed by the fixed instruction block, and it is what the model got", async () => {
  const model = mock(reply('{"preference":"tie","reason":"Same."}'));

  await modelJudge(model).judge(REQUEST);

  const system = systemPrompt(REQUEST.rubric);
  assert.equal(system, `Criterion: quality.\n\n${INSTRUCTIONS}\n`);
  assert.match(INSTRUCTIONS, /^You are comparing two independent attempts, A and B,/);
  assert.match(INSTRUCTIONS, /otherwise answer tie\./);
  assert.match(
    INSTRUCTIONS,
    /decided it, in one or two sentences\. Answer with a JSON object with exactly two keys: "preference", whose value is "A", "B" or "tie", and "reason"\.$/,
  );
  const prompt = model.doGenerateCalls[0]?.prompt ?? [];
  assert.equal(prompt[0]?.role, "system");
  assert.equal(prompt[0]?.content, system);
  assert.equal(prompt[1]?.role, "user");
  assert.deepEqual(prompt[1]?.content, [{ type: "text", text: REQUEST.context }]);
});

test("an invalid object is retried once; the second attempt's verdict wins and both attempts are paid for", async () => {
  const model = mock(
    reply('{"preference":"C","reason":"?"}', { input: 10, output: 3 }),
    reply('{"preference":"A","reason":"A kept the error handling."}', { input: 10, output: 7 }),
  );

  const response = await modelJudge(model).judge(REQUEST);

  assert.deepEqual(response.verdict, { preference: "A", reason: "A kept the error handling." });
  assert.equal(response.attempts, 2);
  assert.deepEqual(response.usage, { input: 20, output: 10 });
  assert.equal(model.doGenerateCalls.length, 2);
});

test("two invalid replies are a CliError naming the judge, carrying the raw reply and the prompt", async () => {
  const model = mock(reply("I prefer A, honestly."), reply('{"preference":"A"}'));

  await assert.rejects(modelJudge(model).judge(REQUEST), (error: unknown) => {
    assert.ok(error instanceof VerdictError);
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 1);
    assert.match(error.message, /judge 'code-quality' did not return a verdict in the expected shape after two attempts/);
    assert.equal(error.text, '{"preference":"A"}');
    assert.equal(error.system, systemPrompt(REQUEST.rubric));
    assert.equal(error.user, REQUEST.context);
    assert.deepEqual(error.usage, { input: 20, output: 10 });
    return true;
  });
  assert.equal(model.doGenerateCalls.length, 2);
});

test("a failing request is a CliError naming the judge, not a retry", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      throw new Error("401 invalid x-api-key");
    },
  });

  await assert.rejects(modelJudge(model).judge(REQUEST), (error: unknown) => {
    assert.ok(error instanceof CliError && !(error instanceof VerdictError));
    assert.match(error.message, /judge 'code-quality': the model request failed: 401 invalid x-api-key/);
    return true;
  });
  assert.equal(model.doGenerateCalls.length, 1);
});

test("A and B translate back to the sides they stood for", () => {
  assert.equal(translate("A"), "previous");
  assert.equal(translate("B"), "candidate");
  assert.equal(translate("tie"), "tie");
});
