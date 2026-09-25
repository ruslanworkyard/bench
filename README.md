# harnessbench

**Regression tests for your `CLAUDE.md`.**

You changed a line in `CLAUDE.md`, added a skill, or rewrote `AGENTS.md`. Did your coding agent
get better or worse? harnessbench runs the same engineering tasks twice on the same code — once
with the old harness, once with the new one — and reports the difference.

```
harnessbench compare  ttl-cache · code 0655c52

Outcome                  completed  → completed                       unchanged
Agent's tests            failed     → passed                          improved
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
  "testFiles": [],
  "testLabel": "Agent's tests",
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

### The test command

After each side's agent finishes, harnessbench runs the tests **the agent wrote**, against the
code it wrote — not your whole suite. Fixtures are tasks in the spirit of your repo, not real
features, so "did the change break the system" is not the question; "do the agent's own tests
pass" is. It also keeps a side to seconds instead of a 15-minute suite.

- `testFiles`: globs, relative to the repo root (`**` spans directories), that say which files
  are tests. Of the files the agent added or modified (deleted ones never count), those matching
  any glob are the agent's tests.
- `testCommand` may contain `{files}` — those files, shell-quoted, sorted — and/or `{dirs}` —
  their directories, each `./`-prefixed. The list is also in `HB_TEST_FILES`, one per line,
  for mappings too awkward inline. A command with neither placeholder runs as written: the
  whole suite, as before.
- `testLabel` names the row (default `Agent's tests`); use `Lint` or `Build` when your check is
  not a test runner.

```jsonc
// pytest
"testFiles": ["**/test_*.py", "**/*_test.py"], "testCommand": "pytest {files}"
// Pest (PHP)
"testFiles": ["tests/**/*Test.php"], "testCommand": "vendor/bin/pest {files}"
// Jest
"testFiles": ["**/*.test.ts", "**/*.test.tsx"], "testCommand": "npx jest {files}"
// TypeScript compiled first, tests run from dist/ (this repo)
"testFiles": ["src/**/*.test.ts"],
"testCommand": "npm run build && node --test $(printf '%s\\n' {files} | sed 's#^src/#dist/#; s#\\.ts$#.js#')"
```

The row reads, per side:

- `passed` / `failed`: the command ran and exited zero / did not (or timed out).
- `none written`: the command has a placeholder and the agent wrote no test file, so nothing ran.
  Worse than `passed`, not ranked against `failed` — the judges say which is worse.
- `not run`: `testCommand` is `""`. For an environment that cannot run tests at all — an iOS app
  on a Linux runner — this is a deliberate gap, and the row says `n/a — not run in this
  environment` instead of pretending to a result.

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
<n>` caps how many are in flight. Progress goes to stderr, one line per event, then
`6 runs finished in 05:12`. The terminal then gets a summary that fits on one screen:

```
harnessbench  2 fixtures · code 9c4c5e2 · previous cca3e7c → candidate 9c4c5e2 · claude-sonnet-5

Outcome     unchanged 2
Efficiency  regressed: Turns 2, Cost 2, Tokens 2, Reads before first edit 1 · improved: Exploring 1
Judges      candidate 5 · previous 1 · tie 0

holiday-api-client  code quality candidate · engineering practices candidate · test quality candidate
list-runs           code quality previous  · engineering practices candidate · test quality candidate

report  .harnessbench/runs/20260924-052122/report.md
```

**Outcome** is the worse of the outcome and tests rows per fixture, **Efficiency** lists every
other mechanical row that moved (how many fixtures), **Judges** counts preferences across all
fixtures and judges. The full report — the roll-up table, then per fixture the comparison table
with the judges' reasons, both sides' figures and final messages, and the run directories — is
written to `.harnessbench/runs/<stamp>/report.md` (GitHub-flavoured markdown, ready for a PR
comment) and `report.json`. `--detail` prints the markdown instead of the summary; `--json`
prints `report.json` exactly, and nothing else on stdout.

Each run lands in `.harnessbench/runs/<stamp>-<fixture>-<environment>/`: `run.json`,
`diff.patch`, `transcript.jsonl`, `setup.log`, `test.log` and the agent's raw output. The
`stamp` (`YYYYMMDD-HHMMSS`) is shared by every run of one invocation.

Useful flags: `--keep` (leave the workspaces on disk), `--max-turns`, `--model`, `--detail`,
`--json`.
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

Both print the same summary as `run` and rewrite the batch's `report.md` and `report.json`, so
the files always carry the latest verdicts. One row per criterion; lower is better for every count. A delta counts as `improved` or
`regressed` only when it clears both a relative threshold and a small absolute floor —
everything else reads `unchanged`, because one run per side is not a distribution. With several
fixtures the output opens with a roll-up naming which fixtures moved on each criterion; there is
no composite score.

`compare` never calls a model, only reads what `judge` wrote, and always exits 0: it reports, it
does not gate. `judge` is incremental — a verdict whose rubric has not changed is kept without a
model call; `--all` re-judges everything. `compare --markdown` (or `--detail` on any of the
three) prints the markdown report.

## CI

When `GITHUB_STEP_SUMMARY` is set, `run`, `compare` and `judge` append the markdown report to
it, so the job's summary page shows the report. Posting it on the PR is the workflow's job; the
report's path comes from `report.json`'s `stamp`:

```yaml
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # the merge base with the base branch
      - name: Benchmark the harness
        run: npx harnessbench run --judge --json > harnessbench.json
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Locate the report
        id: report
        if: ${{ !cancelled() }}
        run: echo "path=.harnessbench/runs/$(jq -r .stamp harnessbench.json)/report.md" >> "$GITHUB_OUTPUT"
      - uses: marocchino/sticky-pull-request-comment@v2
        if: ${{ !cancelled() }}
        with:
          header: harnessbench
          path: ${{ steps.report.outputs.path }}
```

Bitbucket Pipelines: not written yet.

## Status

Early. `init`, `run`, `compare` and `judge` work; three fixtures and three draft judges ship;
the Claude Code adapter is written and tested. Next: a position-swapped second judge call,
CI integration, and more agent adapters.

If you have the same problem, open an issue and describe how you'd want to test your harness.
Fixture design is where real examples help most.

## Changelog

- Unreleased: `run`, `compare` and `judge` print a one-screen summary and write the full report
  to `.harnessbench/runs/<stamp>/report.md` and `report.json`. `--json` on all three now prints
  that report document; it replaces the previous per-command JSON shapes (`run`'s batch result,
  `compare`'s comparison and batch comparison, `judge`'s comparison and judged batch).

## License

MIT
