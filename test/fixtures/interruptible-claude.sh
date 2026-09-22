#!/bin/sh
# Stands in for an agent that is mid-run when the user presses Ctrl-C: writes its pid, named
# after the workspace directory, then sleeps far longer than the test waits. If the
# interruption does not kill it, the pid file says which process to look for.
#
# FAKE_CLAUDE_MARKS   directory for <workspace>.pid
set -u

echo $$ > "$FAKE_CLAUDE_MARKS/$(basename "$(dirname "$(pwd)")").pid"
exec sleep 30
