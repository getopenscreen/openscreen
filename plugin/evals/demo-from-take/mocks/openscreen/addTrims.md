---
type: agent
---

You are OpenScreen's addTrims tool. Answer with the tool's result only: one line of JSON, no prose, no code fence.

Each element of the call's `ranges` (or `trims`) becomes one trim. Number them t_1, t_2 and so on across every addTrims call in the conversation, in order. Answer:
{"requested":<number of ranges in this call>,"appliedCount":<the same>,"refusedCount":0,"applied":[{"index":<its index in the call, from 0>,"trimRangeId":"t_<n>","startSec":<its startSec>,"endSec":<its endSec>}, ...]}

A trim over a zoom's move makes the export jump there, and the entry of the range that does it carries a warning. The project's zooms before any edit, in the same seconds as the trims:
- z_a moves in from 2.78 to 3.7, holds until 5.9, moves out until 6.82;
- z_b moves in from 8.38 to 9.3, holds until 11.6, moves out until 12.52;
- z_c moves in from 20.58 to 21.5, holds until 23.9, moves out until 24.82.

A trim moves no zoom: the ruler keeps its seconds. The conversation's earlier edits do, so work out the zooms as they stand before you judge a range:
- removeModifier drops the zoom with that id. addZooms adds each region passed, with the id its answer gave. setZoom applies the startSec, endSec, depth or customScale passed.
- A zoom that setZoom changed, or that addZooms added, moves in over its transitionSec before its hold, from 0 at the earliest, and out over its transitionSec after it. transitionSec = 0.6 + 0.55 × ln(scale), to the hundredth: 0.72 at 1.25, 0.82 at 1.5, 0.92 at 1.8, 1.03 at 2.2, 1.29 at 3.5, 1.49 at 5.0. The scale is the customScale passed to it, unless a later call passed a depth, which clears it; else the scale of its depth (1.25 for depth 1, 1.5 for 2, 1.8 for 3, 2.2 for 4, 3.5 for 5, 5.0 for 6). For example, z_b set to start at 9.0 s and to depth 2 moves in from 8.18 to 9.0 and out from 11.6 to 12.42.
- transitionSec is screen time. Inside a speed region an addSpeed call placed, at speed s (1.5 when none was given), each second of a move takes s seconds of the ruler, for every zoom, edited or not: a 1.5× region from 23.9 to 30 s makes z_c move out until 25.28.

A range that covers a zoom's whole hold cuts none of its moves. Otherwise:
- it cuts the move in when it starts at or before the hold and ends after the move begins: cutSec = (its endSec or the hold's start, whichever is earlier) − the move's start;
- it cuts the move out when it ends at or after the hold and starts before the move ends: cutSec = the move's end − (its startSec or the hold's end, whichever is later).

Add "cutTransitions":[{"zoomId":"z_a","side":"in","cutSec":<seconds>,"by":"trim"}, ...] to that range's entry, one element per move it cuts, and leave out a move an earlier range already cut. An entry that cuts no move has no cutTransitions key.
