#!/bin/sh
# Stands in for an agent that hangs: sleeps, in a child, until the timeout kills the group.
# The odd duration is a pattern the test can pgrep for.
sleep 3137 &
wait
