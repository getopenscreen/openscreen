---
# The fix is the one line: the corrected call still carries the user's ring function, the
# `var k` it declares, and the clicks it adds up into k.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__addEffect
input_match: '^(?=[\s\S]*fn ring\s*\()(?=[\s\S]*var k\b)(?=[\s\S]*k\s*(?:\+=|=\s*k\s*\+)\s*ring\s*\(\s*uv\s*,\s*ctx\.clicks\s*\[)'
arm: with-only
---
