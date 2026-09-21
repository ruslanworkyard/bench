# harnessbench

**Regression tests for your `CLAUDE.md`.**

You changed a line in `CLAUDE.md`, added a skill, or rewrote `AGENTS.md`. Did your coding agent get better or worse? Today the answer is a feeling. harnessbench makes it a number.

```
harnessbench: previous → candidate                        1 fixture · claude-code

Correctness            passed   → passed      unchanged
Test suite             green    → green       unchanged
Tests written          judge: candidate preferred    improved
Diff size              412 ln   → 354 ln      −14%        improved
Tokens                 1.21M    → 0.96M       −21%        improved
Tool calls             18       → 15          −3          unchanged  (within noise)
Engineering quality    candidate preferred                improved
Scope discipline       tie                                unchanged
```

*Illustrative output. The project is at an early stage; see [Status](#status).*

## Why

An AI harness — `CLAUDE.md`, `AGENTS.md`, skills, MCP config, hooks — is build configuration. Like a Makefile, a change to it affects every task an agent performs across the whole codebase. We test compiler flags; we should test harness changes too, rather than accepting them on vibes.

These benchmarks cost real tokens to run. A degraded harness costs more, because it degrades every agent session until someone notices.

## How it works

1. **Fixtures** are realistic engineering tasks — a prompt and a one-line description, nothing more. Three ship with the tool; add your own under `.harnessbench/fixtures/`.
2. **Environments** are two versions of the harness: `previous` (what's on `main`) and `candidate` (your branch). Code is identical in both; only the harness differs.
3. A **setup command** from the config (`npm ci`, `go mod download`, detected from the lockfile) makes each disposable workspace ready before the agent's clock starts, so the first turns are not spent discovering that nothing is installed.
4. An **agent adapter** runs each fixture in each environment inside a disposable workspace and records what happened: the diff, the transcript, tokens, cost, tool calls, time. Claude Code first; Codex, Aider, Gemini CLI, OpenCode and Pi to follow.
5. A **thin mechanical layer** checks the hard facts: does your test suite still pass, how big is the diff, what did the agent spend (tokens, cost, time, tool calls).
6. **AI judges** decide everything that can't be measured mechanically — code quality, engineering practice, test quality, and whatever criterion you write a rubric for — by comparing the `previous` and `candidate` results side by side as A and B, blind to which is which, one verdict per judge with the evidence that decided it.
7. The report is a table of **deltas**, one row per criterion: `compare` turns the two runs into it, and `run` prints it as soon as both sides are in. Improvements and regressions are both visible, and a delta below the noise threshold is reported as unchanged rather than dressed up as signal. Nothing rolls the rows into a score.

Runs are content-addressed by fixture, base commit, harness hash, agent and model, so baseline runs are cached and a PR normally pays only for the candidate side.

## Design principles

- **Judges carry the signal, mechanics carry the facts.** Almost nothing about code quality can be measured portably across languages. The mechanical core is deliberately small and operator-owned; everything else is judged, pairwise and blind.
- **Deltas, not scores.** "Tokens −21%, quality improved, tests unchanged" tells an engineer what happened. A single number does not.
- **One run per fixture per side.** Agents run at low temperature and repeats multiply cost. Small deltas are reported as within noise rather than dressed up as signal; repeats are available when you want distributions.
- **Agnostic core, opinionated adapters.** Language, framework and agent specifics live behind adapter interfaces.
- **Artefacts are the source of truth.** Every run persists its diff, transcript and results, so evaluation and reporting can be re-run without re-running the agent.

## Getting started

```sh
npx harnessbench init
```

`init` inspects the current git repository, detects your harness files (`CLAUDE.md`, `.claude/`, `AGENTS.md`, `.mcp.json` and anything they reference), your test command, your setup command (from the lockfile: `package-lock.json` means `npm ci`, `go.sum` means `go mod download`, and so on; a manifest without a lockfile is not enough), your base branch and which agents are installed, then writes `.harnessbench/config.json` you can edit and copies the starter fixtures into `.harnessbench/fixtures/`. Run it with `--dry-run` first to see what it would do, or `--json` for machine-readable output.

The config it writes is small and meant to be edited by hand:

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
    "maxContextKb": 512
  },
  "judges": ["code-quality", "engineering-practices", "test-quality"]
}
```

`setupCommand` runs in each workspace before the agent starts, with the same minimal environment as the test command and a ten-minute cap; `""` means the tree is used as cloned. It is the project's own install step, so keep it frozen (`npm ci`, not `npm install`): anything it changes that is not ignored by git would otherwise count as the agent's diff. `agent.name` chooses the adapter; `command` is the binary it runs (a name on `PATH` or a path), and `model`, `maxTurns` and `args` are passed through to it. A key you did not mean to set is an error naming it, rather than a setting that is silently ignored.

Credentials are never stored in the config. harnessbench forwards the agent's own environment variables from your shell — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` (a subscription token from `claude setup-token`), or the Bedrock and Vertex settings — and refuses to start when none of them is set. The agent runs in a disposable clone of your repository with its own `HOME` and its own config directory, so your `~/.claude` is neither read nor written, and nothing it does can reach the original repository.

Then run a fixture:

```sh
npx harnessbench run ttl-cache
```

`run` drives the fixture twice on the same code, the current `HEAD`: once as `previous`, with the harness files as they were committed at the merge base of your branch and the base branch, and once as `candidate`, with the harness at `HEAD`. Each side gets a disposable shallow clone (for `previous`, the merge-base harness is overlaid on top and folded into the clone's single commit, so the agent sees an ordinary checkout), the setup command installs its dependencies (its output goes to `setup.log`; a setup that fails or times out stops the run with exit 1 and no `run.json` for that side, because a tree that cannot install is a configuration problem, not a result), the fixture's prompt is handed to the agent there, the diff is captured, your test command runs against the result, and everything lands in `.harnessbench/runs/<timestamp>-<fixture>-<environment>/`: the agent's raw output stream, a normalised `transcript.jsonl`, `diff.patch`, `setup.log`, `test.log`, `agent.stderr.log` and a `run.json` with the outcome, setup and test results, a hash of the harness that ran, and the telemetry: what the agent reported for the whole run (tokens, cost, turns, tool calls by name) plus what the transcript says about how it worked, derived once from `transcript.jsonl` so every adapter gets it for free: turns, calls, failures and tokens per thread (the main conversation and each sub-agent, with the model it ran on), reads and turns before the first edit, distinct files read and written, repeat reads (the main thread re-reading a file) and duplicate reads (the main thread reading what a sub-agent already had), and the wall clock split into exploring (start to first write), building (first to last write) and verifying (last write to the end). Each transcript event carries its thread and its arrival time in milliseconds since the agent started, and each tool call its adapter-neutral kind (read, write, search, shell, spawn, other) and the file it touched, relative to the workspace. It then prints one summary per side:

```
harnessbench run  ttl-cache · previous  → completed in 3m48s

Harness    2 files at 9c21e63 (merge base) · hash 87329bfeb114
Agent      claude-code · claude-sonnet-4-5
Turns      31   Tool calls  58 (Read 24, Edit 14, Bash 20)   Tool failures 4
...

harnessbench run  ttl-cache · candidate  → completed in 4m12s

Harness    2 files at 0655c52 (HEAD) · hash fde8ac86d613
Agent      claude-code · claude-sonnet-4-5
Setup      npm ci → ok in 24s
Turns      23   Tool calls  41 (Read 18, Edit 9, Bash 14)   Tool failures 2
Threads    main 20 turns / 30 calls · Explore on claude-haiku-4-5: 11 calls
Phases     exploring 1m02s · building 2m30s · verifying 40s
Tokens     in 1,203  out 18,940  cache read 402,113  cache write 10,004
Cost       $0.38
Changes    5 files, +212 / -7
Tests      npm test → passed in 12s
Run dir    .harnessbench/runs/20260919-031455-ttl-cache-candidate

Final message: Added a TTL cache and wired it into the expensive read.
```

After the two summaries comes the comparison, the same table `compare` prints:

```
harnessbench compare  ttl-cache · code 0655c52

Harness    previous 9c21e63 → candidate 0655c52
Model      claude-sonnet-4-5
Runs       20260919-031455-ttl-cache-previous → 20260919-031455-ttl-cache-candidate

one run per side; deltas below the noise threshold are reported as unchanged

Outcome                  completed  → completed        unchanged
Tests                    failed     → passed           improved
Files changed            6          → 5          -1    unchanged  within noise
Lines changed            412        → 219        -47%  improved
Turns                    31         → 23         -8    improved
Tool calls (main)        58         → 30         -28   improved
Tool calls (sub-agents)  0          → 11         +11   regressed
Tool failures            4          → 2          -2    improved
Sub-agents               0          → 1          +1    unchanged  previous none → candidate Explore on claude-haiku-4-5
Reads before first edit  14         → 6          -8    improved
Duplicate reads          0          → 2          +2    regressed
Main-thread cache read   638,000    → 300,000    -53%  improved
Exploring                2m10s      → 1m02s      -52%  improved
Tokens                   638,000    → 432,260    -32%  improved
Output tokens            24,000     → 18,940     -21%  improved
Cost                     $0.51      → $0.38      -25%  improved
Duration                 3m48s      → 4m12s      +11%  unchanged  within noise
```

One row per criterion, lower is better for every count except `Sub-agents`, which is reported but never judged (delegating is a choice, not a cost; its note names the models that ran), and a delta only counts as `improved` or `regressed` when it clears both a relative threshold (15%, or 20% for the diff) and a small absolute floor (so 2 → 3 turns is never a regression). Anything the reader must know before trusting the rows is printed as a `warning:` line above them: a side that did not complete (its effort rows turn `n/a`), different models, an identical harness on both sides, or two runs from different `run` invocations. A `run.json` written before the per-thread telemetry existed still compares; its telemetry rows read `n/a`, "recorded by an earlier version".

When both hashes are equal the harness did not change between the merge base and `HEAD`, and `run` says so before it starts: any difference between the two sides is then noise. `--json` prints both `run.json` records and the comparison as one array, `--keep` leaves both workspaces on disk and prints their paths, and `--max-turns` and `--model` override the config for one run. The exit code reports the agent, not your tests: 0 when both sides completed, 2 when either timed out, 3 when either failed, 4 when either hit the turn limit, 1 for anything wrong with the setup. A failing test suite is a result, recorded in `run.json`, not an error.

To see the table again later, or for a pair of runs you name:

```sh
npx harnessbench compare --fixture ttl-cache                      # the latest run of the fixture
npx harnessbench compare <previous-run-id> <candidate-run-id>     # any pair, in either order
```

`compare` refuses a pair that is not one `previous` and one `candidate` of the same fixture on the same `HEAD`, and says which check failed. `--markdown` prints the same table as GitHub-flavoured markdown, ready to be a PR comment; `--json` prints the comparison object. It always exits 0 after printing: it reports, it does not gate.

## Judges

The table says what each side cost and whether the tests pass. It cannot say whether the code the candidate harness produced is better than the code the previous one produced. A judge can: it reads both sides' work and says which it prefers on one criterion, with a reason.

```sh
npx harnessbench judge --fixture ttl-cache                        # the latest run pair of the fixture
npx harnessbench judge <previous-run-id> <candidate-run-id>       # any pair, in either order
npx harnessbench run ttl-cache --judge                            # run both sides, then judge them
```

```
harnessbench judge  ttl-cache · code 0655c52

Runs       20260919-031455-ttl-cache-previous → 20260919-031455-ttl-cache-candidate
Shown as   A = previous, B = candidate

Code quality           candidate preferred   B's TtlCache keeps the existing error type in read.ts; A introduces a second one.
Engineering practices  tie                   Both ran the suite once after the change; neither log shows a blind retry.
Test quality           previous preferred    A's tests cover expiry and eviction through the public get/set; B's only assert the map size.
```

Judges are a catalogue, like fixtures. Three ship with the tool and `init` copies them into `.harnessbench/judges/`, one directory per judge, skipping any id you already have: `code-quality` (the diff, read as a reviewer would), `engineering-practices` (the diff and the tool log: scope, verification, method) and `test-quality` (the diff and the test result: whether the tests would fail if the feature broke). Their rubrics are drafts, and each `prompt.md` says so in its first line; edit them to fit your codebase.

To write your own, add a directory with a `judge.json` and the rubric it points at:

```json
{
  "id": "error-handling",
  "title": "Error handling",
  "description": "Whether failures are handled the way this codebase handles them",
  "prompt": "prompt.md",
  "context": ["prompt", "diff"]
}
```

`context` declares what the judge is allowed to look at, from a fixed menu: `prompt` (the fixture's task), `diff`, `tests` (the fact only, `passed`, `failed` or `not configured`, never the log), `finalMessage`, `toolLog` (one line per tool call on the main thread, a sub-agent folded into the line that spawned it) and `transcript` (the whole normalised transcript as readable text). The rubric is the system prompt; a fixed instruction block is appended to every rubric telling the model to judge only on the criterion above, to answer `tie` unless the evidence shows a real difference, not to reward length or effort, and to name the file, hunk, test or message that decided it. Then add the id to `judges` in the config; judges run in that order. A `judge.json` may also set `provider`, `model` and `apiKeyEnv` to override the config's `judge` block for that one judge.

The two sides are shown to the model as **A** and **B**, in a fixed layout: the task once, then every other item for A, then for B. `previous` is always A and `candidate` always B. The mapping is fixed rather than swapped on purpose: if the model has a first-position tilt, it favours the incumbent, so a `candidate preferred` verdict has cleared that bar. The words previous and candidate, the run ids and the harness hashes never appear in what the judge reads; the mapping is recorded in the output so nobody has to remember it. Every verdict is translated back to `previous preferred`, `candidate preferred` or `tie` before it is stored.

The `judge` block of the config chooses the model: `provider` is one of `anthropic`, `openai`, `google` or `openai-compatible` (with `baseUrl`), and `model` is required and written empty by `init`, so the choice is yours; `judge` refuses until it is made. `HARNESSBENCH_JUDGE_PROVIDER` and `HARNESSBENCH_JUDGE_MODEL` override both the config and any `judge.json` for one invocation. The API key is read from the provider's conventional variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) or from the one `apiKeyEnv` names, at call time; it is never stored, logged or printed, and the only check before judging is that the variable is set.

`judge` refuses, before any model is called, when either side did not complete (a run cut off by the turn limit is not a finished attempt), when the two records are not a valid pair, when no model is set or the key variable is unset, and when any context item on either side is over `maxContextKb` (512 KB by default). Nothing is ever truncated: a fixture that produces more output than a judge can read is a fixture to narrow, or a diff to keep generated paths out of. With `run --judge`, a refusal is one `judging skipped: …` line on stderr and the run's own exit code.

Every judging writes `.harnessbench/runs/<timestamp>-<fixture>-judge/`: `judge.json` with the verdicts (judge, title, preference, reason, provider, model, tokens used) and, per judge, `prompt.txt` with exactly what was sent and `response.json` with the raw reply. Judging a pair again replaces the directory. A model that twice fails to answer in the expected shape is an error naming the judge, with its reply kept there.

Requires Node.js 20 or later and a git repository.

## Status

Early. `init`, `run`, `compare` and `judge` work, three fixtures and three draft judges ship, and the Claude Code adapter is written and tested. `run` produces the `previous` and `candidate` sides of one fixture, `compare` reports the mechanical deltas between them, and `judge` gives one blind pairwise verdict per configured judge; the verdicts do not yet appear as rows of the comparison table. The rough order of what comes next:

1. Judge rows in the comparison table, and a position-swapped second call as an opt-in
2. A GitHub Action that comments the markdown table on PRs touching harness files
3. Further agent adapters

If you're reading this because you have the same problem, open an issue and describe how you'd want to test your harness. Fixture design is the part where real examples help most.

## License

MIT
