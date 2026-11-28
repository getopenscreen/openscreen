---
# Eight zooms down to four or fewer: at least four of z1 to z8 removed. A merge also
# removes zooms (keep or add one, remove the rest), so this holds for both fixes.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__removeModifier
input_match: '"id"\s*:\s*"z[1-8]"'
min: 4
arm: with-only
---
