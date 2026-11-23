---
# The whole programme measured, not one track alone (no audioId): the mock answers every
# call with the whole film's numbers, so only this call earns them.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__getAudioReport
input_match: '^(?![\s\S]*"audioId")'
arm: with-only
---
