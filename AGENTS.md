# harnessbench

Regression tests for an AI coding harness (`CLAUDE.md`, `.claude/`, `AGENTS.md`, ...). Run fixed
engineering tasks against the same code with the old and new harness, report the deltas.
`MEMORY.md` holds the settled decisions, the layering rules and what is done and next; read it
before changing anything, and update it when a decision changes.

## Working here

Single npm package, TypeScript, ESM, Node 20+, no runtime dependencies. Build with `npm run
build`; `npm test` builds first and runs `node --test` against `dist/`. Do not claim something
works until both pass. Hand-written argv parsing in `src/cli.ts`; do not add a CLI library.

Each file in `src/` has one relationship to the outside world. `detect/` asks questions and
never throws or writes. `preflight.ts` turns a missing answer into a `CliError` carrying the fix.
`plan.ts` builds `FileOp[]` and is the only writer of host files. `print.ts` is the only
formatter. `agents/` drives one external agent behind `AgentAdapter`. `commands/` composes these
in order. `cli.ts` owns argv and exit codes, nothing else. Domain nouns (`config.ts`,
`fixtures.ts`, `workspace.ts`, `run-record.ts`) get their own top-level file. Imports form a DAG
pointing down; import by explicit path, never through a barrel.

## Do

- Write the failing test first, then the code. Tests are `node:test` with `node:assert/strict`,
  colocated as `x.test.ts`, named as a sentence about behaviour ("an agent that hangs is a
  timeout, and leaves nothing behind").
- Drive commands through the real CLI in a temp git repository. Stand a shell script from
  `test/fixtures/` in for the agent; never run a real one in a test.
- Make every error actionable: name the file, key or flag and what to do about it. Reject
  unknown config keys by name rather than ignoring them.
- Return outcomes from adapters (`completed`, `timeout`, `error`); throw only for our own bugs.
- Comment the why, not the what: a one-line `/** */` on each export, an inline comment only where
  a reader would otherwise ask "why this?".
- Keep functions small and named for their role: `requireX`, `formatX`, `x(): Detection<T> | null`.
- Preserve the isolation guarantees: the agent works in a disposable clone with its own `HOME`
  and config directory, and nothing it does can reach the host repository.

## Don't

- Read, store, log or print credentials. Preflight checks that a variable is set; the adapter
  forwards a fixed list; that is all.
- Add a field, flag, layer or abstraction that no current command needs. Split triggers are
  listed in `MEMORY.md`; wait for them.
- Write outside `.harnessbench/` in the host repository, or touch the harness files themselves.
- Add runtime dependencies, feature folders, a `types.ts` dumping ground, or barrel `index.ts`
  files (`agents/index.ts` is a registry, not a barrel).
- Mock what a temp directory, a fake script or a recorded stream can exercise for real.

## Style

Two-space indent, double quotes, semicolons, trailing commas, lines wrapped at about 100
columns. `const` by default; `for ... of` over index loops; `import type` for types; Node
built-ins first, a blank line, then internal imports with `.js` suffixes. `strict` and
`noUncheckedIndexedAccess` are on: narrow explicitly, no non-null assertions. Prefer plain
functions and small literal types over classes, except where state and lifecycle are the point
(`Workspace`, `StreamParser`). Short imperative commit messages.
