---
# A contact sheet aimed at the ring's animation, which lasts 0.8 s from each recorded click
# (4.2, 9.8, 15.5, 22.0 s). Either atSec holds a moment inside one of those 0.8 s, or a
# startSec / endSec window overlaps one: startSec from 1.5 s before the click to the ring's
# end, endSec after the click (9.85 s counts for the 9.8 s click) and at most 3 s after it.
# A sheet over the whole film, a window left open to the end, or frames after the ring has
# faded do not count. Nor does a call that passes atSec with startSec or endSec: the tool
# refuses it and shows no frame.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__getContactSheet
input_match: '^(?!(?=[\s\S]*"atSec")[\s\S]*"(?:start|end)Sec")(?:[\s\S]*?"atSec"\s*:\s*\[\s*(?:[^\]]*?,\s*)?(?:4\.[2-9]\d*|9\.[89]\d*|10(?:\.[0-5]\d*)?|15\.[5-9]\d*|16(?:\.[0-2]\d*)?|22(?:\.[0-7]\d*)?)(?![\d.])|(?=[\s\S]*"startSec"\s*:\s*(?:2\.[7-9]\d*|[34](?:\.\d+)?)(?![\d.]))(?=[\s\S]*"endSec"\s*:\s*(?:4\.2\d*[1-9]\d*|4\.[3-9]\d*|[56](?:\.\d+)?|7(?:\.[01]\d*|\.20*)?)(?![\d.]))|(?=[\s\S]*"startSec"\s*:\s*(?:8\.[3-9]\d*|9(?:\.\d+)?|10(?:\.[0-5]\d*)?)(?![\d.]))(?=[\s\S]*"endSec"\s*:\s*(?:9\.8\d*[1-9]\d*|9\.9\d*|1[01](?:\.\d+)?|12(?:\.[0-7]\d*|\.80*)?)(?![\d.]))|(?=[\s\S]*"startSec"\s*:\s*(?:1[45](?:\.\d+)?|16(?:\.[0-2]\d*)?)(?![\d.]))(?=[\s\S]*"endSec"\s*:\s*(?:15\.5\d*[1-9]\d*|15\.[6-9]\d*|1[67](?:\.\d+)?|18(?:\.[0-4]\d*|\.50*)?)(?![\d.]))|(?=[\s\S]*"startSec"\s*:\s*(?:20\.[5-9]\d*|21(?:\.\d+)?|22(?:\.[0-7]\d*)?)(?![\d.]))(?=[\s\S]*"endSec"\s*:\s*(?:22\.\d*[1-9]\d*|2[34](?:\.\d+)?|25(?:\.0+)?)(?![\d.])))'
arm: with-only
---
