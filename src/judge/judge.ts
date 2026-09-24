import { NoObjectGeneratedError, Output, generateText, type LanguageModel } from "ai";
import { z } from "zod";

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

export type Usage = { input: number; output: number };

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

  constructor(judgeId: string, system: string, user: string, text: string, usage: Usage) {
    super(`judge '${judgeId}' did not return a verdict in the expected shape after two attempts`, 1);
    this.name = "VerdictError";
    this.judgeId = judgeId;
    this.system = system;
    this.user = user;
    this.text = text;
    this.usage = usage;
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

const MAX_ATTEMPTS = 2;

/** A judge backed by an AI SDK model. One retry when the reply does not fit the schema. */
export function modelJudge(model: LanguageModel): Judge {
  return {
    async judge(request) {
      const system = systemPrompt(request.rubric);
      const user = request.context;
      const usage: Usage = { input: 0, output: 0 };
      let text = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const result = await generateText({
            model,
            system,
            prompt: user,
            output: Output.object({ schema: VERDICT_SCHEMA }),
          });
          add(usage, result.usage);
          return { verdict: result.output, system, user, text: result.text, usage, attempts: attempt };
        } catch (error) {
          if (!NoObjectGeneratedError.isInstance(error)) {
            throw new CliError(`judge '${request.id}': the model request failed: ${(error as Error).message}`, 1);
          }
          if (error.usage !== undefined) add(usage, error.usage);
          text = error.text ?? "";
        }
      }
      throw new VerdictError(request.id, system, user, text, usage);
    },
  };
}

function add(into: Usage, usage: { inputTokens: number | undefined; outputTokens: number | undefined }): void {
  into.input += usage.inputTokens ?? 0;
  into.output += usage.outputTokens ?? 0;
}
