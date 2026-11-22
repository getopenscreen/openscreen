---
# A 34 s take becomes a 20 s demo only through cuts or speed-ups. mock_calls, not trace:
# the trace may list every tool the session was offered.
type: regex
pattern: 'addTrims|addTrim\b|addSpeed|setClipRange'
target: mock_calls
arm: with-only
---
