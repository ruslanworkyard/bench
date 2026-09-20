#!/bin/sh
# Stands in for an agent that hit --max-turns: Claude Code reports the cut-off as the result
# event's subtype and exits non-zero, so the exit code alone cannot tell it from a crash. The
# trailing assistant text is the half-sentence it was in the middle of, not a summary.
cat <<'STREAM'
{"type":"system","subtype":"init","cwd":"/tmp/harnessbench/run/tree","session_id":"e4a2b1d3","tools":["Read","Bash","Edit"],"model":"claude-opus-5","permissionMode":"bypassPermissions","apiKeySource":"ANTHROPIC_API_KEY"}
{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"src/cache.ts"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"export function get(key: string) {\n  return store.get(key);\n}\n"}]}}
{"type":"assistant","message":{"id":"msg_02","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Now let's make the memory edits."}]}}
{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":504000,"duration_api_ms":480000,"num_turns":40,"session_id":"e4a2b1d3","total_cost_usd":1.25,"usage":{"input_tokens":50,"output_tokens":900,"cache_read_input_tokens":20000,"cache_creation_input_tokens":3000}}
STREAM
exit 1
