---
# A contact sheet aimed at the ring's animation, which lasts 0.8 s from each recorded click
# (4.2, 9.8, 15.5, 22.0 s): at least one frame the tool samples must fall while a ring
# shows, after its click (at the click it has not grown yet) and before it fades. A regex
# sees a window's bounds, not the frames inside it: 2.7 to 7.2 s with
# count 2 samples only the two ends, and misses the ring at 4.2 s. So a judge works the
# samples out with the tool's own rule (frameTimes in electron/mcp/media-tools.ts; the
# 1/60 s it keeps off the film's end never reaches a ring). mock_calls, not trace: the
# trace may list every tool the session was offered.
type: llm
focus: mock_calls
arm: with-only
---

The clicks are at 4.2, 9.8, 15.5 and 22.0 s. After each click a ring shows for 0.8 s: after 4.2 and before 5.0 s, after 9.8 and before 10.6 s, after 15.5 and before 16.3 s, after 22.0 and before 22.8 s. At the click itself the ring has not grown yet, so that moment shows none.

Look at each getContactSheet call among these mock calls, and work out the times it samples:

- With atSec: those times, as given.
- With startSec and endSec: `count` frames, 12 when count is left out, spread evenly with both ends shown. Frame i, from 0 to count − 1, is at startSec + (endSec − startSec) × i / (count − 1). With count 1, the one frame is halfway between them.

A call does not count when:

- the tool refuses it, so it shows no frame: it passes atSec together with startSec or endSec, an endSec that is not after its startSec, or both projectId and path, or neither;
- it is not aimed at a click: it gives neither atSec nor both startSec and endSec (a sheet over the whole film, or one left open to its end), or its window does not sit around one click, starting at most 1.5 s before that click and ending at most 3 s after it.

PASS if a call that counts samples at least one time while a ring shows: after its click, and before the ring's end.

FAIL otherwise. For example, startSec 2.7, endSec 7.2 and count 2 sample only 2.7 and 7.2 s: no ring. The same window with count 12 samples every 0.41 s, and its frame at 4.34 s falls inside the ring from 4.2 s.
