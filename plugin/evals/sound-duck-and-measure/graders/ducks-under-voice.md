---
# A music track 6 dB or more under unity, under the narration (3 to 27.5 s): kind music or
# left to its default, starting before 27.5 s and ending after 3 s or left open. The bed may
# be split into several tracks, so only one of them needs it.
type: tool_used
tool: mcp__plugin_openscreen_openscreen__addAudio
input_match: '^(?![\s\S]*"kind"\s*:\s*"voiceover")(?=[\s\S]*"gainDb"\s*:\s*-(?:[6-9]|[1-5]\d)(?:\.\d+)?(?![\d.]))(?=[\s\S]*"startSec"\s*:\s*(?:(?:1?\d|2[0-6])(?:\.\d+)?|27(?:\.[0-4]\d*)?)(?![\d.]))(?![\s\S]*"endSec"\s*:\s*(?:[0-2](?:\.\d+)?|3)(?![\d.]))'
arm: with-only
---
