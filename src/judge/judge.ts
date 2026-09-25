import { NoObjectGeneratedError, Output, generateText, type LanguageModel } from "ai";
import { z } from "zod";

import { CONFIG_FILE } from "../config.js";
import { CliError } from "../errors.js";
import type { Environment } from "../run-record.js";
import { MAPPING, type Position } from "./context.js";

/**
 * One judge, one verdict. The rubric is the judge's own prompt.md; the instruction block below
 * is appended to every rubric so the shape of the answer is not up to the rubric's author.
 */

/** Appended verbatim to every rubric. In code, not in the .md, so an edited rubric keeps it. */
export const INSTRUCTIONS =
  "You are comparing two independent attempts, A and B, at the same task on the same " +
  "codebase. Judge only on the criterion above. Prefer A or B only when the evidence shows a " +
  "real difference on that criterion; otherwise answer tie. Do not reward length, effort or " +
  "thoroughness for their own sake. Your reason must name the specific evidence (a file, a " +
  "hunk, a test, a message) that decided it, in at most two sentences. Answer with a JSON " +
  'object with exactly two keys: "preference", whose value is "A", "B" or "tie", and "reason". ' +
  "Only cite behaviour visible in the evidence; do not assert how code that is not shown behaves.";

export type Preference = Position | "tie";
export type Verdict = { preference: Preference; reason: string };

const VERDICT_SCHEMA = z.object({
  preference: z.enum(["A", "B", "tie"]),
  reason: z.string(),
});

export type JudgeRequest = {
  /** The judge's id, for error messages only. */
  id: string;
  rubric: string;
  /** The assembled context, from `context.ts`. */
  context: string;
};

/** `reasoning` is null when the provider never reported it. */
export type Usage = { input: number; output: number; reasoning: number | null };

/** What `generateText` takes as `providerOptions`: per provider package, its own options. */
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

export type JudgeResponse = {
  verdict: Verdict;
  /** What was sent, exactly. */
  system: string;
  user: string;
  /** The model's last reply, as text. */
  text: string;
  /** Summed over attempts: a retried call costs twice. */
  usage: Usage;
  attempts: number;
  /** Wall clock over every attempt. */
  durationMs: number;
  /** Who served the call behind a router: `provider` in the response body (OpenRouter), else null. */
  upstream: string | null;
};

export interface Judge {
  judge(request: JudgeRequest): Promise<JudgeResponse>;
}

/**
 * The model answered twice without a usable verdict. Carries what was sent and what came
 * back so the command can keep them on disk before reporting.
 */
export class VerdictError extends CliError {
  readonly judgeId: string;
  readonly system: string;
  readonly user: string;
  readonly text: string;
  readonly usage: Usage;
  readonly attempts: number;

  constructor(judgeId: string, system: string, user: string, text: string, usage: Usage, attempts: number) {
    super(`judge '${judgeId}' did not return a verdict in the expected shape after two attempts`, 1);
    this.name = "VerdictError";
    this.judgeId = judgeId;
    this.system = system;
    this.user = user;
    this.text = text;
    this.usage = usage;
    this.attempts = attempts;
  }
}

/** The rubric, then the fixed instructions. */
export function systemPrompt(rubric: string): string {
  return `${rubric.trimEnd()}\n\n${INSTRUCTIONS}\n`;
}

/** A or B back to the side it stood for; a tie is a tie. */
export function translate(preference: Preference): Environment | "tie" {
  return preference === "tie" ? "tie" : MAPPING[preference];
}

export type ModelJudgeOptions = {
  /** Passed to the call as is. */
  providerOptions?: ProviderOptions;
  /** Per call; absent means no limit. */
  timeoutMs?: number;
};

/**
 * A judge backed by an AI SDK model. Two independent retries, at most one of each: a reply
 * that does not fit the schema, and a call aborted at `timeoutMs`.
 */
export function modelJudge(model: LanguageModel, options: ModelJudgeOptions = {}): Judge {
  return {
    async judge(request) {
      const system = systemPrompt(request.rubric);
      const user = request.context;
      const usage: Usage = { input: 0, output: 0, reasoning: null };
      const started = Date.now();
      let text = "";
      let attempts = 0;
      let malformed = 0;
      let timeouts = 0;
      for (;;) {
        attempts++;
        try {
          const result = await withTimeout(options.timeoutMs, (abortSignal) =>
            generateText({
              model,
              system,
              prompt: user,
              output: Output.object({ schema: VERDICT_SCHEMA }),
              ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
              abortSignal,
              // Off by default in the SDK; the router's `provider` lives only in the body.
              include: { responseBody: true },
            }),
          );
          if (result === TIMED_OUT) {
            if (++timeouts < 2) continue;
            const limit = Math.round((options.timeoutMs ?? 0) / 1000);
            throw new CliError(
              `judge '${request.id}' timed out twice: no reply within ${limit}s from ${modelName(model)}; ` +
                `raise "judge.timeoutSeconds" in ${CONFIG_FILE} or pick a faster provider`,
              1,
            );
          }
          add(usage, result.usage);
          return {
            verdict: result.output,
            system,
            user,
            text: result.text,
            usage,
            attempts,
            durationMs: Date.now() - started,
            upstream: upstream(result.response.body),
          };
        } catch (error) {
          if (error instanceof CliError) throw error;
          if (!NoObjectGeneratedError.isInstance(error)) {
            throw new CliError(`judge '${request.id}': the model request failed: ${(error as Error).message}`, 1);
          }
          if (error.usage !== undefined) add(usage, error.usage);
          text = error.text ?? "";
          if (++malformed >= 2) throw new VerdictError(request.id, system, user, text, usage, attempts);
        }
      }
    },
  };
}

const TIMED_OUT = Symbol("timed out");

/** `call`, or TIMED_OUT once `ms` pass, its signal aborted then; the call may ignore the signal. */
async function withTimeout<T>(
  ms: number | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  if (ms === undefined) return call(controller.signal);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      // Settled first, so the call's own abort rejection cannot win the race.
      resolve(TIMED_OUT);
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function modelName(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/** The serving provider a router names in its response body; null when there is none. */
function upstream(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const provider = (body as Record<string, unknown>)["provider"];
  return typeof provider === "string" && provider !== "" ? provider : null;
}

function add(
  into: Usage,
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    outputTokenDetails?: { reasoningTokens: number | undefined };
  },
): void {
  into.input += usage.inputTokens ?? 0;
  into.output += usage.outputTokens ?? 0;
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  if (reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + reasoning;
}
