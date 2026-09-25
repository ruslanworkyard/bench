# MEMORY.md — harnessbench

Project memory for anyone (human or agent) picking this up. Settled decisions, milestones and
what comes next. Code structure lives in `AGENTS.md`; details of a module live in the module.

## What this is

Regression tests for an AI coding harness. A harness is the set of files a coding agent reads
as instructions: `CLAUDE.md` (any depth), `.claude/**`, `.mcp.json`, `AGENTS.md`, `GEMINI.md`,
`.cursorrules`, `.cursor/rules/**`, `.aider.conf.yml`, `CONVENTIONS.md`, plus any repo file
those files `@import` or link to. Change the harness, run a fixed set of engineering tasks
against the same code with the old and new harness, and report per-criterion deltas so the
change is measured rather than accepted on feel.

Goal: an open-source npm package (`npx harnessbench`) people adopt. Quality over breadth.

## Decisions that are settled (do not reopen without a reason)

- **Two environments only**: `previous` = harness files from the base branch (`main` by
  default), `candidate` = harness files from the current branch. Code is the current branch's
  HEAD in both; only harness files differ. There is no "no harness" control environment.
- **One run per fixture per environment.** Agents run at low temperature; repeats cost money.
  Small deltas are reported as within noise, not dressed up as signal. Repeats are an opt-in.
- **Judges carry the signal.** Almost nothing about code quality is measurable portably across
  languages. The mechanical layer is: whether the tests the agent wrote pass, diff size, and
  agent telemetry (tokens, cost, time, turns, tool calls). Everything else — correctness
  against the prompt, quality, scope, maintainability, test intent, reasoning efficiency — is
  decided by an AI judge shown `previous` and `candidate` side by side, blind, pairwise.
- **Fixtures are just tasks.** `fixture.json` (`id`, `kind`, `description`, optional `tags`)
  + `prompt.md`. No pinned commit, no acceptance tests, no hidden files, no scope contract.
  The agent sees the repo and the prompt. Correctness is judged; the tests row says only
  whether the agent's own tests pass against its own code.
- **Fixtures must be realistic engineering work** that is arbitrary enough to build in any
  codebase and unnecessary enough that no codebase already has it. Not katas.
- **Deltas, not scores.** One row per criterion; a composite may exist for CI gating but never
  hides rows. Noise thresholds live in one table in `compare.ts`; a delta must clear both a
  relative and an absolute floor.
- **Agents live behind an adapter** (`AgentAdapter` in `src/agents/types.ts`): one prompt in,
  one `AgentResult` out (outcome, telemetry, normalised transcript). An adapter never decides
  whether a run was a success, never prints, and writes only inside the workspace it is given.
  It returns `max_turns`/`timeout`/`error` as outcomes; it throws only for our own bugs. Config
  names the adapter (`agent.name`) and everything agent-specific hangs off that block.
- **Credentials are never read, stored or printed.** They stay in the host environment;
  preflight only checks that one of the adapter's `credentialEnv` names is set, and the
  adapter forwards the ones on its `forwardEnv` list. The agent gets nothing else: its config
  directory is inside the workspace, so the user's own `~/.claude` is neither read nor written.
  The one file that may hold a key is `.harnessbench/.env` (gitignored by `init`): `env.ts`
  reads it into `process.env` before any preflight, never overriding a variable the shell
  already set, so CI is untouched. Nothing prints its values; a malformed line is reported by
  number.
- **Single npm package**, TypeScript, ESM, Node >= 20.12 (`util.parseEnv`). No runtime
  dependencies except the model layer used by judges: `ai` with `@ai-sdk/anthropic`,
  `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, and `zod`, all pinned to
  exact versions. Nothing outside `src/judge/` imports them (tests may import `ai/test` for the
  mock model). Hand-written argv parsing until it hurts.
- **Judges are a catalogue like fixtures**: `judges/<id>/judge.json` + `prompt.md` ship with the
  package, `init` copies them into `.harnessbench/judges/`, the repo edits or adds its own. A
  judge is a rubric plus a declaration of what it may look at (`context`, from a fixed menu).
  The judge sees the two sides as **A** and **B**, `previous` always A and `candidate` always
  B, fixed by design: a first-position tilt, if any, favours the incumbent. No truncation,
  ever: an item over `judge.maxContextKb` refuses the whole command. Only a pair of `completed`
  runs is judged.
- **Verdicts are rows of the one comparison table**, never a separate block: text, `--json` and
  markdown all carry them, because the markdown is the PR comment. A verdict carries the hash of
  the rubric it was produced under, and the table says when a verdict is stale, missing or
  orphaned rather than hiding it. `judge` is incremental and merges into the pair's
  `judge.json`; `compare` never calls a model.
- **The tests row is the agent's tests, not the suite.** Fixtures are tasks in the spirit of
  the repo, not real functionality, so "did the change break the system" is not the signal, and
  a whole suite costs 10–15 minutes a side on a real project. `testFiles` (globs, `**`) picks
  the test files among the side's added or modified files (`git diff --name-status`, renames as
  delete + add, deletions never); `testCommand` narrows to them with `{files}` (shell-quoted,
  sorted) and/or `{dirs}` (their directories, `./`-prefixed), and gets the list as
  `HB_TEST_FILES` too. A command with neither placeholder runs as is (the whole suite). States:
  `passed`, `failed`, `none written` (placeholder command, no test files: nothing runs),
  `not run` (`testCommand` is `""`: an environment that cannot test, e.g. iOS on a Linux runner,
  a deliberate gap). `passed` beats `failed` and `none written`, which are not ranked against
  each other (the judges say which is worse); `not run` on either side makes the row n/a. The
  row keeps id `tests`; its label is `testLabel` (default "Agent's tests"; "Lint", "Build" for a
  project whose verification is not a test runner). Old records read: a bare command result maps
  by exit code, `null` to `not run`.
- **`init` writes fast mode only when it is exact.** A wrong per-file command silently runs
  nothing or the wrong thing, so detection is exact or not at all. `detect/test-files.ts` gives
  `testFiles` as the union of each present ecosystem's globs (package.json, Python manifests or
  `conftest.py`/`pytest.ini`, composer.json (+ Pest), Gemfile with rspec, go.mod). The per-file
  command (`detect/test-command.ts`) is written only for a runner called bare: Jest, Vitest,
  `node --test` on source paths, pytest, Pest, PHPUnit (no Pest), RSpec, `go test {dirs}`. The
  full-suite command, with a `hint` on the detection naming why and what to write instead, when:
  a build precedes the tests (`scripts.test` or `scripts.pretest`) or they run from
  `dist/`/`build/`/`out/`; a monorepo; Gradle/Maven/.NET/Cargo/Swift; the runner has options in
  `scripts.test` we would drop; several runners; test files of several ecosystems (one runner
  cannot take them all); or no mappable runner (hint: the nearest example). This repo falls back
  (pretest builds to `dist/`); its config is written by hand.
- **Bin name == package name** so `npx harnessbench` works.
- **A batch is a stamp.** One `run` invocation runs a set of fixtures under one
  `YYYYMMDD-HHMMSS` stamp; nothing else on disk names the batch. A pair is
  `<stamp>-<fixture>-previous` + `<stamp>-<fixture>-candidate`, a judgement
  `<stamp>-<fixture>-judge`. Addressing, the same for `compare` and `judge`: no arguments → the
  newest stamp with at least one complete pair; `--stamp <s>` → that batch; `--fixture <id>` →
  that fixture's latest pair; two run ids → that pair. A pair with a missing or unreadable side
  is listed with the reason, never dropped; a batch with no complete pair is refused naming the
  stamp and what is missing. The roll-up across fixtures is one row per criterion listing the
  fixture ids per classification (counts always come with names); no composite, no row summing
  across criteria.
- **A batch has one report object** (`BatchReport` in `report.ts`, pure, `schema: 1`): header
  shas, agent, judge, roll-up, and per fixture its comparison, both sides as `SideSummary` data
  and any error. Everything renders it: the terminal summary (`formatSummaryReport`), the
  markdown (`formatReportMarkdown`), JSON (`JSON.stringify(report, null, 2)`). It lives at
  `runs/<stamp>/report.md` + `report.json`, written atomically (temp file, rename) by `run` and
  rewritten by `compare` and `judge` whenever they address that batch — batch addressing, or a
  pair whose two runs share a stamp (then stdout shows the pair, the file the whole batch).
  `$GITHUB_STEP_SUMMARY` gets the markdown appended; the CLI reads that variable, commands take
  it as an option. Nothing else is GitHub-specific.
- **Judges run concurrently and fail alone (2026-09-25).** Every judge call of every pair starts
  at once (`Promise.allSettled`); a batch costs its slowest call. The pair's `judge.json` is
  still written once, atomically, after its calls settle; a failed judge has no verdict (the row
  shows missing; an older verdict of that judge is dropped), the others are written, then the
  failure is thrown naming it. Judge time is reasoning output × the upstream provider's
  throughput, which a router varies call to call (26s–7m40s for the same ~10k-token prompt), so
  a verdict records `durationMs`, `attempts`, `upstream` (the body's `provider`, OpenRouter) and
  `usage.reasoning`; stderr gets `[mm:ss] <fixture>  judge <id>  <preference> (12s, upstream X)`
  and the report's judge rows `(judged in 12s)`. `judge.timeoutSeconds` (180) aborts a call and
  retries once; that retry and the schema retry are independent, at most one of each.
- **`judge.providerOptions` is opaque.** Config-level, or a judge.json's own which replaces it
  whole (no merge). Wrapped under the provider package's key and passed to `generateText`
  untouched; openai-compatible spreads unknown keys into the request body, which is how
  OpenRouter's `provider.sort` / `reasoning.effort` reach the API. Our code reads no key of it.
- **The agent never sees the tool's material.** `workspace.hidePaths` (globs, default
  `[".harnessbench"]`, nothing more by default) is deleted from the tree after clone, overlay and
  rebaseline, before setup, and excluded (`:(exclude,glob)p` + `p/**`) from `diff`,
  `--name-status` and so test selection; `.harnessbench` is excluded even when not hidden. Agents
  used to `cat` their own fixture prompt and write about it in MEMORY.md. Tool logs and
  transcripts shown to a judge have the workspace tree's absolute path rewritten to `.` and a
  leading `cd <tree> &&` dropped.
- **Benchmarking this repo:** the package's own `fixtures/` ships the default fixtures and our
  tests read it, so it cannot be hidden. Do not benchmark this repo with a fixture that is also
  shipped in `fixtures/` (the agent can read its task there); use repo-only fixtures in
  `.harnessbench/fixtures/`.
- **Events are the only interface between work and rendering (2026-09-25).** Commands emit
  typed `RunEvent`s (`events.ts`: `batch.start`, `side.phase`, `side.turn`, `side.tool`,
  `side.done`, `judge.start`/`verdict`/`failed`, `batch.done`, each with `at` = ms since the
  command started) on an `EventBus` (`emit`, `subscribe`; a throwing subscriber is a warning,
  the others still hear it). Renderers subscribe and never compute: the stderr progress lines
  are `render/plain.ts`, byte-identical to the old direct writes; `side.phase.detail` carries
  the words of the line for how the previous phase ended. The Claude Code parser emits a turn
  per completed assistant message (running usage, latest reported cost) and a tool per call and
  per failed result, labelled as the judge's tool log labels it. Not yet events, still direct
  `console.error`: the dirty-harness warning, `judging skipped`, `judge rows skipped`.
- **`events.jsonl` (2026-09-25).** `run` records every event to `runs/<stamp>/events.jsonl`,
  beside the report, starting `batch.start` and ending `batch.done`. `judge`, when its pairs are
  one batch's, appends its events after a `{ "type": "session", "command": "judge", "startedAt" }`
  line, written only when an event follows; its `at` counts from its own start. `compare` emits
  nothing, so records nothing. `replay [<stamp>] [--speed <n>]` re-emits the file on a bus
  (spacing / speed, default 10, 0 instant; a session line restarts the clock), then prints the
  batch's `report.json` as `run` did. A batch without the file predates recording and is refused
  naming `compare --stamp`. The UI (next) is one more subscriber; `--plain` picks today's.
- **stdout rules for `run`, `compare`, `judge`:** stdout carries the report and nothing else —
  the one-screen summary by default (header, warnings, three verdict lines Outcome / Efficiency
  / Judges, one line per fixture with each judge's preference, the report path), the markdown
  with `--detail` (and `compare --markdown`), the report document with `--json`. No reasons or
  per-side detail on the terminal. Progress, warnings before the run and `N runs finished in
  mm:ss` go to stderr. The Judges line sums preferences across judges by request; it is a count
  line, not a composite.

## File relationship between the tool and a host repo

```
<host repo>/
  CLAUDE.md, .claude/, AGENTS.md, ...   the harness — read, never written
  .harnessbench/
    config.json                         written by init, committed
    .env                                credentials, KEY=value; gitignored by init, never written by the tool
    .env.example                        written by init once, committed: the variables the configured
                                        agent and judge could use, all commented out
    fixtures/<id>/                      fixture.json + prompt.md, committed; built-ins are copied here
    judges/<id>/                        judge.json + prompt.md, committed; built-ins are copied here
    runs/<ts>-<fixture>-<env>/          one run, gitignored: run.json, raw.jsonl, transcript.jsonl,
                                        diff.patch, setup.log, test.log, agent.stderr.log; every
                                        directory of one `run` invocation shares <ts> (the "stamp")
    runs/<ts>-<fixture>-judge/          the verdicts on that pair, gitignored: judge.json, and per
                                        judge id prompt.txt (as sent) + response.json (raw reply)
    runs/<ts>/                          the batch's report, gitignored: report.md + report.json, written
                                        by run and rewritten by compare/judge; never matches RUN_ID
```
The tool reads the host through git, writes only under `.harnessbench/`, and works in a temp
worktree (`$TMPDIR/harnessbench/<run>/tree`) with an isolated `HOME` for the agent.
`.harnessbench/` is excluded from the harness set and from diffs, and deleted from the workspace tree (`workspace.hidePaths`).

## Structural invariants (why `src/` is shaped the way it is)

`AGENTS.md` has the file-by-file table. What it does not say, and what must survive a refactor:

- Files are grouped by **what they are allowed to do to the world**, not by feature. `detect/`
  asks (`Detection<T> | null`, never throws, never writes), `preflight.ts` decides (throws
  `CliError` carrying the fix), `plan.ts` writes, `print.ts` formats, `agents/` drives one
  external agent, `judge/` asks a model one question, `commands/` composes them in order.
- **One writer, one formatter.** `--dry-run` and idempotence are free because of it. The one
  exception: a run's own directory under `.harnessbench/runs/` is streamed to disk while the
  agent runs (by `commands/run.ts`, the adapter and `run-record.ts`); it is gitignored output,
  not state, so there is nothing to plan.
- An object that appears in several layers gets its own top-level file (`config.ts`,
  `run-record.ts`, `telemetry.ts`, `compare.ts`, `workspace.ts`, `fixtures.ts`, `judges.ts`).
  Imports form a DAG, checked by eye; every arrow points down. No barrel `index.ts` files —
  `agents/index.ts` is the registry that maps `agent.name` to an adapter, not a barrel.
- **Run-file compatibility lives in exactly one place**: `readRunRecord` rejects any schema
  number but its own. A missing config key takes its default, so an old config keeps loading;
  an unknown key is an error naming it, because a typo is otherwise a silently ignored setting.
- Split triggers, not pre-empted: `print/init.ts` + `print/run.ts` + `print/format.ts` when
  `print.ts` actually hurts (it has fired on paper, deferred); `validate.ts` on the third
  hand-rolled JSON validator. Already fired: `agents/`, `judge/`.
- Avoid: feature folders (`init/`, `run/` each with their own detect+print) — they kill the
  single-writer and single-formatter invariants; a `types.ts` dumping ground.
- Tests: `node:test`, colocated as `x.test.ts`; `npm test` runs `dist/**/*.test.js`, so the
  suite exercises the built artifact. Disk data lives in `test/fixtures/` (recorded agent
  streams, fake agent shell scripts), not to be confused with the top-level `fixtures/` the
  package ships. **No test ever runs a real agent**: a fake shell script stands in, so the suite
  is free, offline and deterministic.

## Milestones

- **Package skeleton and `init`.** `npx harnessbench` works. `init` detects git root, base
  branch, harness files (conventions + followed `@imports` and markdown links), test command
  and agent CLIs on PATH; writes `.harnessbench/config.json`, copies built-in fixtures and
  judges, manages `.gitignore` and `.env.example`. Idempotent; `--dry-run`, `--json`.
  Built-in fixtures: `announcements`, `holiday-api-client`, `ttl-cache`.
- **`run <fixture>` end to end (2026-09-19).** Workspace (shallow clone at a ref, isolated
  HOME, process-group exec) → Claude Code adapter (stream-json parsed line by line as it
  arrives, raw stdout streamed to disk) → `diff.patch` → test command → `transcript.jsonl` +
  `run.json`. Exit codes: 0 completed, 2 timeout, 3 agent error, 4 max_turns, 1 preflight; a
  failing test suite is a result, not an exit code.
- **Both environments (2026-09-20).** `previous` = the harness at `git merge-base <base> HEAD`
  on HEAD's code, applied by `overlayHarness` + `rebaseline` so the agent sees a plain checkout
  and the diff measures only its work. `harnessSnapshot` hashes the harness so identical
  harnesses are detected and warned about. `run.json` is `schema: 2`.
- **`setupCommand` (2026-09-20).** Runs after the overlay and before the agent, so the agent
  does not spend its first turns on `npm install`. Detected only from a lockfile, never a
  manifest alone (a non-frozen install rewrites the lockfile and pollutes the diff).
- **`compare` + telemetry + `max_turns` (2026-09-20).** The per-criterion delta table: outcome,
  tests, diff, turns, tool calls, sub-agents, reads before first edit, duplicate reads, phases,
  tokens, cost, duration. Telemetry is pure, derived from the normalised transcript only, so
  every adapter gets it free. `max_turns` is its own outcome because compare must tell budget
  from breakage and a judge must never be handed a cut-off run as finished.
- **Judges (2026-09-21).** The judge catalogue, `harnessbench judge` and `run --judge`. Three
  draft rubrics ship: `code-quality`, `engineering-practices`, `test-quality`.
- **`.harnessbench/.env`, judge rows, incremental judging (2026-09-22).** Verdicts became rows
  of the comparison table (`formatVerdicts` is gone); a verdict carries its `rubricHash`, so
  judging re-runs only what changed and `--all` forces the rest.
- **Concurrent sides and clean interruption (2026-09-22).** Both sides run at once; wall clock
  is the slower side, not the sum. One side's failure never cancels the other. Progress goes to
  stderr one line per event, stdout stays pure JSON under `--json`. SIGINT/SIGTERM (installed
  for `run` only) kills every workspace's process group and exits 130, because the detached
  agents never see the terminal's Ctrl-C.
- **Fixture sets (2026-09-22).** `run [<fixture-id>...] [--tag <tag>]... [--concurrency <n>]`
  runs a batch under one stamp, fixtures independent.
- **Batch reports (2026-09-24).** One `BatchReport` per batch, on disk as
  `runs/<stamp>/report.md` + `report.json`; the terminal gets a one-screen summary, `--detail`
  the markdown, `--json` the document (replacing the per-command JSON shapes). Appended to
  `$GITHUB_STEP_SUMMARY` when set; the README has a sticky-comment workflow step. The old text
  renderers (`formatRun`, `formatComparison`, `formatRollup`, `formatBatch*`, `formatJudging`)
  are gone. Judge instructions now forbid asserting how unseen code behaves.

- **Agent's tests (2026-09-25).** The tests row runs only the test files the agent added or
  changed (`testFiles`, `{files}` / `{dirs}`, `HB_TEST_FILES`), with the four states above and a
  configurable `testLabel`. This repo runs `npm run build && node --test` on the changed tests'
  `dist/` twins.

- **Fast-mode detection in `init` (2026-09-25).** `testFiles` and the per-file `testCommand`
  from detection, `--test-files <glob>` (repeatable) to override, a `Test files` summary line,
  and the fallback hint under the test command.

- **Judges concurrent, observable, bounded; task out of the workspace (2026-09-25).** See the
  settled decisions above: concurrent judge calls, `providerOptions`, `timeoutSeconds`,
  per-verdict timing/upstream, `workspace.hidePaths`, relative paths in tool logs.

- **Events and replay (2026-09-25).** See the settled decisions above: the event bus, the plain
  renderer, `events.jsonl`, `replay`.

## Deliberately not built

Named so they are not re-proposed as ideas: baseline reuse (skipping a `previous` run whose
harness hash is unchanged), a flag to run one side only, install caching between runs, position
swap as a second judge call, CI gating on a composite, per-fixture agent settings, shell-command
classification in telemetry, credential encryption or `.env.ci` variants.

## Next

- A rich terminal UI (Ink) as a second subscriber, fed by the event stream and the final
  `BatchReport`; `replay` demonstrates it without running agents.
0. A real batch (`npx . run --judge --keep`) on this repo, three fixtures; read the roll-up and
   check the wall clock and the progress lines are legible with six sides interleaved.
1. Test `init --dry-run` on a real repo with a real `CLAUDE.md`; check the harness list,
   test command (and its fast mode or hint), test files and base branch are right. Fix what's wrong.
2. Real-agent smoke of `run`; fix what the real stream shows that the recording did not. Then
   `judge` on that pair with a real model: read `prompt.txt` and the verdicts by hand; revise
   the three draft rubrics from what the model actually did with them.
3. Position swap as an opt-in second judge call.
4. Gating and exit codes on the report (next task). A packaged GitHub Action around the README's
   workflow step; cache `previous` by harness hash so a PR pays only for the candidate side.
5. More agent adapters (Codex, Aider, Gemini CLI, OpenCode, Pi): implement `AgentAdapter` and
   register it in `agents/index.ts`. Note `detect/agents.ts` knows more binaries than we have
   adapters for — it reports what is on PATH; only a binary with an adapter is offered.

## Working style

Ruslan builds; Claude reviews, designs, and writes prompts for the coding agent. Discuss the
contract before scripting it. Keep answers short. Do not add fields, layers or features that
no current command needs.
