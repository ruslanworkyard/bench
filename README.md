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
3. An **agent adapter** runs each fixture in each environment inside a disposable workspace and records what happened: the diff, the transcript, tokens, cost, tool calls, time. Claude Code first; Codex, Aider, Gemini CLI, OpenCode and Pi to follow.
4. A **thin mechanical layer** checks the hard facts: does your test suite still pass, how big is the diff, what did the agent spend (tokens, cost, time, tool calls).
5. **AI judges** decide everything that can't be measured mechanically — engineering quality, scope discipline, maintainability, test intent, reasoning efficiency — by comparing the `previous` and `candidate` results side by side, blind to which is which.
6. The report is a table of **deltas**, one row per criterion. Improvements and regressions are both visible. A composite score exists for CI gating, but never hides the individual rows.

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

`init` inspects the current git repository, detects your harness files (`CLAUDE.md`, `.claude/`, `AGENTS.md`, `.mcp.json` and anything they reference), your test command, your base branch and which agents are installed, then writes `.harnessbench/config.json` you can edit and copies the starter fixtures into `.harnessbench/fixtures/`. Run it with `--dry-run` first to see what it would do, or `--json` for machine-readable output.

The config it writes is small and meant to be edited by hand:

```json
{
  "baseBranch": "main",
  "testCommand": "npm test",
  "agent": {
    "name": "claude-code",
    "command": "claude",
    "model": null,
    "maxTurns": null,
    "timeoutMinutes": 20,
    "args": [],
    "env": []
  },
  "harness": { "extraPaths": [] }
}
```

`agent.name` chooses the adapter; `command` is the binary it runs (a name on `PATH` or a path), and `model`, `maxTurns` and `args` are passed through to it. A key you did not mean to set is an error naming it, rather than a setting that is silently ignored.

Credentials are never stored in the config. harnessbench forwards the agent's own environment variables from your shell — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` (a subscription token from `claude setup-token`), or the Bedrock and Vertex settings — and refuses to start when none of them is set. The agent runs in a disposable clone of your repository with its own `HOME` and its own config directory, so your `~/.claude` is neither read nor written, and nothing it does can reach the original repository.

Then run a fixture:

```sh
npx harnessbench run ttl-cache
```

`run` drives the fixture twice on the same code, the current `HEAD`: once as `previous`, with the harness files as they were committed at the merge base of your branch and the base branch, and once as `candidate`, with the harness at `HEAD`. Each side gets a disposable shallow clone (for `previous`, the merge-base harness is overlaid on top and folded into the clone's single commit, so the agent sees an ordinary checkout), the fixture's prompt is handed to the agent there, the diff is captured, your test command runs against the result, and everything lands in `.harnessbench/runs/<timestamp>-<fixture>-<environment>/`: the agent's raw output stream, a normalised `transcript.jsonl`, `diff.patch`, `test.log`, `agent.stderr.log` and a `run.json` with the outcome, telemetry, test result and a hash of the harness that ran. It then prints one summary per side:

```
harnessbench run  ttl-cache · previous  → completed in 3m48s

Harness    2 files at 9c21e63 (merge base) · hash 87329bfeb114
Agent      claude-code · claude-sonnet-4-5
Turns      31   Tool calls  58 (Read 24, Edit 14, Bash 20)   Tool failures 4
...

harnessbench run  ttl-cache · candidate  → completed in 4m12s

Harness    2 files at 0655c52 (HEAD) · hash fde8ac86d613
Agent      claude-code · claude-sonnet-4-5
Turns      23   Tool calls  41 (Read 18, Edit 9, Bash 14)   Tool failures 2
Tokens     in 1,203  out 18,940  cache read 402,113  cache write 10,004
Cost       $0.38
Changes    5 files, +212 / -7
Tests      npm test → passed in 12s
Run dir    .harnessbench/runs/20260919-031455-ttl-cache-candidate

Final message: Added a TTL cache and wired it into the expensive read.
```

When both hashes are equal the harness did not change between the merge base and `HEAD`, and `run` says so before it starts: any difference between the two sides is then noise. `--json` prints both `run.json` records as one array, `--keep` leaves both workspaces on disk and prints their paths, and `--max-turns` and `--model` override the config for one run. The exit code reports the agent, not your tests: 0 when both sides completed, 2 when either timed out, 3 when either failed, 1 for anything wrong with the setup. A failing test suite is a result, recorded in `run.json`, not an error.

Requires Node.js 20 or later and a git repository.

## Status

Early. `init` and `run` work, three fixtures ship, and the Claude Code adapter is written and tested. `run` produces the `previous` and `candidate` sides of one fixture; nothing compares them yet, so what you get is two measured runs and their telemetry side by side. The rough order of what comes next:

1. Pairwise judge with default rubrics
2. `compare`, Markdown report, and a GitHub Action that comments on PRs touching harness files
3. Further agent adapters

If you're reading this because you have the same problem, open an issue and describe how you'd want to test your harness. Fixture design is the part where real examples help most.

## License

MIT
