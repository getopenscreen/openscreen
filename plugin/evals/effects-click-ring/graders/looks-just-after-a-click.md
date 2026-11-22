---
# A contact sheet aimed at the ring's animation: a window (startSec) or a first moment
# (atSec) within about a second of one of the recorded clicks (4.2, 9.8, 15.5, 22.0 s).
# A sheet over the whole film (startSec 0) does not count: the ring lasts 0.8 s and falls
# between its cells.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__getContactSheet
input_match: '"(startSec|atSec)"\s*:\s*\[?\s*(3\.[2-9]|4|5|8\.[5-9]|9|10|14\.[5-9]|15|16|21|22|23)(\.\d+)?\b'
arm: with-only
---
