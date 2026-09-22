#!/bin/sh
# Stands in for the `claude` CLI in tests: replays a recorded stream-json run and records
# what it was handed, so the adapter's side of the contract can be asserted. Never networks.
#
# FAKE_CLAUDE_STREAM  the recording to replay on stdout
# FAKE_CLAUDE_DUMP    where to write the argv, cwd, tree listing and environment it saw; stdin goes to
#                     the same path with .stdin appended. Both sides of a run share the path and
#                     run at once, so each file is written whole and moved into place: the last
#                     side to finish wins, and nothing is ever half of each.
set -u

{
  echo "argv: $*"
  echo "cwd: $(pwd)"
  echo "files: $(ls -A | sort | tr '\n' ' ')"
  env | sort
} > "$FAKE_CLAUDE_DUMP.$$"
mv "$FAKE_CLAUDE_DUMP.$$" "$FAKE_CLAUDE_DUMP"

cat > "$FAKE_CLAUDE_DUMP.stdin.$$"
mv "$FAKE_CLAUDE_DUMP.stdin.$$" "$FAKE_CLAUDE_DUMP.stdin"

echo "the agent was here" > agent-was-here.txt

cat "$FAKE_CLAUDE_STREAM"
