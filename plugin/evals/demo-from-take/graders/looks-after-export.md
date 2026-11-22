---
# The review looks at the exported file itself (by its path), after that file's export. A
# sheet over the project before editing is right too, so the order is on the file, not the tool.
type: tool_order
before:
  tool: mcp__plugin_openscreen_openscreen__exportVideo
  input_match: '"path"\s*:\s*"[^"]*ledger-pdf\.mp4"'
after:
  tool: mcp__plugin_openscreen_openscreen__getContactSheet
  input_match: '"path"\s*:\s*"[^"]*ledger-pdf\.mp4"'
arm: with-only
---
