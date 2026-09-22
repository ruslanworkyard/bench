# MEMORY.md — harnessbench

Project memory for anyone (human or agent) picking this up. Read this before touching code.

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
  languages. The mechanical layer is: the repo's own test command passes/fails, diff size, and
  agent telemetry (tokens, cost, time, turns, tool calls). Everything else — correctness
  against the prompt, quality, scope, maintainability, test intent, reasoning efficiency — is
  decided by an AI judge shown `previous` and `candidate` side by side, blind, pairwise.
- **Fixtures are just tasks.** `fixture.json` (`id`, `kind`, `description`, optional `tags`)
  + `prompt.md`. No pinned commit, no acceptance tests, no hidden files, no scope contract.
  The agent sees the repo and the prompt. Correctness is judged, regression is the test suite.
- **Fixtures must be realistic engineering work** that is arbitrary enough to build in any
  codebase and unnecessary enough that no codebase already has it. Not katas.
- **Deltas, not scores.** Report one row per criterion; a composite may exist for CI gating but
  never hides rows.
- **Agents live behind an adapter** (`AgentAdapter` in `src/agents/types.ts`): one prompt in,
  one `AgentResult` out (outcome, telemetry, normalised transcript). An adapter never decides
  whether a run was a success, never prints, and writes only inside the workspace it is given.
  It returns `max_turns`/`timeout`/`error` as outcomes; it throws only for our own bugs. Config names the
  adapter (`agent.name`) and everything agent-specific hangs off that block.
- **Credentials are never read, stored or printed.** They stay in the host environment;
  preflight only checks that one of the adapter's `credentialEnv` names is set, and the
  adapter forwards the ones on its `forwardEnv` list. The agent gets nothing else: its config
  directory is inside the workspace, so the user's own `~/.claude` is neither read nor written.
  The one file that may hold a key is `.harnessbench/.env` (gitignored by `init`): `env.ts`
  reads it into `process.env` with `util.parseEnv` before any preflight, never overriding a
  variable the shell already set, so CI is untouched. Nothing prints its values; a malformed
  line is reported by number. Not built, on purpose: encryption, `.env.ci`-style variants,
  reading the host project's own `.env`.
- **Single npm package**, TypeScript, ESM, Node >= 20.12 (`util.parseEnv`). No runtime dependencies except the model
  layer used by judges: `ai` with `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`,
  `@ai-sdk/openai-compatible`, and `zod` for the verdict schema, all pinned to exact versions.
  Nothing outside `src/judge/` imports them (tests may import `ai/test` for the mock model).
  Split later along interface seams if ever needed. Hand-written argv parsing until it hurts.
- **Judges are a catalogue like fixtures**: `judges/<id>/judge.json` + `prompt.md` ship with the
  package, `init` copies them into `.harnessbench/judges/`, the repo edits or adds its own. A
  judge is a rubric plus a declaration of what it may look at (`context`, from a fixed menu).
  The judge sees the two sides as **A** and **B**, `previous` always A and `candidate` always
  B, fixed by design: a first-position tilt, if any, favours the incumbent. The mapping is
  recorded in `judge.json` anyway. No truncation, ever: an item over `judge.maxContextKb`
  refuses the whole command. Only a pair of `completed` runs is judged.
- **Verdicts are rows of the one comparison table**, never a separate block: text, `--json`
  and markdown all carry them, because the markdown is the PR comment. A verdict carries the
  hash of the rubric it was produced under, and the table says when a verdict is stale, missing
  or orphaned rather than hiding it. `judge` is incremental and merges into the pair's
  `judge.json`; `compare` never calls a model.
- **Bin name == package name** so `npx harnessbench` works.
- **A batch is a stamp.** One `run` invocation runs a set of fixtures under one `YYYYMMDD-HHMMSS`
  stamp; nothing else on disk names the batch. A pair is `<stamp>-<fixture>-previous` +
  `<stamp>-<fixture>-candidate`, a judgement `<stamp>-<fixture>-judge`. Addressing, the same for
  `compare` and `judge`: no arguments → the newest stamp with at least one complete pair;
  `--stamp <s>` → that batch; `--fixture <id>` → that fixture's latest pair; two run ids → that
  pair. A pair with a missing or unreadable side is listed with the reason, never dropped; a
  batch with no complete pair is refused naming the stamp and what is missing. The roll-up
  across fixtures is one row per criterion listing the fixture ids per classification (counts
  always come with names); no composite, no row summing across criteria.

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
```
The tool reads the host through git, writes only under `.harnessbench/`, and works in a temp
worktree (`$TMPDIR/harnessbench/<run>/tree`) with an isolated `HOME` for the agent.
`.harnessbench/` is excluded from the harness set and from diffs.

## Code structure (src/)

Files are grouped by **what they are allowed to do to the world**, not by feature. Two axes.

**Roles** — each file has exactly one relationship to the outside:

| Place | Job | Signature |
|---|---|---|
| `detect/` | ask the world a question | `x(): Detection<T> \| null` — never throws, never writes |
| `preflight.ts` | turn a `null` into a decision | `requireX(): T` — throws `CliError` carrying the fix |
| `plan.ts` | the only thing that writes | build `FileOp[]`, then `apply()` |
| `print.ts` | the only thing that formats | `format*(data): string` |
| `agents/` | drive one external agent | `run(AgentRequest): Promise<AgentResult>` — returns every outcome, throws for none |
| `judge/` | ask a model one question | `context.ts` (pure: pair → text), `provider.ts` (the only file that knows the AI SDK packages), `judge.ts` (`Judge` interface, `modelJudge`) |
| `commands/` | compose the above, in order | init: detect → plan → apply → print; run: preflight → workspace → agent → record → print; judge: pair → refusals → context → model → record → print |
| `cli.ts` | argv (a `REPEATABLE_FLAGS` value flag such as `--tag` collects into a `string[]`, read with `values()`), exit codes (set via `process.exitCode`, never `process.exit()` except in the `run` signal handler, which writes with `writeSync` first: on macOS a piped stdout is written asynchronously and `exit()` cut a long `--json` off at 8 KB); reads `.harnessbench/.env` (`env.ts`) for run/judge/compare before they preflight; installs the SIGINT/SIGTERM handler for `run` only | nothing else |

**Domain nouns** — an object that appears in several layers gets its own top-level file:
- `config.ts` — `Config` type (`baseBranch`, `testCommand`, `setupCommand`, the `agent` block,
  `harness.extraPaths`, the `judge` block, `judges`), defaults, load/validate. Unknown keys at
  any level are an error naming the key: a typo is otherwise a silently ignored setting. A
  missing key takes its default, so a config written before a key existed keeps loading
  (`setupCommand` → `""`; no `judge` block → anthropic, empty model, 512 KB).
  `judge` = `{provider: anthropic|openai|google|openai-compatible, model, apiKeyEnv, baseUrl,
  structuredOutputs, maxContextKb}` (`structuredOutputs`, default true, is passed to
  `createOpenAICompatible` as `supportsStructuredOutputs`; the SDK defaults it to false and
  then drops the verdict schema, which is what the first OpenRouter run hit; the other three
  providers ignore it); `judges` = the ids to run, in order. `init` writes `model: ""`: the choice is
  the user's, and `judge` refuses until it is made.
- `fixtures.ts` — locate packaged fixtures via `import.meta.url`, copy into the host;
  `selectFixtures(dir, ids, tags)`: all / the ids in the order given (deduplicated) / those
  carrying any tag / the intersection; unknown id and empty selection are `CliError`s listing the
  fixtures and the tags in use. Tags are read from each `fixture.json` only when `--tag` is given;
  a fixture whose file is missing or malformed carries none.
- `judges.ts` — the judge catalogue: `validateJudge` (unknown keys, `context` from the fixed
  menu `prompt | diff | tests | finalMessage | toolLog | transcript`, optional `provider` /
  `model` / `apiKeyEnv` overrides), `listJudges(root)` (duplicate ids refused, missing prompt
  file named), `requireJudge(root, id)`. Directory listing is `listFixtures` from `fixtures.ts`:
  a catalogue is a catalogue. `LoadedJudge.hash` = `rubricHash(rubric, context)`: sha256 over
  the `prompt.md` text, a NUL, and the context list joined with commas, in order.
- `preflight.ts` also resolves a judge's target: `requireJudgeModel` (environment
  `HARNESSBENCH_JUDGE_PROVIDER` / `HARNESSBENCH_JUDGE_MODEL` > judge.json > config; empty
  model → CliError naming the judge and the three places to set one; `openai-compatible` needs
  `baseUrl`; an unnamed key variable is the provider's conventional one) and `requireJudgeKey`
  (checks the variable is set, nothing more). The key's value is read only in
  `judge/provider.ts`, at call time, straight into the SDK.
- `workspace.ts` — a throwaway clone of the host + an isolated HOME, for one run; also the
  harness overlay (`overlayHarness`) and `rebaseline`, which folds the overlay into the clone's
  single commit so the agent sees a plain checkout and `diff()` measures only the agent's work.
  Keeps a module-level registry of live workspaces and, per workspace, the children `exec` has
  running; `abortAll({ keep })` (sync, for the signal handler) kills every child's process
  group with SIGKILL and removes the directories unless `keep`.
- `run-record.ts` — `RunRecord` (`run.json`, `schema: 2`), `Environment`, `CommandResult`
  (the shape of both `setup` and `tests`: command, exitCode, durationMs, timedOut),
  `writeRunRecord`, `readRunRecord`.
  Later commands (compare, judge) read a run only through `readRunRecord`, which rejects any
  other schema number; that is the one place run-file compatibility lives. Also `RUN_ID`
  (`/^(\d{8}-\d{6})-(.+)-(previous|candidate)$/`, moved here from `commands/compare.ts`),
  `Batch = {stamp, pairs: [{fixture, previous | null, candidate | null}]}`, `listBatches(runsDir)`
  (newest stamp first, pairs by fixture id, a side that is missing or does not read is `null`,
  `-judge` directories and files ignored) and `latestBatch(runsDir, filter?)`.
- `telemetry.ts` — `telemetry(events, durationMs): Telemetry`, pure, from the normalised
  transcript only (never the raw stream, so every adapter gets it free): per-thread stats
  (`main` and one entry per sub-agent with its spawning tool and model), reads/turns before
  the main thread's first write, distinct files read/written, repeat reads (main re-reading
  its own) and duplicate reads (main reading what a sub-agent already had), and the wall
  clock split into exploring/building/verifying around the first and last write on any
  thread. A `TranscriptEvent` carries `thread` ("main" or the spawn call's id) and `at`
  (ms since the agent started, stamped by the adapter on arrival; the parser reads no
  clock); `assistant` events carry `model` and per-message `usage`; `tool_call` events
  carry an adapter-neutral `kind` and the `path` relative to the tree. One `assistant`
  event per assistant message, even one with no text, so its usage is never lost; each
  carries `turn`, the adapter's index of the model response it came from (Claude Code emits
  one `assistant` event per content block, all with the same `message.id`, so a text block
  plus a tool call share a `turn`). `ThreadStats.turns` and `turnsBeforeFirstEdit` count
  distinct `turn` values, the meaning `RunRecord.turns` has, so the two figures agree. `RunRecord.telemetry` is optional only because older `run.json` files lack it;
  `run` always writes it; `compare` shows those rows as `n/a`, "recorded by an earlier
  version". Sub-agent tokens are part of the run's totals, reported per thread, never
  subtracted.
- `compare.ts` — `compare(previous, candidate, judgement: JudgeInput | null): Comparison`, pure:
  one `Row` per criterion (`id`, `label`, display strings, `delta`, `classification`, optional
  `note`) plus `warnings` and `judged` (`{provider, model}` of the first verdict, null without
  one; verdicts disagreeing on the model add a warning). `JudgeInput` = `{record: JudgeRecord |
  null, configured: [{id, title, hash}]}`. Judge rows come after the mechanical rows, ids
  `judge.<judge-id>`: configured judges in config order, then the file's verdicts for judges no
  longer configured. Empty previous/candidate cells; delta `candidate preferred | previous
  preferred | tie` → improved/regressed/unchanged; note = the reason, plus ` — rubric changed
  since this verdict; run harnessbench judge --fixture <id>` when `rubricHash` differs or is
  missing, or ` — no longer in config.judges` for an orphan; a configured judge without a
  verdict is `n/a`, `not judged; run harnessbench judge --fixture <id>`. Null `judgement` (no
  judges configured) → no judge rows, no heading.
  The noise thresholds are one table in this file (relative 0.15, 0.20 for diff and the
  read counts; absolute floors turns 3, tool calls 3, toolFailures 1, files 1, lines 20,
  readsBeforeFirstEdit 3, duplicateReads 2); a delta must clear both. `subAgents` is
  `neutral`: always `unchanged`, delta shown, note lists `<tool> on <model>` per side.
  No composite. `rollup(comparisons): Rollup` is pure too: `{fixtures, rows: RollupRow[],
  warnings}`, one `RollupRow` (`id, label, improved[], regressed[], unchanged[], na[]` of fixture
  ids) per row id seen in any comparison, mechanical rows first then judge rows, each in the
  order of the first comparison that has it; warnings are every fixture's, prefixed
  `<fixture>: `. `commands/compare.ts` has two entry points: `compare` loads a pair (two ids, or
  the latest invocation for `--fixture`), orders it by environment, refuses mismatches, prints;
  `compareBatch` loads a batch (`loadBatch(root, stamp?)`) and prints the roll-up plus the
  per-fixture tables (`formatBatch` / `formatBatchMarkdown`, or `--json` as `BatchComparison =
  {stamp, fixtures: [{fixture, comparison | null, error | null}], rollup}`). `compareBatchRecords(root,
  config, batch)` is the shared step (also used by `judgeBatch`): each complete pair through
  `orderPair` (a refusal becomes that fixture's `error`), `loadJudgement` (a misconfigured judge
  is still the whole command's refusal), `compare`; incomplete pairs get `describePair`'s
  `<fixture>: <side> side missing | unreadable (no valid run.json)`. It also owns
  `findJudgeRecord(runsDir, previous, candidate)` (the `*-<fixture>-judge` directory whose
  `judge.json` names both run ids, not the one with the pair's stamp; unreadable or foreign
  files are skipped) and `loadJudgement(root, config, previous, candidate)` (null when
  `config.judges` is empty; a configured judge missing from the catalogue is `judge`'s
  `CliError`). The file name and schema number are repeated there rather than imported, so its
  import of `commands/judge.ts` stays type-only (judge.ts imports `loadPair` from it).
- `judge/context.ts` — pure. `assembleContext(items, pair)`: the fixture prompt once under
  `# Task`, then `# Attempt A` and `# Attempt B`, each with the judge's other items in menu
  order (`diff` verbatim; `tests` as `passed | failed | not configured`, never the log;
  `finalMessage`; `toolLog` = one line per main-thread call `kind path-or-command`, a sub-agent
  folded into its spawn line `spawn <tool> (<n> calls on <model>)`; `transcript` = every event
  as readable text tagged `[main]` / `[sub-agent n]`, no JSON). Run ids and harness hashes are
  scrubbed from the text (they leak through paths in the isolated HOME). `oversized(items,
  pair, maxKb)` measures every rendered item per side before anything is sent.
- `judge/judge.ts` — `INSTRUCTIONS` (the fixed block appended to every rubric, in code so an
  edited rubric keeps it), `modelJudge(model)`: `generateText` with `Output.object` on the zod
  schema `{preference: A|B|tie, reason}` (the AI SDK deprecates `generateObject` in favour of
  this), one retry on a schema failure, then `VerdictError` (a `CliError` carrying the raw
  reply and the prompt so the command can keep them). Any other model error is a `CliError`
  naming the judge. `translate(preference)` maps A/B back to previous/candidate.
- `commands/judge.ts` — `judge(options, deps)` for the CLI, `judgePair(root, config, previous,
  candidate, deps, all)` shared with `run --judge` (which passes `all = true`: its pair is new).
  Refusals, all before any model call: a side not `completed`; the pair invalid
  (`loadPair`/`orderPair` from `commands/compare.ts`); unknown judge id or empty list; and, for
  the judges that will actually be called: unresolved model, key variable unset, a run without
  `diff.patch` or `transcript.jsonl`, any oversize item across the union of their contexts.
  Merge semantics: the pair's existing `judge.json` is found by run ids; a configured judge
  whose verdict carries the current `rubricHash` is kept (no call), one whose hash differs or
  is missing (an older file) is judged, `--all` judges every configured judge; verdicts for
  judges no longer configured ride along untouched, after the configured ones. `VerdictRecord`
  has `rubricHash`; `JudgeRecord.schema` stays 1. Atomic write: the new directory is assembled
  as `<dir>.tmp` (kept verdicts' `prompt.txt`/`response.json` copied across), then the old dir
  is renamed to `<dir>.old`, `.tmp` renamed over, `.old` removed; a `VerdictError` mid-judge
  leaves the old directory untouched and names `<dir>.tmp/<judge>/` as where the reply is. A
  leftover `.tmp` is removed at the start of the next judging. `judgePair` returns `{record,
  judged, kept}`; `judge` prints `formatJudging` (header, then per configured judge the
  verdict line or `kept (rubric unchanged)`) followed by `formatComparison`, `--json` prints
  the `Comparison`. `JudgeRecord` (`schema: 1`) lives here, like `Comparison` lives in
  `compare.ts`. `deps.judgeFor(target)` is the seam tests use to hand in `ai/test`'s
  `MockLanguageModelV4`; `cli.ts` passes nothing. `judgeBatch(options, deps)` is the batch
  entry point: `loadBatch`, then `judgePair` on every complete pair at once
  (`Promise.allSettled`; judges within a pair stay sequential), then `compareBatchRecords` and
  `formatBatch` with each fixture's `JudgePairResult`; a pair a judge refuses keeps its table
  and gets `error: judging skipped: <why>`, a pair with a missing side is listed with the
  reason; when no pair was judged at all the command refuses with every reason, exit 1.
  `cli.ts` picks `judge`/`compare` (two ids or `--fixture`) or `judgeBatch`/`compareBatch`
  (nothing or `--stamp`); mixing the three ways of addressing is a usage error.
- `env.ts` — `loadEnvFile(root, env = process.env): string[]`: `.harnessbench/.env` via
  `util.parseEnv`, set-if-unset, returns the names it set (tests only). Missing file → `[]`;
  unreadable or malformed → `CliError` naming the file and a line number, never a value.
  `parseEnv` itself never throws, so `malformedLine` finds the first line that is not an
  entry, comment, blank or the tail of a multi-line quoted value.
- `errors.ts` — `CliError`, the shared vocabulary at the bottom of the graph.

Imports form a DAG, checked by eye: `detect/*` imports nothing internal but `detect/types.ts`;
`plan.ts` and `errors.ts` import nothing; every arrow points down. `compare.ts` imports the
value formatters (`formatCount`, `formatDuration`, `formatUsd`) from `print.ts` because a `Row`
carries display strings; `print.ts` takes only the `Comparison` type back, which is erased, so
that edge does not count. No barrel `index.ts` files —
the explicit paths are what make the layering legible. `agents/index.ts` is the one exception,
and is not a barrel: it is the registry that turns a config's `agent.name` into an adapter, and
the only file that knows which adapters exist.

One exception to "plan.ts is the only writer": a run's own directory (`.harnessbench/runs/<id>/`)
is written directly by `commands/run.ts`, the adapter (`raw.jsonl`, `agent.stderr.log`) and
`run-record.ts`, because its files are streamed while the agent runs and there is nothing to
dry-run or plan; `commands/judge.ts` writes the `-judge` directory the same way. Everything
under `.harnessbench/runs/` is gitignored output, not state.

What the split buys: `--dry-run` and idempotence are free because one function writes; detectors
are testable with a temp dir and no mocks; every error message is in one file, so they are
consistently actionable.

Split triggers (do not pre-empt them; the `print/` one has fired on paper with `compare` as
the third command, and is deferred until `print.ts` actually hurts):
- `runtime/` — this one fired, as `agents/`: the agent runner is a folder because it has an
  interface (`types.ts`), a registry (`index.ts`) and one file per agent. The harness overlay
  turned out to be two methods on `Workspace`, not a sibling. `judge/` fired the same way: three
  files (context, provider, judge) with the provider packages confined to one of them.
- `print/init.ts` + `print/run.ts` + `print/format.ts` when a third command formats output. The
  data shape `Report` moves to the file that produces it (`RunRecord` already lives in
  `run-record.ts`); `print.ts` keeps the
  presentation.
- `validate.ts` on the third hand-rolled JSON validator (`config.ts` and `fixtures.ts` each carry
  their own `describe`/`fail` today; two is not yet duplication worth an abstraction).

Avoid: feature folders (`init/`, `run/` each with their own detect+print) — they kill the
single-writer and single-formatter invariants; a `types.ts` dumping ground.

Tests: `node:test`, colocated as `x.test.ts` beside `x.ts`; `npm test` → `node --test
'dist/**/*.test.js'`, so the suite exercises the built artifact. Excluded from the package.
Data a test needs on disk lives in `test/fixtures/` (recorded agent streams, fake agent shell
scripts), reached from `dist/` via `import.meta.url`. Not to be confused with the top-level
`fixtures/`, which is the benchmark tasks the package ships. **No test ever runs a real agent**:
a fake shell script stands in, so the suite is free, offline and deterministic.

## Done

- Package skeleton: `npx harnessbench` works, shebang preserved, `files: [dist, fixtures]`.
- `init`: detects git root and base branch (`origin/HEAD` → main → master), harness files
  (conventions + followed `@imports` and markdown links), test command (npm/pytest/go/cargo/
  make/phpunit/gradle/mvn; ignores npm's placeholder), agent CLIs on PATH. Writes
  `.harnessbench/config.json`, copies built-in fixtures, appends `.harnessbench/runs/` and
  `.harnessbench/.env` to `.gitignore` (one `appendLines` op, so a repo initialised before
  the second line existed gets it on the next init), writes `.harnessbench/.env.example` once
  (from the effective config's adapter `credentialEnv` + `CLAUDE_CODE_OAUTH_TOKEN` + the
  judge's `judgeKeyEnv`, each with a one-line note from a table in `commands/init.ts`), and
  prints `credentials: .harnessbench/.env (gitignored; see .env.example)`. Idempotent.
  `--dry-run`, `--json`, `--base`, `--test`, `--agent`.
- Built-in fixtures: `announcements` (new table, write/read, tests), `holiday-api-client`
  (HTTP client to fictional `api.holidaze.example` with mocked tests, retries, typed errors),
  `ttl-cache` (TTL+LRU cache applied to one expensive read).
- README with pitch, how it works, principles, honest status.
- `workspace.ts`: shallow clone of the host at a ref into `$TMPDIR/harnessbench/<runId>`, origin
  removed, hooks disabled, empty HOME; `exec` in its own process group (killed as a group on
  timeout, output streamed, prompt on stdin), `diff`, `destroy`, `withWorkspace`. ~100 ms to
  create on this repo.
- `agents/`: the adapter contract, the registry, and the Claude Code adapter — `claude -p
  --output-format stream-json --verbose --permission-mode bypassPermissions`, prompt on stdin,
  cwd = tree, `CLAUDE_CONFIG_DIR` inside the workspace, timeout from `agent.timeoutMinutes`.
  Raw stdout is streamed to disk and parsed line by line as it arrives (`StreamParser`), so a
  long run is never held in memory; tool inputs and outputs are capped at 2000 chars per event.
  Unknown event types and unparsable lines are skipped — the format grows between releases and
  that is not a reason to fail a run.
- Config `agent` block (`name`, `command`, `model`, `maxTurns`, `timeoutMinutes`, `args`, `env`)
  replaced the top-level `agent` string and `timeoutMinutes`. `init` writes it in full, nulls
  and empty arrays present, and refuses an unknown `--agent` rather than writing a config that
  cannot run. Preflight resolves the command on PATH and checks credentials.

- `run <fixture-id>` end to end (2026-09-19): preflight → workspace at HEAD → adapter with the
  fixture's prompt → `diff.patch` → test command in the workspace (10 min cap, output to
  `test.log`) → `transcript.jsonl` + `run.json` → summary (`formatRun`). Run id is
  `<YYYYMMDD-HHMMSS UTC>-<fixture>-candidate`; the environment is fixed to `candidate` until the
  overlay exists, and the name already carries it. The run dir is created before the agent
  starts so a crash still leaves `raw.jsonl`. Exit codes: 0 completed, 2 timeout, 3 agent
  error, 4 max_turns, 1 preflight; a failing test suite is a result, not an exit code. Flags `--keep`,
  `--json`, `--max-turns`, `--model`. The adapter contract gained `stderrPath` (agent stderr
  streamed whole to `agent.stderr.log`; the summary shows its last 5 lines on an error).
  `agent.command` may now be a path, taken as it is; only a bare name is looked up on PATH.
  Run ids have one-second resolution: `createWorkspace` refuses an existing directory with a
  message that names `--keep` as the likely cause, rather than cloning into it.
  Not yet done: one real run with a real key (`npx . run ttl-cache --max-turns 20 --keep`) and
  reading its `run.json`, `diff.patch`, `transcript.jsonl` by hand.

- Both environments (2026-09-20). `run <fixture>` now runs `previous` then `candidate`
  (sequentially at the time; both at once since 2026-09-22, see below), each in its own
  workspace and run directory; the two ids share one timestamp
  and differ only in the suffix. `previous` = the harness as committed at
  `git merge-base <base> HEAD`, on HEAD's code; no merge base (orphan branch, shallow host) is
  a preflight error naming `--base` and `git fetch --unshallow`.
  - `detect/harness.ts` reads through a `FileSource` (`list()`/`read()`): the working-tree
    walk, or `gitSource(root, ref)` on `git ls-tree -r -z` + `git show ref:path`. Both count
    only regular files (a symlinked `CLAUDE.md` is not harness on either side) and skip
    `.harnessbench/`, `.git/`, `node_modules/`. `harnessSnapshot(root, ref, extraPaths)` gives
    `{ref, sha, files, hash}`; hash = sha256 over `path\0contents\0` in sorted order, so equal
    hashes mean byte-identical harnesses. `extraPaths` may be files or directories; missing
    ones are skipped.
  - `Workspace.overlayHarness(repoRoot, head, previous)` deletes every HEAD harness path from
    the tree (pruning emptied directories), then writes each previous file from the host with
    `git show <sha>:<path>` plus the mode from one `git ls-tree`. The clone is depth 1, so the
    host is the only source; nothing is written to it. `rebaseline()` then `git add -A` +
    `commit --amend` in the tree: one commit, clean status, tree sha ≠ `headSha` on the
    previous side, by design.
  - `run.json` is `schema: 2`: `environment` is `"previous" | "candidate"` and `harness` is the
    snapshot that ran. `--json` prints an array of both records. Exit code is the worse of the
    two sides. When both hashes match, `run` warns on stderr that the delta is noise, and still
    runs both.
  - Not built: a flag to run one side only (cheap to add when the judge/compare story needs
    it; today `run` always pays for both), and reusing an earlier `previous` run with the same
    hash instead of re-running it.

- `setupCommand` (2026-09-20). Every real run had spent its first turns on `tsc: command not
  found` and `npm install`: tool noise in exactly the rows compare reports. Config gained
  `setupCommand: string` (`""` = none). `detect/setup-command.ts` claims a command only from a
  lockfile, never a manifest alone (a non-frozen install rewrites the lockfile and pollutes the
  diff): package-lock → `npm ci`, pnpm-lock → `pnpm install --frozen-lockfile`, yarn.lock →
  `yarn install --frozen-lockfile`, bun.lock(b) → `bun install --frozen-lockfile`, go.sum → `go
  mod download`, Gemfile.lock → `bundle install`, composer.lock → `composer install`,
  poetry.lock → `poetry install`, requirements.txt (no poetry.lock) → `pip install -r
  requirements.txt`; Cargo/Gradle/Maven fetch during the build, no entry; several lockfiles
  join with ` && ` in that order. `init` writes it, `--setup` overrides, the summary has a
  `Setup command` line. In `runSide` it runs after the overlay and before the agent, through
  `ws.exec` with the test command's environment and 10-minute cap, output to `setup.log`;
  `startedAt`, `durationMs` and the phases measure the agent only. `run.json` has `setup:
  CommandResult | null`; schema stays 2 (older records simply lack the key; compare does not
  read it). A non-zero exit or timeout is a `CliError` (exit 1) naming the side, command, exit
  code and log path, thrown before the agent starts: no `run.json` for that side, `setup.log`
  kept; if `previous` already ran, the message says where its record is. `formatRun` prints
  `Setup      npm ci → ok in 24s` only when configured. Not built: caching installs between
  runs; rebaselining after setup (whatever setup leaves un-ignored in the tree shows in the
  diff, so keep installs frozen and their output gitignored). `test/fixtures/fake-claude.sh`
  now dumps a `files:` line listing its cwd, so tests can see what setup left for the agent.

- `compare` (2026-09-20). `harnessbench compare [<previous-id> <candidate-id>] [--fixture <id>]
  [--json] [--markdown]` prints the per-criterion delta table for one previous/candidate pair;
  `run` prints the same table after its two summaries (and appends the `Comparison` as a
  third element of `--json`). Rows, in order: outcome, tests, diff.files, diff.lines, turns,
  toolCalls.main, toolCalls.sub, toolFailures, subAgents, readsBeforeFirstEdit,
  duplicateReads, tokens.mainCacheRead, phases.exploringMs, tokens.total, tokens.output,
  costUsd, durationMs (the telemetry rows were added 2026-09-20, replacing a single
  toolCalls row that mixed sub-agent calls into one side's count). Lower is better for
  every numeric row; counts show a signed delta, quantities a percentage. Warnings: a side that
  did not complete (effort rows from `turns` down become `n/a`), models differ, harness hashes
  equal, ids from different `run` invocations (still compared). A fixed line above every table
  says one run per side and that sub-threshold deltas are `unchanged`. Refusals name both run
  ids: not one of each environment, different fixtures, different `headSha`, unreadable record.
  Latest-pair selection takes the newest timestamp prefix with both directories present and
  ignores a lone side. Exit 0 always; no gating, no thresholds in config, no `runs` listing.

- Telemetry (2026-09-20). See `telemetry.ts` above. The Claude Code parser fills `thread`
  from `parent_tool_use_id`, `kind` from the tool name (Read; Write/Edit/NotebookEdit;
  Grep/Glob; Bash; Task/Agent; else other), `path` from `file_path` relative to
  `workspace.tree` (outside the tree stays absolute; no tree → as given), and takes the
  last of Claude Code's `result` events (it emits one when main yields to a background
  sub-agent and one at the end). `formatRun` gained `Threads` and `Phases` lines.
  `test/fixtures/claude-stream-subagent.jsonl` is the fake stream with a sub-agent, per-
  message usage and two results. Schema stays 2. Not built: classifying shell commands.
  Turn counting was fixed on 2026-09-22 (see `telemetry.ts` above): events split from one
  message share a `turn`; their usage is still summed per event, as the stream reports it.

- `max_turns` outcome (2026-09-20). `RunOutcome` (`run-record.ts`, imported by
  `AgentResult`) is `completed | max_turns | timeout | error`. A run that hits the turn cap
  is not a crash: `compare` must tell budget from breakage, and a judge must never be handed
  a cut-off run as finished (three of the first six real runs were cut-offs). The Claude Code
  parser records the result event's `subtype` as `resultSubtype` (null without a result);
  the adapter maps, in order: timed out → `timeout`; subtype `error_max_turns` →
  `max_turns`; non-zero exit or `is_error` → `error`; else `completed`. The subtype check
  comes first because Claude Code exits non-zero on `error_max_turns`. Only `agents/` knows
  that string. For `max_turns`, `finalMessage` and the parser's `error` event both read
  `cut off by the turn limit after N turns`; the agent's trailing half-sentence stays in the
  transcript only. Exit code 4. The summary reads `max_turns after 8m24s`; the stderr tail
  is still shown only for `error`. `compare` warns `<side> hit the turn limit (41 turns);
  its effort rows are not comparable` and keeps the `n/a` effort rows; the outcome row's
  classification is unchanged (completed is best). Old records with the three earlier
  outcomes still read; schema stays 2. `test/fixtures/max-turns-claude.sh` is the fake.

- Judges (2026-09-21). `harnessbench judge [<previous-id> <candidate-id> | --fixture <id>]
  [--json]` and `run --judge`. Pair selection is `compare`'s (`loadPair`, now exported;
  `latestPair` never matched `-judge` directories, and a test now says so). Three drafts ship,
  each `prompt.md` opening with an HTML comment saying it is a draft: `code-quality` (context
  `prompt, diff`), `engineering-practices` (`prompt, diff, toolLog`), `test-quality` (`prompt,
  diff, tests`). Output is one line per verdict, `Code quality  candidate preferred  <reason>`,
  under a header naming the pair and the A/B mapping; `--json` prints `judge.json`. `run
  --judge` prints the verdicts after the comparison, appends the record to `--json`, and on a
  refusal prints one `judging skipped: <why>` line on stderr and keeps the run's exit code; it
  does not preflight the judge before the agents run, so an unset model is found out only
  after both sides ran (spec'd that way; cheap to add if it bites). Usage per verdict is
  summed over attempts. Not built: position swap, per-judge concurrency, a real call to a real
  provider. (The separate verdict block and `formatVerdicts` were replaced by judge rows in
  the table on 2026-09-22, below.)

- `.harnessbench/.env` (2026-09-22). See the credentials decision above and `env.ts`. Credential
  errors in `preflight.ts` now end "set X in your environment or in .harnessbench/.env".
  `engines.node` is `>=20.12`. `plan.ts`'s `appendLine` became `appendLines` so one
  `.gitignore` op manages both lines and the Files report shows the file once.

- Judge rows and incremental judging (2026-09-22). See `compare.ts`, `commands/compare.ts`,
  `commands/judge.ts` and `judges.ts` above. `formatVerdicts` is gone: `run --judge`, `compare`
  and `judge` all print `formatComparison`; `run --json` prints `[previous, candidate,
  comparison]` and no longer appends the judge record (the rows carry the verdicts). Text
  rendering: after the mechanical rows, a blank line and `judged by <provider> <model>` (or
  `judges: not run` when no verdict exists), then the judge rows in the same columns; an empty
  candidate cell prints no arrow. A judge row's note wraps to 100 columns total, continuation
  lines indented to the note column; the note column is never narrower than 40 (with a
  `candidate preferred` delta the other columns already reach column 80, so in practice the
  lines run to ~120), mechanical notes stay on one line. Markdown: the same rows in the one
  table, the whole reason in the note cell, `Judged by …` / `Judges: not run.` as a sentence
  above the table. `judge --all` flag. The instruction block now says "in at most two
  sentences". `run` loads the judgement even without `--judge`, so the table shows `not
  judged` rows; a config whose judges cannot be loaded costs the rows (`judge rows skipped:` on
  stderr), not the run. Not built: roll-ups across judges, gating, position swap (the roll-up
  across fixtures came on 2026-09-22, below).

- Concurrent sides and clean interruption (2026-09-22). `run` starts both `runSide` calls
  and awaits `Promise.allSettled`; records stay in `ENVIRONMENTS` order (`previous`,
  `candidate`) whatever finished first, so wall clock is the slower side, not the sum.
  `runSide` itself is unchanged apart from a `progress(event)` callback in its `Side`.
  Failure semantics: one side's `CliError` never cancels the other; the error is the failed
  side's message plus "the <env> side ran and its record is at ..." for the completed one;
  both failing joins both messages with the larger exit code; a non-`CliError` is rethrown.
  Progress: nothing on stdout until both sides are done; one line per event on stderr
  (`[mm:ss] <env>  started | setup ok/failed | agent <outcome> (N turns) | tests
  passed/failed/not configured | recorded <run dir>`), `formatProgress` in `print.ts`,
  `ProgressEvent` union in `commands/run.ts`, one clock from the `run` invocation. `--json`
  keeps stdout pure JSON. Interruption: the agents run detached, so the terminal's Ctrl-C
  never reaches them; `cli.ts` installs one SIGINT/SIGTERM handler for `run` only, which
  writes `harnessbench: interrupted, stopping N run(s)`, calls `workspace.abortAll({ keep })`,
  lists kept paths with `--keep`, and `process.exit(130)`; a second signal is ignored. An
  interrupted run leaves its run directories with whatever was written (`raw.jsonl`,
  `setup.log`) and no `run.json`; nothing else on the host is cleaned up, and the existing
  "unreadable" handling covers it downstream. Tests never `pgrep`: the fakes write pids and
  marks to `FAKE_CLAUDE_MARKS`, named by run id; `fake-claude.sh` writes its dump atomically
  (`mv`) because both sides now share the path at the same time. Not built: baseline reuse
  (several fixtures per invocation and `--concurrency` came the same day, below).

- Fixture sets (2026-09-22). `run [<fixture-id>...] [--tag <tag>]... [--concurrency <n>]`
  runs a batch under one stamp (see the "batch is a stamp" decision above). Selection is
  `selectFixtures` in `fixtures.ts`; bare `run` is every fixture. Preflight happens once, then
  stderr gets `running N fixture(s) × 2 sides = M runs: <ids>` (`formatBatchPlan`) before any
  side starts. Every side of every fixture goes through one `limiter(max)` (a plain FIFO queue in
  `commands/run.ts`; unlimited without `--concurrency`), fixtures in listing order, previous
  before candidate, so `--concurrency 1` serialises in that order. `runSide` is unchanged;
  progress lines gained a fixture column (`formatProgress(elapsed, fixture, fixtureWidth, env,
  event)`, width = the longest id in the batch). Per fixture, `Promise.allSettled` over its two
  sides → `settledSides(fixture, settled)` → a `FixtureOutcome` (`sides`, `failures` as
  `CliError`s whose messages are prefixed `<fixture>: ` and still say where a surviving record
  is, `comparison`, `error`); with both sides in, `--judge` calls `judgePair` right away (a
  refusal is `<fixture>: judging skipped: …` on stderr, once per fixture), then `loadJudgement`
  (a config whose judges cannot load costs the rows, said once per distinct message) and
  `compare`. Fixtures are independent: one side's failure never stops another fixture. Output,
  in listing order, after everything finished: one fixture → exactly the old text (summaries then
  table); several → `formatBatch`: `formatRollup` (`harnessbench rollup  N fixtures · code
  <sha>`, `ROLLUP_LINE`, `warning:` lines, then `Label  word N [ids]   word N [ids]`; judge rows
  say `candidate` / `previous` / `tie`, mechanical `improved` / `regressed` / `unchanged`, `n/a`
  only when non-zero) then `── <fixture> ──` sections; a failed fixture shows the surviving
  side's summary and `error: …` in place of a table. `--json` always prints `RunBatchResult =
  {stamp, fixtures: [{fixture, records, comparison | null, error | null}], rollup}` (decided:
  one JSON shape whatever the count, so the old `[previous, candidate, comparison]` array is
  gone). After printing, any rejected side throws one `CliError` listing every failed fixture
  and side, exit code the largest; otherwise `cli.ts` exits with the worst agent outcome over
  every record in the batch. `run()` returns the `RunBatchResult`. Markdown for a batch
  (`formatBatchMarkdown`, `compare --markdown` over a batch): the roll-up as a table with
  fixture names in the cells, then each fixture's table inside `<details><summary><fixture>
  </summary>` with blank lines so GitHub renders it. Tests: `test/fixtures/concurrent-claude.sh`
  now names its marks by run id (`<run-id>.started/.finished`) so six sides of a batch each
  leave their own; the setup-failure-in-one-fixture tests use a `setupCommand` that inspects
  `$(pwd)`, which ends in `<run-id>/tree`. Not built: baseline reuse, gating, per-fixture agent
  settings, `run` telling apart a stamp collision (one-second resolution, as before).

## Next

0. A real batch (`npx . run --judge --keep`) on this repo, three fixtures; read the roll-up and
   check the wall clock and the progress lines are legible with six sides interleaved.
1. Test `init --dry-run` on a real repo with a real `CLAUDE.md`; check the harness list,
   test command and base branch are right. Fix what's wrong.
2. Real-agent smoke of `run` (see above); fix what the real stream shows that the recording
   did not. Then `judge` on that pair with a real model: read `prompt.txt` and the verdicts by
   hand; revise the three draft rubrics from what the model actually did with them.
3. Position swap as an opt-in second judge call.
4. GitHub Action that comments `compare --markdown` on PRs touching harness files.
   Cache `previous` by harness hash so a PR pays only for the candidate side.
5. More agent adapters (Codex, Aider, Gemini CLI, OpenCode, Pi): implement `AgentAdapter` and
   register it in `agents/index.ts`. Note `detect/agents.ts` knows more binaries than we have
   adapters for — it reports what is on PATH; only a binary with an adapter is offered.

## Working style

Ruslan builds; Claude reviews, designs, and writes prompts for the coding agent. Discuss the
contract before scripting it. Keep answers short. Do not add fields, layers or features that
no current command needs.
