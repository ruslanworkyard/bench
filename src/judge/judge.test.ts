import assert from "node:assert/strict";
import { test } from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import { defaults } from "../config.js";
import { CliError } from "../errors.js";
import type { LoadedJudge } from "../judges.js";
import { requireJudgeModel } from "../preflight.js";
import { INSTRUCTIONS, VerdictError, modelJudge, systemPrompt, translate } from "./judge.js";
import { judgeProviderOptions } from "./provider.js";

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
  assert.deepEqual(response.usage, { input: 10, output: 5, reasoning: 0 });
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
    /decided it, in at most two sentences\. Answer with a JSON object with exactly two keys: "preference", whose value is "A", "B" or "tie", and "reason"\. /,
  );
  // A diff-only judge once claimed unseen code "would crash": evidence only, said last.
  assert.match(INSTRUCTIONS, / Only cite behaviour visible in the evidence; do not assert how code that is not shown behaves\.$/);
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
  assert.deepEqual(response.usage, { input: 20, output: 10, reasoning: 0 });
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
    assert.deepEqual(error.usage, { input: 20, output: 10, reasoning: 0 });
    assert.equal(error.attempts, 2);
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

// --- timeouts, provider options, what the call reports ---

/** A model whose every call never resolves; it records the signal each call was handed. */
function hanging(signals: AbortSignal[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      if (options.abortSignal !== undefined) signals.push(options.abortSignal);
      return new Promise<never>(() => {});
    },
  });
}

test("a call over the timeout is aborted and retried once; the retry's verdict wins", async () => {
  const signals: AbortSignal[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: (options) => {
      calls++;
      if (options.abortSignal !== undefined) signals.push(options.abortSignal);
      if (calls === 1) return new Promise<never>(() => {});
      return Promise.resolve(reply('{"preference":"A","reason":"A is smaller."}'));
    },
  });

  const response = await modelJudge(model, { timeoutMs: 50 }).judge(REQUEST);

  assert.deepEqual(response.verdict, { preference: "A", reason: "A is smaller." });
  assert.equal(response.attempts, 2);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]?.aborted, true, "the first call was aborted at the timeout");
  assert.equal(signals[1]?.aborted, false);
  assert.ok(response.durationMs >= 50, `durationMs ${response.durationMs}`);
});

test("a second timeout is a failure naming the judge, the timeout and the model", async () => {
  const signals: AbortSignal[] = [];
  const model = hanging(signals);

  await assert.rejects(modelJudge(model, { timeoutMs: 40 }).judge(REQUEST), (error: unknown) => {
    assert.ok(error instanceof CliError && !(error instanceof VerdictError));
    assert.match(error.message, /judge 'code-quality' timed out twice: no reply within 0s from mock-model-id/);
    assert.match(error.message, /"judge\.timeoutSeconds"/);
    return true;
  });
  assert.equal(model.doGenerateCalls.length, 2);
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
});

test("a timeout and a malformed reply are retried independently, one of each", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      calls++;
      if (calls === 1) return new Promise<never>(() => {});
      if (calls === 2) return Promise.resolve(reply("not json"));
      return Promise.resolve(reply('{"preference":"tie","reason":"Same."}'));
    },
  });

  const response = await modelJudge(model, { timeoutMs: 40 }).judge(REQUEST);

  assert.equal(response.verdict.preference, "tie");
  assert.equal(response.attempts, 3);
});

/** A judge as `judges.ts` would load it. */
function loaded(providerOptions: Record<string, unknown> | null): LoadedJudge {
  return {
    dir: "",
    rubric: "",
    hash: "",
    meta: {
      id: "code-quality",
      title: "Code quality",
      description: "d",
      prompt: "prompt.md",
      context: ["prompt", "diff"],
      provider: null,
      model: null,
      apiKeyEnv: null,
      providerOptions,
    },
  };
}

test("providerOptions reach the model unchanged under the provider's key; the judge's own replace the config's whole", async () => {
  const project = { provider: { sort: "throughput" }, reasoning: { effort: "low" } };
  const config = {
    ...defaults().judge,
    provider: "openai-compatible" as const,
    model: "deepseek/deepseek-v3.2",
    baseUrl: "https://openrouter.ai/api/v1",
    providerOptions: project,
  };

  const fromConfig = requireJudgeModel(loaded(null), config, {});
  const first = mock(reply('{"preference":"B","reason":"b"}'));
  await modelJudge(first, { providerOptions: judgeProviderOptions(fromConfig) }).judge(REQUEST);
  assert.deepEqual(first.doGenerateCalls[0]?.providerOptions, { "openai-compatible": project });

  const own = { provider: { order: ["Together"] } };
  const fromJudge = requireJudgeModel(loaded(own), config, {});
  const second = mock(reply('{"preference":"B","reason":"b"}'));
  await modelJudge(second, { providerOptions: judgeProviderOptions(fromJudge) }).judge(REQUEST);
  // Replaced, not merged: nothing of the config's reasoning or sort survives.
  assert.deepEqual(second.doGenerateCalls[0]?.providerOptions, { "openai-compatible": own });

  const anthropic = requireJudgeModel(loaded({ thinking: { type: "disabled" } }), { ...config, provider: "anthropic" }, {});
  assert.deepEqual(judgeProviderOptions(anthropic), { anthropic: { thinking: { type: "disabled" } } });
});

test("the upstream provider comes from the response body, reasoning tokens from the usage", async () => {
  const served: Reply = {
    ...reply('{"preference":"A","reason":"a"}'),
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 900, text: 30, reasoning: 870 },
    },
    response: { body: { id: "gen-1", provider: "Together", choices: [] } },
  };

  const response = await modelJudge(mock(served)).judge(REQUEST);

  assert.equal(response.upstream, "Together");
  assert.deepEqual(response.usage, { input: 10, output: 900, reasoning: 870 });

  const unrouted = await modelJudge(mock(reply('{"preference":"A","reason":"a"}'))).judge(REQUEST);
  assert.equal(unrouted.upstream, null);
});
