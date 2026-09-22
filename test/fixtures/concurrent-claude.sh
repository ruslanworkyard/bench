#!/bin/sh
# Stands in for an agent slow enough to show which sides run at once: marks when it started
# and when it finished, with 1.5 s in between, then replays a recorded stream so the run
# completes. The mark is named by the run id, read off the workspace directory, so every
# side of every fixture in a batch leaves its own pair of marks.
#
# FAKE_CLAUDE_MARKS   directory for <run-id>.started and <run-id>.finished
# FAKE_CLAUDE_STREAM  the recording to replay on stdout
set -u

id="$(basename "$(dirname "$(pwd)")")"

: > "$FAKE_CLAUDE_MARKS/$id.started"
sleep 1.5
: > "$FAKE_CLAUDE_MARKS/$id.finished"

cat "$FAKE_CLAUDE_STREAM"
