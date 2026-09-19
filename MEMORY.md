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
  It returns `timeout`/`error` as outcomes; it throws only for our own bugs. Config names the
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
    runs/                               output of runs, gitignored
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
| `commands/` | compose the above, in order | detect → plan → apply → print |
| `cli.ts` | argv, exit codes | nothing else |

**Domain nouns** — an object that appears in several layers gets its own top-level file:
- `config.ts` — `Config` type (including the `agent` block), defaults, load/validate. Unknown
  keys at any level are an error naming the key: a typo is otherwise a silently ignored setting.
- `fixtures.ts` — locate packaged fixtures via `import.meta.url`, copy into the host.
- `workspace.ts` — a throwaway clone of the host + an isolated HOME, for one run.
- `run-record.ts` — `RunRecord` (`run.json`, `schema: 1`), `writeRunRecord`, `readRunRecord`.
  Later commands (compare, judge) read a run only through `readRunRecord`, which rejects any
  other schema number; that is the one place run-file compatibility lives.
- `errors.ts` — `CliError`, the shared vocabulary at the bottom of the graph.

Imports form a DAG, checked by eye: `detect/*` imports nothing internal but `detect/types.ts`;
`plan.ts` and `errors.ts` import nothing; every arrow points down. No barrel `index.ts` files —
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

Split triggers (do not pre-empt them):
- `runtime/` — this one fired, as `agents/`: the agent runner is a folder because it has an
  interface (`types.ts`), a registry (`index.ts`) and one file per agent. The harness overlay
  and the judge are the next candidates for siblings of `workspace.ts`; give them a folder only
  when each has more than one file.
- `print/init.ts` + `print/run.ts` + `print/format.ts` when a third command formats output. The
  data shapes (`Report`, `RunPlan`) move to the file that produces them; `print.ts` keeps the
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
  error, 1 preflight; a failing test suite is a result, not an exit code. Flags `--keep`,
  `--json`, `--max-turns`, `--model`. The adapter contract gained `stderrPath` (agent stderr
  streamed whole to `agent.stderr.log`; the summary shows its last 5 lines on an error).
  `agent.command` may now be a path, taken as it is; only a bare name is looked up on PATH.
  Run ids have one-second resolution: `createWorkspace` refuses an existing directory with a
  message that names `--keep` as the likely cause, rather than cloning into it.
  Not yet done: one real run with a real key (`npx . run ttl-cache --max-turns 20 --keep`) and
  reading its `run.json`, `diff.patch`, `transcript.jsonl` by hand.

## Next

1. Test `init --dry-run` on a real repo with a real `CLAUDE.md`; check the harness list,
   test command and base branch are right. Fix what's wrong.
2. Real-agent smoke of `run` (see above); fix what the real stream shows that the recording
   did not.
3. Harness overlay: materialise `previous` by writing base-branch versions of harness files
   (deleting ones absent there); hash the resolved harness set and print it.
4. Judge: pairwise, blind, position-swapped, structured output; default rubrics.
5. `compare` + markdown report; GitHub Action that comments on PRs touching harness files.
6. More agent adapters (Codex, Aider, Gemini CLI, OpenCode, Pi): implement `AgentAdapter` and
   register it in `agents/index.ts`. Note `detect/agents.ts` knows more binaries than we have
   adapters for — it reports what is on PATH; only a binary with an adapter is offered.

## Working style

Ruslan builds; Claude reviews, designs, and writes prompts for the coding agent. Discuss the
contract before scripting it. Keep answers short. Do not add fields, layers or features that
no current command needs.
