Add a `harnessbench runs` command that lists past runs.

It reads every run directory under `.harnessbench/runs/` in the current repository and prints
one line per run, newest first: run id, fixture, outcome, turns, total tokens, cost (or `-`
when the agent did not report one), duration, and whether the test command passed, failed, or
was not configured. Align the columns so the table is readable in a terminal.

Details:

- A directory without a readable `run.json` is listed as `unreadable` rather than crashing the
  command or being silently skipped.
- `--fixture <id>` filters to one fixture. `--json` prints the same rows as a JSON array and
  nothing else on stdout.
- With no runs at all, print a one-line hint about how to create one and exit 0.
- Outside a git repository, or without `.harnessbench/config.json`, fail the way the other
  commands do.

Follow the conventions this repository already uses for commands, output formatting, argument
handling, and tests. Do not add dependencies.
