import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MAX_TURNS_SUBTYPE, StreamParser } from "./claude-code-stream.js";
import { MAIN_THREAD, type AgentAdapter, type AgentRequest, type AgentResult } from "./types.js";

const DEFAULT_COMMAND = "claude";

/** Enough stderr to explain a failure, without keeping a whole run's logging. */
const MAX_STDERR_CHARS = 2000;

/**
 * Everything Claude Code needs to reach a model, whichever way it is configured, and nothing
 * else: no editor state, no shell profile, no credentials for anything but the model.
 */
const FORWARD_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;

/** `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`: a subscription, not an API key. */
const CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/** Single-quoted for `bash -c`; a name still resolves on PATH when quoted. */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function env(configDir: string, extra: readonly string[]): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of [...FORWARD_ENV, ...extra]) {
    const value = process.env[name];
    if (value !== undefined) forwarded[name] = value;
  }
  return {
    ...forwarded,
    // Inside the workspace, so the user's own ~/.claude is never read or written.
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CI: "1",
  };
}

function commandLine(request: AgentRequest): string {
  const { config } = request;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (config.model !== null) args.push("--model", config.model);
  if (config.maxTurns !== null) args.push("--max-turns", String(config.maxTurns));
  args.push(...config.args);
  const binary = config.command === "" ? DEFAULT_COMMAND : config.command;
  return [binary, ...args].map(quote).join(" ");
}

export const claudeCode: AgentAdapter = {
  name: "claude-code",
  defaultCommand: DEFAULT_COMMAND,
  forwardEnv: FORWARD_ENV,
  credentialEnv: CREDENTIAL_ENV,

  async run(request: AgentRequest): Promise<AgentResult> {
    const { workspace, config, prompt, rawOutputPath, stderrPath } = request;
    if (!existsSync(workspace.tree)) {
      throw new Error(`no workspace at ${workspace.tree}`);
    }

    const configDir = join(workspace.dir, "claude-config");
    await mkdir(configDir, { recursive: true });
    if (config.model !== null) {
      const settings = `${JSON.stringify({ model: config.model }, null, 2)}\n`;
      await writeFile(join(configDir, "settings.json"), settings, "utf8");
    }

    await mkdir(dirname(rawOutputPath), { recursive: true });
    await mkdir(dirname(stderrPath), { recursive: true });
    const raw = createWriteStream(rawOutputPath);
    const errors = createWriteStream(stderrPath);
    const { onEvent } = request;
    const parser = new StreamParser({
      tree: workspace.tree,
      onEvent:
        onEvent === undefined
          ? undefined
          : (event) =>
              onEvent(
                event.type === "turn"
                  ? { type: "side.turn", turn: event.turn, tokens: event.tokens, costUsd: event.costUsd }
                  : { type: "side.tool", thread: event.thread, kind: event.kind, label: event.label, failed: event.failed },
              ),
    });
    let pending = "";
    let stderr = "";

    // The stream carries no clocks, so every line is stamped with when it reached us.
    const started = Date.now();
    const elapsed = (): number => Date.now() - started;
    const exec = await workspace.exec(commandLine(request), {
      env: env(configDir, config.env),
      stdin: prompt,
      timeoutMs: config.timeoutMinutes * 60_000,
      onStdout: (chunk) => {
        raw.write(chunk); // Verbatim, before we make anything of it.
        pending += chunk;
        const at = elapsed();
        for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
          parser.push(pending.slice(0, end), at);
          pending = pending.slice(end + 1);
        }
      },
      onStderr: (chunk) => {
        errors.write(chunk);
        stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
      },
    });
    if (pending !== "") parser.push(pending, elapsed()); // A last line with no newline.
    await Promise.all([finished(raw), finished(errors)]);

    const parsed = parser.finish();
    // Claude Code exits non-zero when it hits --max-turns, so the subtype is checked first.
    const outcome: AgentResult["outcome"] = exec.timedOut
      ? "timeout"
      : parsed.resultSubtype === MAX_TURNS_SUBTYPE
        ? "max_turns"
        : exec.exitCode !== 0 || parsed.isError
          ? "error"
          : "completed";

    const transcript = [...parsed.transcript];
    // The agent records its own failures; these are the ones only we can see.
    const ours = { thread: MAIN_THREAD, at: exec.durationMs, type: "error" } as const;
    if (outcome === "timeout") {
      transcript.push({ ...ours, message: `timed out after ${config.timeoutMinutes} minutes` });
    } else if (outcome === "error" && !parsed.isError) {
      transcript.push({ ...ours, message: exited(exec.exitCode, stderr) });
    }

    return {
      outcome,
      exitCode: exec.exitCode,
      model: parsed.model,
      finalMessage: parsed.finalMessage,
      tokens: parsed.tokens,
      costUsd: parsed.costUsd,
      durationMs: parsed.durationMs ?? exec.durationMs,
      turns: parsed.turns,
      toolCalls: parsed.toolCalls,
      toolFailures: parsed.toolFailures,
      transcript,
    };
  },
};

function finished(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
}

function exited(exitCode: number | null, stderr: string): string {
  const how = exitCode === null ? "was killed" : `exited with code ${exitCode}`;
  return stderr.trim() === "" ? `${DEFAULT_COMMAND} ${how}` : `${DEFAULT_COMMAND} ${how}: ${stderr.trim()}`;
}
