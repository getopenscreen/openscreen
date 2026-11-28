---
name: openscreen-review
description: Runs the quality gate on an OpenScreen video before it is delivered, as a fixed protocol. It looks at the whole film on one contact sheet, then at each title, callout, zoom, cut and effect at the right moments and at full resolution, measures the sound, and inspects the real exported, compressed file, against a checklist of defects (late or unreadable title, a callout that is false to the screen, a zoom off the action, a pointer over a label, private data, browser chrome, black frames, cut-off text, banding), then fixes and looks again. Use before any OpenScreen video is attached, posted or handed over, and when the user asks to review, check, QA, proof or polish a video, asks "is it good?", "does it look right?", or reports something off in a cut, a zoom, the sound or the sharpness. Not for recording, editing from scratch, effects, sound design or export settings.
---

# Review an OpenScreen video

Run this on every film before it leaves the machine, and again after every fix. A film passes when one full pass finds no defect and the user has watched it whole for private data (step 4). Look; never assume an edit landed because the tool call succeeded.

**Tools.** `getFrames` returns up to 12 frames per call; with `region` it returns only that part of the frame at the video's own resolution (up to 1280 px wide), and with `startSec` / `endSec` and `count` it spreads frames inside that window. `getContactSheet` returns one image of a grid of frames, each with its time printed on it, up to 36 per sheet, for the cost of one image. `getAudioReport` measures the sound as the export mixes it. `getBeforeAfter` pairs up to 6 moments as they were at a checkpoint and as they are now, and says where each pair differs: after a fix, it shows that the fix landed and that nothing else moved. With `projectId`, times are ruler seconds, the ones the document tools use. With `path`, they are the file's own seconds.

If `getContactSheet`, `getAudioReport` or `getBeforeAfter` is not in your tool list, or `getFrames` refuses `region`, `startSec` or `endSec`, the installed OpenScreen is older than this skill: <!-- full-plugin -->offer to update it (the `openscreen-demo` skill's setup)<!-- /full-plugin --><!-- directory-plugin ask the user to quit OpenScreen, install the latest one over it, as https://getopenscreen.com/docs/installation explains, then to start a new session (if no OpenScreen tool is listed at all, OpenScreen's tools are not available in this session: say so, link https://getopenscreen.com/docs/ai-editing and stop) -->, or fall back to `getFrames` with `atSec` (up to 12 times per call, 0.1 s apart for a dense window). For the sound, the fallback is `exportAudio` then `ffmpeg -i <file> -af ebur128=peak=true -f null -`, and it needs both: `exportAudio` in your tool list (older installs lack it too) and ffmpeg installed. Without them the sound cannot be measured: say so in the report.

## Before you look

Read the project with `getCurrentDocument` and note, in ruler seconds:

- the storyboard's beats, and the claim each callout makes;
- each annotation's span (`addAnnotation` places them in ruler seconds);
- each zoom's `zoomInFromSec` and `zoomOutUntilSec`;
- each cut: where a trim or a clip boundary falls on the ruler, and any `cutTransitions` an edit reported;
- each click, from `getCursorTrack` (the points that carry a `kind`, at their `virtualSec`);
- each effect's span, and each audio track.

## The protocol

Run the steps in order. Write each defect down with its ruler second and what is wrong.

### 1. The whole film, one sheet

`getContactSheet` with the `projectId`, `startSec: 0`, `endSec` the film's length, `count: 24`, `columns: 6`. Read it as a viewer would:

- Is the message clear from the first frames, with the product already showing its result?
- Does each beat happen, once, in storyboard order?
- Does something new happen at least every 4 s, apart from the final hold?
- Any black, blank or half-drawn frame, any leftover setup screen at the start or the stop screen at the end?

### 2. Title and callouts

`getFrames` with `atSec` at the middle of each annotation's span, and at 2.5 s for the title.

- The title is fully drawn, animation finished, and readable by 2.5 s.
- Each callout reads in one glance: 6 words or fewer (a title up to 8), on screen at least 1.5 s and at least one second per 15 characters.
- Each callout is **true to what is on screen**: a number appears on screen as the callout states it, a feature named is the one shown. No figure you computed, no adjective the product does not use.
- No callout covers the action, the result, or another text. None is cut off by the frame edge.
- Small text: `getFrames` with a `region` around it, to read it at full resolution.

### 3. Zooms

For each zoom, `getContactSheet` with `startSec` 0.2 s before its `zoomInFromSec` (0 at the earliest), `endSec` 0.2 s after its `zoomOutUntilSec`, `count: 16`.

- It frames **the thing that changes**, and holds both the action and its result in view. When the action and the result sit apart on screen (typing on the left, output on the right), the zoom must be shallow enough to keep both.
- It is fully in before the action and holds until the result has finished redrawing, at least 1.5 s.
- The move in and out is smooth: no jump at a cut inside its windows, no yo-yo (out and straight back in).
- The first 2.5 s and the last second stay wide.
- Under the zoom, text and edges are sharp: `getFrames` with a `region` on the zoomed text. Blur here means the take was captured at too low a scale.

### 4. Pointer and privacy

On the frames already taken, and with `region` crops where unsure:

- No pointer over a label, a number or a callout while it is read. The pointer is parked once the last result shows.
- No private data: email addresses, tokens, keys, real names, notifications, local file paths, user names. Each one gets a blur (`addAnnotation` with `type: "blur"`) over the whole span it shows; check the blur at its first and last frame, and mid-zoom.
- Sampled frames miss what shows for a moment between two of them, and a contact sheet's tiles are too small to read an address or a name. For privacy, read the whole delivered film at one frame per second at least, every frame at a size where text reads. Read it in the exported file, whose seconds are the viewer's: a speed region below 1× spreads one ruler second over several seconds of film. Export (step 8's settings), then `getFrames` with `path` set to that file, `startSec` / `endSec` 11 s apart and `count: 12` (both ends are shown, so the frames fall a second apart), one call after another to the end, and a `region` on any text still too small. Those times are the file's: find an item's ruler span with `getFrames` on the `projectId` before you blur it. In the report, say that privacy was checked at that interval, not on every frame, list any frame whose text could not be read, and ask the user to watch the whole film before it is attached, posted or handed over. Until they have, the film has not passed.
- No browser chrome: address bar, tabs, bookmarks, translation or cookie prompts.

### 5. Cuts and transitions, frame by frame

For each cut, `getContactSheet` with `startSec` 0.5 s before it (0 at the earliest) and `endSec` 0.5 s after it, `count: 30`, `columns: 6`.

- No flash, black frame or duplicated frame at the cut.
- The cut does not land inside a zoom's move: a trimmed move jumps.
- No micro-cut: a cut that removes less than about 0.5 s reads as a glitch. Prefer `addSpeed` over a wait to a cut.
- A drawn transition or an effect over the cut starts and ends cleanly, with no stray frame of the effect outside its span.

### 6. Effects

For each effect, `getFrames` at its start, its middle and its end, and 0.2 s after each click it answers.

- It is visible, and quiet: it supports the product and never competes with it.
- Its edges are clean: `region` crops on its outline, at full resolution.
- It stops where its span ends.

### 7. Sound

`getAudioReport` with the `projectId`; with `audioId` for one track alone when something sounds wrong.

- With sound: `integratedLufs` between -15 and -13, `truePeakDbtp` at -1 or lower.
- `silences`: only the ones you meant. A silence inside a music bed or under a voiceover is a defect.
- `integratedLufs: null` (silent) is right only for a film meant to play muted; otherwise a track is missing or muted.
- `durationSec` matches the film's length.

### 8. The exported file

Export (`exportVideo`, settings per the `openscreen-deliver` skill), then look at **that file**, with `path`: compression changes gradients, dark flat areas and fine texture.

- `getContactSheet` with the exported `path` and `count: 12`: same film as step 1.
- `getFrames` with `path` and a `region` on the largest gradient or dark area, on the finest lines and on the smallest text: banding, blocks or crawling grain are defects. The fix is a flat background or a structured texture, not more bitrate.
- The file's size fits its destination's budget.

## Fix and look again

1. Fix each defect in the project, the cheapest way: record again when the take is the problem (wrong state, hesitation, private data on most of it); edit otherwise.
2. Re-run the steps that cover each fix at its moments.
3. Export again and repeat steps 1 and 8, and step 4's privacy read of the exported file over the whole film: a fix can uncover private data anywhere. The film passes only on a pass with no defect, and once the user has watched it whole for private data.

When a defect cannot be fixed with the tools available, say what and at which second, and let the user decide. Report the review to the user in a few lines: what you checked, what you fixed, what remains.
