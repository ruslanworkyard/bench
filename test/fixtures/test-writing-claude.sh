#!/bin/sh
# Stands in for the `claude` CLI in tests: writes one source file and one test file, as an agent
# that tests its own work would, then replays a recorded stream-json run. Never networks.
#
# FAKE_CLAUDE_STREAM  the recording to replay on stdout
set -u

cat > /dev/null
mkdir -p src
echo "export const answer = 42;" > src/answer.ts
echo "test('answer', () => {});" > src/answer.test.ts

cat "$FAKE_CLAUDE_STREAM"
