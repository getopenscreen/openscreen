---
# Two callouts: text annotations with words (type defaults to text), not blurs or arrows.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__addAnnotation
input_match: '^(?![\s\S]*"type"\s*:\s*"(?:blur|figure)")(?=[\s\S]*"text"\s*:\s*"[^"])'
min: 2
arm: with-only
---
