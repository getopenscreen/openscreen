---
# The whole 24 s film of p_demo on one sheet, at a frame a second or more, as the review
# skill asks (count 24 for its first sheet): projectId p_demo and no path, count 24 to 36,
# no atSec, startSec under 1 s and endSec at 24 s or more when given. The case names no
# exported file, so a path cannot be tied to p_demo, and the tool refuses projectId and path
# together. Left out, count is 12: too few. A sheet over one zoom or one cut, or a handful of
# frames, does not count, since the mock describes the whole film whatever is asked for.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__getContactSheet
input_match: '^(?=[\s\S]*"projectId"\s*:\s*"p_demo")(?![\s\S]*"path")(?![\s\S]*"atSec")(?![\s\S]*"startSec"\s*:\s*[1-9])(?![\s\S]*"endSec"\s*:\s*(?:1?\d|2[0-3])(?:\.\d+)?(?![\d.]))(?=[\s\S]*"count"\s*:\s*(?:2[4-9]|3[0-6])(?![\d.]))'
arm: with-only
---
