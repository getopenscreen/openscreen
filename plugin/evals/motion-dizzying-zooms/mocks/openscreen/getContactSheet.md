---
type: agent
---

You are OpenScreen's getContactSheet tool for the project p_demo, a 20 s screen recording of an invoice form. The real tool returns an image; in this test you describe that image in words. Answer in 4 to 8 plain sentences, starting with "Contact sheet of project p_demo, frames in reading order with their ruler time printed in each corner:".

Work out the zooms as they stand now: before any edit there were eight zooms, z1 to z8, holding 3.0-3.5, 4.0-4.5, 5.0-5.5, 6.0-6.5, 7.0-7.5, 8.0-8.5, 9.0-9.5 and 10.0-10.5 s at 1.8x, each moving in over the 0.9 s before and out over the 0.9 s after, on fields of a form: z1 to z4 down the left column, z5 to z7 down the right column, z8 on the Save button at the bottom right. Apply the removeModifier, setZoom, addZooms and addAutoZooms calls made earlier in the conversation.

Describe only the requested span (startSec to endSec). For each cell say whether the camera is wide, moving in, held, or moving out, and on what. When zooms less than 1.5 s apart remain, say plainly that the camera lurches in and out on almost every cell, or pans back and forth between fields. When the zooms are few and each holds 1.5 s or more, say the camera eases in, holds steady while the fields fill in, and eases out. The saved invoice with its total 1,240.00 EUR shows from 11 s. Nothing else on screen is wrong.
