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
- **Single npm package**, TypeScript, ESM, Node >= 20, no runtime dependencies. Split later along
  interface seams if ever needed. Hand-written argv parsing until it hurts.
- **Bin name == package name** so `npx harnessbench` works.

## File relationship between the tool and a host repo

```
<host repo>/
  CLAUDE.md, .claude/, AGENTS.md, ...   the harness — read, never written
  .harnessbench/
    config.json                         written by init, committed
    fixtures/<id>/                      fixture.json + prompt.md, committed; built-ins are copied here
    runs/<ts>-<fixture>-<env>/          one run, gitignored: run.json, raw.jsonl, transcript.jsonl,
                                        diff.patch, setup.log, test.log, agent.stderr.log
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
| `commands/` | compose the above, in order | init: detect → plan → apply → print; run: preflight → workspace → agent → record → print |
| `cli.ts` | argv, exit codes | nothing else |

**Domain nouns** — an object that appears in several layers gets its own top-level file:
- `config.ts` — `Config` type (`baseBranch`, `testCommand`, `setupCommand`, the `agent` block,
  `harness.extraPaths`), defaults, load/validate. Unknown keys at any level are an error naming
  the key: a typo is otherwise a silently ignored setting. A missing key takes its default, so a
  config written before a key existed keeps loading (`setupCommand` → `""`).
- `fixtures.ts` — locate packaged fixtures via `import.meta.url`, copy into the host.
- `workspace.ts` — a throwaway clone of the host + an isolated HOME, for one run; also the
  harness overlay (`overlayHarness`) and `rebaseline`, which folds the overlay into the clone's
  single commit so the agent sees a plain checkout and `diff()` measures only the agent's work.
- `run-record.ts` — `RunRecord` (`run.json`, `schema: 2`), `Environment`, `CommandResult`
  (the shape of both `setup` and `tests`: command, exitCode, durationMs, timedOut),
  `writeRunRecord`, `readRunRecord`.
  Later commands (compare, judge) read a run only through `readRunRecord`, which rejects any
  other schema number; that is the one place run-file compatibility lives.
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
  event per assistant message, even one with no text, so its usage and the turn count are
  never lost. `RunRecord.telemetry` is optional only because older `run.json` files lack it;
  `run` always writes it; `compare` shows those rows as `n/a`, "recorded by an earlier
  version". Sub-agent tokens are part of the run's totals, reported per thread, never
  subtracted.
- `compare.ts` — `compare(previous, candidate): Comparison`, pure: one `Row` per criterion
  (`id`, `label`, display strings, `delta`, `classification`, optional `note`) plus `warnings`.
  The noise thresholds are one table in this file (relative 0.15, 0.20 for diff and the
  read counts; absolute floors turns 3, tool calls 3, toolFailures 1, files 1, lines 20,
  readsBeforeFirstEdit 3, duplicateReads 2); a delta must clear both. `subAgents` is
  `neutral`: always `unchanged`, delta shown, note lists `<tool> on <model>` per side.
  No composite, no verdict. `commands/compare.ts` loads a pair (two ids, or the latest
  invocation for `--fixture`), orders it by environment, refuses mismatches, prints.
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
dry-run or plan. Everything under `.harnessbench/runs/` is gitignored output, not state.

What the split buys: `--dry-run` and idempotence are free because one function writes; detectors
are testable with a temp dir and no mocks; every error message is in one file, so they are
consistently actionable.

Split triggers (do not pre-empt them; the `print/` one has fired on paper with `compare` as
the third command, and is deferred until `print.ts` actually hurts):
- `runtime/` — this one fired, as `agents/`: the agent runner is a folder because it has an
  interface (`types.ts`), a registry (`index.ts`) and one file per agent. The harness overlay
  turned out to be two methods on `Workspace`, not a sibling. The judge is the next candidate;
  give it a folder only when it has more than one file.
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
  `.harnessbench/config.json`, copies built-in fixtures, appends `.harnessbench/runs/` to
  `.gitignore`. Idempotent. `--dry-run`, `--json`, `--base`, `--test`, `--agent`.
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

- Both environments (2026-09-20). `run <fixture>` now runs `previous` then `candidate`,
  sequentially, each in its own workspace and run directory; the two ids share one timestamp
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
  message usage and two results. Schema stays 2. Not built: classifying shell commands,
  deduplicating an assistant message the stream splits across
  several `assistant` events (each counts as a turn and carries the same usage, as today).

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

## Next

1. Test `init --dry-run` on a real repo with a real `CLAUDE.md`; check the harness list,
   test command and base branch are right. Fix what's wrong.
2. Real-agent smoke of `run` (see above); fix what the real stream shows that the recording
   did not.
3. Judge: pairwise, blind, position-swapped, structured output; default rubrics.
4. GitHub Action that comments `compare --markdown` on PRs touching harness files.
   Cache `previous` by harness hash so a PR pays only for the candidate side. Then the
   judge's rows join the same table the telemetry rows already sit in.
5. More agent adapters (Codex, Aider, Gemini CLI, OpenCode, Pi): implement `AgentAdapter` and
   register it in `agents/index.ts`. Note `detect/agents.ts` knows more binaries than we have
   adapters for — it reports what is on PATH; only a binary with an adapter is offered.

## Working style

Ruslan builds; Claude reviews, designs, and writes prompts for the coding agent. Discuss the
contract before scripting it. Keep answers short. Do not add fields, layers or features that
no current command needs.
