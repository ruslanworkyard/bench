#!/bin/sh
# Stands in for an agent that hangs: sleeps, in a child, until the timeout kills the group.
# The odd duration is a pattern the test can pgrep for; FAKE_CLAUDE_SLEEP makes it unique to
# one test process, so two copies of the suite running at once never see each other's sleep.
sleep "${FAKE_CLAUDE_SLEEP:-3137}" &
wait
