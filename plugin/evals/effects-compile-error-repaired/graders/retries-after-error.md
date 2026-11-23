---
# The refused call comes first, then a corrected addEffect: not another tool, not a stop.
type: tool_order
before:
  tool: mcp__plugin_openscreen_openscreen__addEffect
  input_match: 'let k = 0\.0'
after:
  tool: mcp__plugin_openscreen_openscreen__addEffect
  input_match: 'var k'
arm: with-only
---
