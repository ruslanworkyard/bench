# HarnessBench

HarnessBench regression-tests AI coding harness changes such as `CLAUDE.md`, `.claude/`, and `AGENTS.md` by running fixed engineering tasks against the same code and comparing results.

## Project

* TypeScript, ESM, Node 20+.
* No runtime dependencies except the model layer (`ai` and its providers, plus `zod`) used by
  judges. Nothing outside `src/judge/` imports them; tests may import `ai/test` for the mock model.
* Build with `npm run build`.
* Run tests with `npm test`.
* Do not claim a change works unless both pass.

## Working method

* Delegate exploration. Do not read files one by one on the main thread to learn the codebase.
  Send reconnaissance to a sub-agent (the `Explore` agent, preferably Haiku): "which files implement X,
  and what conventions do they follow?" Read on the main thread only the files you are about to
  change and the one or two they are modelled on.
* Build and test once the change is written, not after every edit. Read the failure, fix the
  cause, re-run.

## Engineering rules

* Preserve HarnessBench's isolation guarantees. Agents run in disposable workspaces with isolated configuration and must not modify the host repository.
* Never read, store, log, or print credentials.
* Tests must not invoke real coding agents. Use deterministic fixtures or fake executables.
* Prefer simple implementations over new abstractions, dependencies, or layers unless the current change requires them.
* Behaviour changes should be covered by tests.
* Errors exposed to users should explain what failed and how to fix it.

## Existing architecture

Respect the existing module boundaries unless the change genuinely requires altering them:

* `cli.ts` handles arguments and exit codes.
* `commands/` orchestrates operations.
* `detect/` performs non-mutating detection.
* `preflight.ts` validates prerequisites.
* `plan.ts` owns host-side file operations.
* `agents/` contains agent integrations behind `AgentAdapter`.