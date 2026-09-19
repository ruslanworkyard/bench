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
| `commands/` | compose the above, in order | detect → plan → apply → print |
| `cli.ts` | argv, exit codes | nothing else |

**Domain nouns** — an object that appears in several layers gets its own top-level file:
- `config.ts` — `Config` type, defaults, load/validate.
- `fixtures.ts` — locate packaged fixtures via `import.meta.url`, copy into the host.
- `workspace.ts` — a throwaway clone of the host + an isolated HOME, for one run.
- `errors.ts` — `CliError`, the shared vocabulary at the bottom of the graph.

Imports form a DAG, checked by eye: `detect/*` imports nothing internal but `detect/types.ts`;
`plan.ts` and `errors.ts` import nothing; every arrow points down. No barrel `index.ts` files —
the explicit paths are what make the layering legible.

What the split buys: `--dry-run` and idempotence are free because one function writes; detectors
are testable with a temp dir and no mocks; every error message is in one file, so they are
consistently actionable.

Split triggers (do not pre-empt them):
- `runtime/` when `workspace.ts` gets its second sibling (agent runner, harness overlay, judge).
- `print/init.ts` + `print/run.ts` + `print/format.ts` when a third command formats output. The
  data shapes (`Report`, `RunPlan`) move to the file that produces them; `print.ts` keeps the
  presentation.
- `validate.ts` on the third hand-rolled JSON validator (`config.ts` and `fixtures.ts` each carry
  their own `describe`/`fail` today; two is not yet duplication worth an abstraction).

Avoid: feature folders (`init/`, `run/` each with their own detect+print) — they kill the
single-writer and single-formatter invariants; a `types.ts` dumping ground.

Tests: `node:test`, colocated as `x.test.ts` beside `x.ts`; `npm test` → `node --test
'dist/**/*.test.js'`, so the suite exercises the built artifact. Excluded from the package.

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
  timeout, output streamed), `diff`, `destroy`, `withWorkspace`. ~100 ms to create on this repo.

## Next

1. Test `init --dry-run` on a real repo with a real `CLAUDE.md`; check the harness list,
   test command and base branch are right. Fix what's wrong.
2. `run <fixture-id>`: worktree of HEAD → `claude -p --output-format stream-json` with
   `prompt.md` on stdin, isolated HOME, timeout → capture diff → run test command → parse
   tokens/cost/turns/tools → write `.harnessbench/runs/<ts>-<id>/` → print summary.
   No harness overlay yet.
3. Harness overlay: materialise `previous` by writing base-branch versions of harness files
   (deleting ones absent there); hash the resolved harness set and print it.
4. Judge: pairwise, blind, position-swapped, structured output; default rubrics.
5. `compare` + markdown report; GitHub Action that comments on PRs touching harness files.
6. More agent adapters (Codex, Aider, Gemini CLI, OpenCode, Pi).

## Working style

Ruslan builds; Claude reviews, designs, and writes prompts for the coding agent. Discuss the
contract before scripting it. Keep answers short. Do not add fields, layers or features that
no current command needs.
