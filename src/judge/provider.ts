import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { ResolvedJudge } from "../preflight.js";

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
      return createOpenAICompatible({ name: "openai-compatible", baseURL: target.baseUrl, apiKey })(
        target.model,
      );
  }
}
