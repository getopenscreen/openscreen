---
# The whole 24 s film on one sheet: no atSec, startSec under 1 s and endSec at 24 s or more
# when given. A sheet over one zoom or one cut does not count, since the mock describes the
# whole film whatever span is asked for.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__getContactSheet
input_match: '^(?![\s\S]*"atSec")(?![\s\S]*"startSec"\s*:\s*[1-9])(?![\s\S]*"endSec"\s*:\s*(?:1?\d|2[0-3])(?:\.\d+)?(?![\d.]))'
arm: with-only
---
