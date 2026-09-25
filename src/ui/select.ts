/**
 * Which renderer a command gets: the interactive UI only when a person is at a terminal and
 * nothing asked for text. Pure, and free of the UI layer's imports, so the CLI can decide
 * before loading it.
 */

export type Renderer = "ui" | "plain";

export type RendererInput = {
  stdoutTTY: boolean;
  stdinTTY: boolean;
  /** `--json`, `--plain`, and `--detail` / `--markdown` (the markdown on stdout). */
  json: boolean;
  plain: boolean;
  detail: boolean;
  env: NodeJS.ProcessEnv;
};

export function selectRenderer(input: RendererInput): Renderer {
  const ci = input.env["CI"] !== undefined && input.env["CI"] !== "";
  if (!input.stdoutTTY || !input.stdinTTY || input.json || input.plain || input.detail || ci) return "plain";
  return "ui";
}
