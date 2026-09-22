#!/bin/sh
# Stands in for an agent slow enough to show that the two sides run at once: marks when it
# started and when it finished, with 1.5 s in between, then replays a recorded stream so the
# run completes. The side is read off the workspace's run id, which ends in the environment.
#
# FAKE_CLAUDE_MARKS   directory for <environment>.started and <environment>.finished
# FAKE_CLAUDE_STREAM  the recording to replay on stdout
set -u

case "$(basename "$(dirname "$(pwd)")")" in
  *-previous) side=previous ;;
  *-candidate) side=candidate ;;
  *) side=unknown ;;
esac

: > "$FAKE_CLAUDE_MARKS/$side.started"
sleep 1.5
: > "$FAKE_CLAUDE_MARKS/$side.finished"

cat "$FAKE_CLAUDE_STREAM"
