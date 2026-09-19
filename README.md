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

Requires Node.js 20 or later and a git repository.

## Status

Early. `init` works and three fixtures ship; nothing runs yet. The rough order of what comes next:

1. `run <fixture>`: Claude Code in a worktree of the current branch, capturing diff, tests and telemetry
2. Harness overlay: `previous` vs `candidate` for the same fixture
3. Pairwise judge with default rubrics
4. `compare`, Markdown report, and a GitHub Action that comments on PRs touching harness files
5. Further agent adapters

If you're reading this because you have the same problem, open an issue and describe how you'd want to test your harness. Fixture design is the part where real examples help most.

## License

MIT
