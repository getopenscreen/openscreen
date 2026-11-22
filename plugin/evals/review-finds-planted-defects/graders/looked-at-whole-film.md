---
# The whole 24 s film on one sheet, at a frame a second or more, as the review skill asks
# (count 24 for its first sheet): count 24 to 36, no atSec, startSec under 1 s and endSec
# at 24 s or more when given. Left out, count is 12: too few. A sheet over one zoom or one
# cut, or a handful of frames, does not count, since the mock describes the whole film
# whatever is asked for.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__getContactSheet
input_match: '^(?![\s\S]*"atSec")(?![\s\S]*"startSec"\s*:\s*[1-9])(?![\s\S]*"endSec"\s*:\s*(?:1?\d|2[0-3])(?:\.\d+)?(?![\d.]))(?=[\s\S]*"count"\s*:\s*(?:2[4-9]|3[0-6])(?![\d.]))'
arm: with-only
---
