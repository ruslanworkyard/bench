# harnessbench

**Regression tests for your `CLAUDE.md`.**

You changed a line in `CLAUDE.md`, added a skill, or rewrote `AGENTS.md`. Did your coding agent
get better or worse? harnessbench runs the same engineering tasks twice on the same code — once
with the old harness, once with the new one — and reports the difference.

```
harnessbench compare  ttl-cache · code 0655c52

Outcome                  completed  → completed                       unchanged
Tests                    failed     → passed                          improved
Lines changed            412        → 219        -47%                 improved
Turns                    31         → 23         -8                   improved
Reads before first edit  14         → 6          -8                   improved
Cost                     $0.51      → $0.38      -25%                 improved

judged by anthropic claude-sonnet-4-5
Code quality                                     candidate preferred  improved   B keeps the existing
                                                                                 error type in read.ts;
                                                                                 A introduces a second one.
```

*Illustrative output. The project is early; see [Status](#status).*

## Why

A harness — `CLAUDE.md`, `AGENTS.md`, skills, MCP config, hooks — is build configuration. A
change to it affects every task the agent performs across the whole codebase. We test compiler
flags; harness changes deserve the same.

## Setup

Requires Node.js 20.12+ and a git repository.

```sh
npx harnessbench init
```

`init` detects your harness files, test command, setup command, base branch and installed
agents; writes `.harnessbench/config.json`; copies the starter fixtures and judges into
`.harnessbench/`; gitignores `.harnessbench/runs/` and `.harnessbench/.env`; and writes a
commented `.harnessbench/.env.example`. It is idempotent. Use `--dry-run` to see what it would
do first.

### Configure

`.harnessbench/config.json` is meant to be edited by hand:

```json
{
  "baseBranch": "main",
  "testCommand": "npm test",
  "setupCommand": "npm ci",
  "agent": {
    "name": "claude-code",
    "command": "claude",
    "model": null,
    "maxTurns": null,
    "timeoutMinutes": 20,
    "args": [],
    "env": []
  },
  "harness": { "extraPaths": [] },
  "judge": {
    "provider": "anthropic",
    "model": "",
    "apiKeyEnv": "",
    "baseUrl": "",
    "structuredOutputs": true,
    "maxContextKb": 512
  },
  "judges": ["code-quality", "engineering-practices", "test-quality"]
}
```

- `setupCommand` runs in each workspace before the agent starts. Keep it frozen (`npm ci`, not
  `npm install`): anything it changes that git does not ignore counts as the agent's diff.
  `""` means none.
- `agent.name` picks the adapter; `command` is the binary (a name on `PATH` or a path).
- `judge.model` is written empty on purpose — pick your own; judging refuses until you do.
- `harness.extraPaths` adds files or directories that are part of your harness but not
  detected automatically.
- An unknown key is an error naming it, so a typo is never a silently ignored setting.

### Credentials

Never stored in the config. Put them in your shell, or in `.harnessbench/.env` (gitignored by
`init`, one `KEY=value` per line):

```
ANTHROPIC_API_KEY=sk-ant-...
```

The agent's variables (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, the Bedrock/Vertex
settings) and the judge's key are read from there when your shell has not already set them.
Values are never logged or printed. The agent runs in a disposable clone with its own `HOME`,
so your `~/.claude` is neither read nor written.

## Fixtures

A fixture is a realistic engineering task: a `fixture.json` and a `prompt.md` in
`.harnessbench/fixtures/<id>/`. Nothing else — no pinned commit, no acceptance tests. The agent
sees your repository and the prompt.

```json
{
  "id": "ttl-cache",
  "kind": "feature",
  "description": "In-process TTL cache with size limit, applied to one existing expensive read",
  "tags": ["performance"]
}
```

`prompt.md` is the task, written as you would write a ticket. Good fixtures are work that could
plausibly be done in any codebase but that no codebase already has, so both sides start level.
Three ship with the tool: `announcements`, `holiday-api-client`, `ttl-cache`.

## Judges

The mechanical rows say what each side cost and whether the tests pass. They cannot say whether
the code is better. A judge reads both sides blind — `previous` as A, `candidate` as B — and
says which it prefers on one criterion, with a reason.

Judges are a catalogue like fixtures: `.harnessbench/judges/<id>/judge.json` plus its rubric.

```json
{
  "id": "error-handling",
  "title": "Error handling",
  "description": "Whether failures are handled the way this codebase handles them",
  "prompt": "prompt.md",
  "context": ["prompt", "diff"]
}
```

`context` declares what the judge may look at, from a fixed menu: `prompt`, `diff`, `tests` (the
result only, never the log), `finalMessage`, `toolLog`, `transcript`. `prompt.md` is the rubric;
a fixed instruction block is appended to it telling the model to judge only on that criterion,
to answer `tie` unless the evidence shows a real difference, and to name what decided it. Add
the id to `judges` in the config to run it; a `judge.json` may override `provider`, `model` and
`apiKeyEnv` for itself.

Three drafts ship: `code-quality`, `engineering-practices`, `test-quality`. Edit them to fit
your codebase — each one says in its first line that it is a draft.

## Running

```sh
npx harnessbench run                                  # every fixture
npx harnessbench run ttl-cache                        # one fixture
npx harnessbench run --tag performance                # fixtures carrying a tag
npx harnessbench run --judge                          # and judge each pair as it finishes
```

For each fixture, `run` drives the agent twice on the current `HEAD`: as `previous`, with the
harness as committed at the merge base with your base branch, and as `candidate`, with the
harness at `HEAD`. Every side runs in its own disposable clone, at the same time; `--concurrency
<n>` caps how many are in flight. Progress goes to stderr; the tables are printed at the end.

Everything lands in `.harnessbench/runs/<stamp>-<fixture>-<environment>/`: `run.json`,
`diff.patch`, `transcript.jsonl`, `setup.log`, `test.log` and the agent's raw output. The
`stamp` (`YYYYMMDD-HHMMSS`) is shared by every run of one invocation.

Useful flags: `--keep` (leave the workspaces on disk), `--max-turns`, `--model`, `--json`.
Exit codes report the agent, not your tests: 0 completed, 2 timeout, 3 error, 4 turn limit,
1 anything else, 130 interrupted. A failing test suite is a result, not an error.

### Reading the results again

```sh
npx harnessbench compare                                       # latest batch
npx harnessbench compare --fixture ttl-cache                   # latest pair of one fixture
npx harnessbench compare --stamp 20260922-101500               # a specific batch
npx harnessbench compare <previous-run-id> <candidate-run-id>  # any pair
npx harnessbench judge --fixture ttl-cache                      # judge (or re-judge) a pair
```

One row per criterion; lower is better for every count. A delta counts as `improved` or
`regressed` only when it clears both a relative threshold and a small absolute floor —
everything else reads `unchanged`, because one run per side is not a distribution. With several
fixtures the output opens with a roll-up naming which fixtures moved on each criterion; there is
no composite score.

`compare` never calls a model, only reads what `judge` wrote, and always exits 0: it reports, it
does not gate. `judge` is incremental — a verdict whose rubric has not changed is kept without a
model call; `--all` re-judges everything. `--markdown` prints the tables as GitHub-flavoured
markdown, ready to paste into a PR.

## CI

*Not written yet.*

- **GitHub Actions** — TODO
- **Bitbucket Pipelines** — TODO

## Status

Early. `init`, `run`, `compare` and `judge` work; three fixtures and three draft judges ship;
the Claude Code adapter is written and tested. Next: a position-swapped second judge call,
CI integration, and more agent adapters.

If you have the same problem, open an issue and describe how you'd want to test your harness.
Fixture design is where real examples help most.

## License

MIT
