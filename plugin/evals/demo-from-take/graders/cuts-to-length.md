---
# A 34 s take becomes a 20 s demo only through cuts or speed-ups, and what counts is the
# length they leave, not that one was made. mock_calls, not trace: the trace may list every
# tool the session was offered.
type: llm
focus: mock_calls
arm: with-only
---

The take in project p_demo is 34 s long. From the edit calls among these mock calls, work out how long the edited film plays:

- each range passed to addTrims (or addTrim) removes endSec − startSec seconds;
- setClipRange keeps only sourceStartSec to sourceEndSec of the take;
- addSpeed from startSec to endSec at speed s saves (endSec − startSec) × (1 − 1/s) seconds, at speed 1.5 when none is given.

Count each second once: a stretch removed twice, or removed and sped up, is removed once.

PASS if the film that remains plays between 17 and 23 seconds.
FAIL if it plays longer or shorter, or if no call cuts or speeds up the take.
