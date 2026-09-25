import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { ProviderOptions } from "./judge.js";

import type { ResolvedJudge } from "../preflight.js";

/** The name each provider package reads its options under; openai-compatible's is the `name` below. */
const OPTIONS_KEY = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "openai-compatible": "openai-compatible",
} as const;

/**
 * `judge.providerOptions` under the key its provider package reads, untouched. The
 * openai-compatible package spreads every key it does not know itself into the request body,
 * which is how OpenRouter's `provider` and `reasoning` reach the API.
 */
export function judgeProviderOptions(target: ResolvedJudge): ProviderOptions {
  return { [OPTIONS_KEY[target.provider]]: target.providerOptions } as ProviderOptions;
}

/**
 * The one place that knows the provider packages. Turns a resolved judge target into an AI SDK
 * model. The key is read from its variable here, at call time, and handed straight to the SDK:
 * it is never stored, logged or printed.
 */
export function judgeModel(target: ResolvedJudge, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const apiKey = env[target.apiKeyEnv];
  switch (target.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(target.model);
    case "openai":
      return createOpenAI({ apiKey })(target.model);
    case "google":
      return createGoogle({ apiKey })(target.model);
    case "openai-compatible":
      // Off by default in the SDK, which then drops the schema and only hints at JSON.
      return createOpenAICompatible({
        name: OPTIONS_KEY["openai-compatible"],
        baseURL: target.baseUrl,
        apiKey,
        supportsStructuredOutputs: target.structuredOutputs,
      })(target.model);
  }
}
