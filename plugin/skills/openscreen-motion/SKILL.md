---
name: openscreen-motion
description: Applies motion-design taste to an OpenScreen screen recording when placing zooms, callouts, speed changes and the 3D camera, and maps each rule to the tool and argument that implements it (addZooms depth and focus, setZoom, addAnnotation animations, addSpeed, rotationPreset, setEditorSettings). Covers one focus per shot, merging clicks close in time and on screen into one zoom, holding a zoom long enough to read, zooming less when an action and its result sit apart, timing and easing grammar with concrete durations, staging and stagger, text limits on screen, pacing by destination, and the tells of amateur or machine-made motion to avoid. Use when zooms feel too many, too fast, dizzying or yo-yo, when callouts or titles feel cluttered or generic, when asked to make an edit look polished or better paced, or before laying out zooms and callouts on any take. Not for writing shader effects (openscreen-effects), sound (openscreen-sound) or the end-to-end demo workflow (openscreen-demo).
---

# Motion taste for screen recordings

Motion on a screen recording has one job: take the viewer's eye to the thing that changes, give
them time to read it, and get out of the way. Every rule below serves that. Apply them when you
place zooms, callouts and speed changes, and when you review an edit that looks busy or cheap.

If a tool this skill names is not in your tool list, the installed OpenScreen is older than this
skill: offer to update it (see the `openscreen-demo` skill, step 1), or use `getFrames` with
`atSec` where this skill says `getContactSheet`.

## 1. One focus per shot

- A shot shows one thing: one control, one result, one block. Say what it is before you zoom.
- The zoom's `focus` (`cx`, `cy`, 0 to 1 of the frame) sits on that thing, and the beat's
  callout names that same thing. A zoom on one place with a caption about another splits the eye.
- When the result appears far from the click (a form on the left, a preview on the right), the
  result is the focus, not the click.
- Check every zoom's `cursorAnchor` in the result of `addZooms` / `setZoom`: a large `offset`
  means the pointer was elsewhere. That is fine when you frame a result on purpose, a mistake
  otherwise.

## 2. Fewer, longer zooms

- **Merge clicks close in time and on screen into one zoom.** Clicks less than 3 s apart share
  one zoom when they fit in one frame with a margin of about 12 % around them; its focus is their
  middle, its depth the deepest that still fits them. A zoom per click is the "dizzying zoom"
  tell.
- **Never yo-yo.** Keep at least 1.5 s of wide shot between two zooms, moves excluded; closer
  than that, merge them. Two zooms at most 1.5 s apart on screen, on the same clip with no cut
  between, chain: the camera pans from one to the next for 1 s instead of zooming out and in. Use
  that for a move from one control to its neighbour.
- **Aim for a couple of zooms per minute** on a long take, not one per click. A 20 s demo
  typically has two or three.
- **Open wide and end wide.** Keep the first 2.5 s unzoomed so the viewer sees the whole product,
  and be fully back out at least 1 s before the end. Never zoom on a click in the last second of
  a take: it is usually the click that stopped the recording.
- `addAutoZooms` plans zooms on the recorded clicks with these merges and guards. Start from it,
  then delete (`removeModifier`) or adjust (`setZoom`) what does not serve the story.

## 3. Depth: zoom less than you think

`depth` is an ordinal, not a factor. Quote the `renderedScale` the result returns.

| depth | scale | Use it when |
|---|---|---|
| 1 | 1.25× | The action and its result sit apart: both must stay in view. |
| 2 | 1.5× | One area of the screen: a form, a panel, a card. |
| 3 | 1.8× | One control and its immediate result. The default. |
| 4 | 2.2× | A small detail: a value, a line of text. |
| 5 to 6 | 3.5× to 5× | Rarely. The recording blurs past its own resolution. |

- `addAutoZooms` never goes past depth 3. Go deeper by hand only for a detail that needs it.
- `customScale` (1 to 5) sets a level between those steps; it is refused past what the clip can
  take sharply, and the refusal names the limit.
- Deeper zooms also take longer to move in and out (below). Prefer a moderate depth held longer
  over a deep one held briefly.
- A loupe on one detail (see `openscreen-effects`) beats a 4× zoom when the rest of the screen
  should stay in view.

## 4. Timing

**Zooms.** A zoom holds over its span: it moves in during the window just before `startSec` and
out during the window just after `endSec`. Each move lasts 0.6 s + 0.55 s × ln(scale) of screen
time: 0.72 s at 1.25×, 0.92 s at 1.8×, 1.03 s at 2.2×, 1.49 s at 5×.
- Set `startSec` about 0.5 s before the first click, so the camera has arrived and settled when
  the click lands.
- Set `endSec` about 1.5 s after the last click, and later still if the result draws late: pages
  debounce, and a result often lands a beat after the click. Hold at least 1.8 s in all; longer
  when there is text to read (section 6).
- Leave the in and out windows untrimmed. A cut inside one makes the export jump; the result's
  `cutTransitions` warns you.
- A speed region changes how much timeline a zoom move covers, not how long it looks on screen.

**Callouts and titles.** `addAnnotation` places them; the `animation` decides the entrance.
- `pop` or `rise` for a title or a step callout: a quick ease-out entrance. `fade` for a quiet
  label. `typewriter` only for a short line that has time to finish typing well before the viewer
  must have read it. `pulse` at most once, on a call to action.
- A callout enters after the zoom has arrived (at or a little after the zoom's `startSec`), not
  during the move. It leaves before or as the zoom leaves.
- Hold a callout for its reading time plus a beat: at least 1.5 s, and about one second per four
  words beyond that.

**Easing grammar** (for anything you animate yourself, an effect's entrance included):
- Ease-out for things that enter or appear: fast start, soft landing. A cubic ease-out,
  `1 - (1 - t)^3`, or the curve `cubic-bezier(0.23, 1, 0.32, 1)`.
- Ease-in-out for something that moves across the screen: `cubic-bezier(0.77, 0, 0.175, 1)`.
- Never linear, never ease-in alone: a move that starts slow and stops dead reads as broken.
- Durations: 150 to 300 ms for a small element appearing, 300 to 600 ms for a large one or a
  panel, 0.6 to 1.5 s for a camera move. Video can run a little slower than an interface.
- Overshoot only where it is earned, and small: a spring with little bounce. Never scale from 0;
  start at 0.9 or more with the opacity rising.

## 5. Staging and stagger

- One thing moves at a time. Let the zoom arrive, then the callout appears, then the action
  happens. Never start the zoom, the callout and an effect on the same frame.
- When several elements must appear together (a title and a subtitle), offset them by 50 to
  150 ms in an effect, or by about 0.3 s between annotations.
- Vary the rhythm. Beats of identical length read as machine-made: let a key result hold longer
  than a transition beat.
- Something new every 3 to 5 s in a launch demo: a new action, a new result, a new callout.

## 6. Text on screen

- **6 words or fewer per callout**, one idea, sentence case. A title can run to 8.
- At most 42 characters per line and 2 lines.
- One text style for the whole film: same `fontSize` per role, same `color` and `background`.
  Hierarchy comes from size and weight (`bold`), not from many colours.
- Place callouts in one consistent band, clear of the action (for example `x: 50`, `y` 6 to 10
  for a top band), so the eye learns where to look. Text sits on the output frame and stays put
  when the picture zooms.
- Claims come from the screen: a number the product printed, a word it uses. No adjective the
  product would not use, no ratio you computed.
- An arrow (`type: "figure"`) only when the callout names a control the eye would not find.

## 7. Speed and cuts

- Cut dead time (`addTrims`): the setup, the wait, the hesitation. A cut costs nothing to a
  viewer who never saw the wait.
- Fast-forward with `addSpeed` (0.25× to 16×, default 1.5×) only when the wait itself shows
  something: a progress bar, a build log. 2× to 4× keeps it legible; beyond, cut it.
- Do not use micro-cuts to land a click on a beat. Re-record with the right timing instead.
- A cut that must happen between two beats is a clean hard cut, not a crossfade on every cut.

## 8. Pacing by destination

| Destination | Length | Pace |
|---|---|---|
| X, LinkedIn (muted autoplay) | 20 to 60 s | Result visible in the first 3 s, callouts carry the story, a new beat every 3 to 5 s. |
| Pull request | 10 to 30 s | One to three beats, the change and nothing else. |
| README GIF | 5 to 15 s | One action, one result, no text the viewer must read twice. |
| Product page, YouTube | 1 to 3 min | Narration leads, zooms follow the voice, longer holds. |

## 9. The look of the whole film

Set once with `setEditorSettings`, then leave alone:
- A flat background colour rather than a wide gradient or a busy wallpaper: compression turns
  soft gradients into bands.
- `cursor`: `smoothing` for a steady pointer, `autoHide` so an idle pointer fades away, `size`
  large enough to follow at the destination's size.
- `motionBlurAmount` lightly on: it softens camera moves.
- `rotationPreset` (`left`, `right`, `orbit`) on a zoom is a strong 3D move: keep it for one
  reveal or one key moment per film, never every zoom.

## 10. Tells of amateur or machine-made motion

Check the edit against this list before you export. Each one found is a fix.
- A zoom on every click; zooms that yo-yo; the video opening already zoomed in.
- A zoom too deep to keep the result in view, or released before the result is read.
- Linear or ease-in moves; anything scaling up from zero; bounce everywhere.
- Everything appearing on the same frame; beats of identical length.
- Callouts of more than 6 words, several text styles, a callout over the action.
- Decoration that competes with the product: glows, gradient text, pulsing badges, a glitch or a
  shake on a calm demo.
- Wide soft gradients or film grain, which break up under video compression.
- A setup screen, a logo intro or a blank frame before the first result.

## Check it

Look at the motion, not just the poses:
- `getContactSheet` with `projectId` over each zoom's move-in window (`zoomInFromSec` to
  `startSec` in `getCurrentDocument`), `count` 12: the move must ease in and settle, with the
  subject inside the frame on every cell.
- `getFrames` with `projectId` at each beat's ruler seconds: one subject, the callout readable and
  clear of it.
- Fix with `setZoom` / `setAnnotation` / `setSpeed` (only the fields you pass change), then look
  again.
