# HarnessBench

HarnessBench regression-tests AI coding harness changes (`CLAUDE.md`, `.claude/`, `AGENTS.md`)
by running fixed engineering tasks against the same code with the old and new harness and
comparing results.

## Project

* TypeScript, ESM, Node 20+. `npm run build` compiles to `dist/`; `npm test` runs
  `node --test 'dist/**/*.test.js'`. Do not claim a change works unless both pass.
* No runtime dependencies except two layers, each confined to its directory:
  * the model layer (`ai` and its providers, plus `zod`) used by judges: nothing outside
    `src/judge/` imports them; tests may import `ai/test` for the mock model;
  * the UI layer (`ink`, `react`): nothing outside `src/ui/` imports them, and `.tsx` files live
    only there (`"jsx": "react-jsx"`); UI tests use `ink-testing-library`.

## Where things live

Every file has one job. Find the job, then the file; do not search.

| file | job |
|---|---|
| `cli.ts` | parse argv, dispatch to a command, map outcomes to exit codes, print `HELP` |
| `commands/<name>.ts` | orchestrate one command: preflight, do the work, hand data to `print.ts` |
| `preflight.ts` | `requireX(...)` checks that throw `CliError` with a fix in the message |
| `print.ts` | the only formatter: `format*(data): string`, aligned columns via `padEnd` |
| `config.ts` | `.harnessbench/config.json`: shape, defaults, `validate`, `load` |
| `run-record.ts` | `run.json` shape, `readRunRecord`, `writeRunRecord`, `RUNS_DIR` layout, `writeReport` |
| `fixtures.ts`, `judges.ts` | the two catalogues under `.harnessbench/`; same loading pattern |
| `compare.ts`, `telemetry.ts` | pure: records in, rows or stats out |
| `report.ts` | pure: records and comparisons in, the batch's `BatchReport` out |
| `workspace.ts` | the disposable clone an agent runs in |
| `agents/` | agent adapters behind `AgentAdapter`; `claude-code-stream.ts` parses the stream |
| `detect/` | pure detection, `Detection<T> | null`, never writes |
| `plan.ts` | the only thing that writes to the host repo, as `FileOp[]` applied once |
| `events.ts` | the `RunEvent`s commands emit, the `EventBus`, the `events.jsonl` recorder |
| `render/plain.ts` | the plain renderer: stderr progress lines from events |
| `ui/` | the interactive renderer (Ink): `state.ts` reducer, `Board.tsx`, `Results.tsx`, `App.tsx`, `index.ts` view; `select.ts` picks UI or plain |
| `errors.ts` | `CliError(message, exitCode)` |

Tests sit beside their module as `x.test.ts`, use `node:test` and `node:assert/strict`, build
fake state on disk in a temp directory, and never run a real agent (`test/fixtures/` has fake
executables).

## Adding a command

The pattern is fixed; `commands/compare.ts` is the model to copy.

1. `commands/<name>.ts`: an options type, one exported function that starts with the same
   `requireGit` / `requireRepo` / `requireConfig` calls the other commands use, reads what it
   needs through the existing readers (`readRunRecord`, `listFixtures`, ...), and returns data.
2. `print.ts`: one `format<Name>(data): string` (and a JSON variant if `--json` is supported).
   Formatting lives here and nowhere else.
3. `cli.ts`: the dispatch branch, the `HELP` text, any new flag in `BOOLEAN_FLAGS` or read via
   `value(flags, ...)`.
4. `commands/<name>.test.ts`: fabricate the on-disk state, call the function, assert on the
   returned data and on printed output; cover the empty case and the error cases named in the
   task.

Nothing else changes for a new command. If you find yourself touching a module not listed
above, stop and check whether the task actually asks for it.

## Working method

* Read the task, then read `commands/compare.ts`, `print.ts` and the reader you will use. That
  is usually all the reading a command needs; the table above answers "where is X" without
  opening files.
* Delegate broad questions ("how do the existing commands handle `--json`?") to an `Explore`
  sub-agent and ask it for file names and the one convention you need, not summaries of
  everything.
* Write the change, then build and test once. Read the failure, fix the cause, re-run. Do not
  build after every edit.
* The task is the whole scope. Do not refactor, rename, split or "tidy" anything the task did
  not ask for, even when a comment or memory file suggests a future refactor. Mention such
  opportunities in one line at the end instead.

## Engineering rules

* Agents run in disposable workspaces with isolated configuration and must not modify the host
  repository. Preserve that.
* Never read, store, log, or print credentials.
* Tests must not invoke real coding agents.
* Prefer the existing pattern over a new abstraction, dependency or layer.
* Every behaviour change has a test. Every user-facing error says what failed and how to fix it.

## Reporting

When done, report in this order and nothing more: the build/test result as it is; the files
changed, one line each; any decision you made that the task left open; refactor opportunities
you deliberately left alone.
