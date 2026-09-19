#!/bin/sh
# Stands in for an agent that cannot start: says why on stderr, exits non-zero, no stream.
echo "claude: invalid API key" >&2
exit 2
