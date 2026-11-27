---
name: openscreen-effects
description: Writes Off-Menu effects for OpenScreen, custom WGSL shaders that the native compositor draws on the real recording, in the preview and in every export, through addEffect, setEffect, setEffectDefinition and getEffect. Covers the write, compile, look, re-tune loop, what an effect can read (the composed frame, the recording at full resolution, time, the pointer, recent clicks, the recording's and the webcam's rectangles, typed parameters), cost tiers and how to stay light, the pitfalls that waste iterations, and a cookbook of validated effects (a soft ring on each click, a glass loupe, a spotlight on an interface block). Use when the user asks for a visual effect no OpenScreen setting offers, a click effect, a ripple, a glow, a highlight, a loupe or magnifier, a lens, a spotlight, a colour grade, a glitch or a transition look, or says shader, WGSL or Off-Menu. Not for placing zooms and callouts (openscreen-motion) or for making a whole demo (openscreen-demo).
---

# Write Off-Menu effects

An Off-Menu effect is a function you write in WGSL and lay on the timeline like a zoom. The
compositor runs it on every output pixel, in the preview and in the export alike, so what
`getFrames` shows you is what the export will contain. Write one when no setting does what the
user asked; reach for settings first (`setEditorSettings`, zooms, annotations).

If a tool this skill names is not in your tool list, the installed OpenScreen is older than this
skill: <!-- full-plugin -->offer to update it (see the `openscreen-demo` skill, step 1)<!-- /full-plugin --><!-- directory-plugin ask the user to quit OpenScreen, install the latest one over it, as https://getopenscreen.com/docs/installation explains, then to start a new session (if no OpenScreen tool is listed at all, OpenScreen's tools are not available in this session: say so, link https://getopenscreen.com/docs/ai-editing and stop) -->, or fall back to what exists,
`getFrames` with `atSec` in place of `getContactSheet`, of `getBeforeAfter` and of `getFrames`
`region`.

## Before you write

1. Read the resource `openscreen://effects/contract`. It is the authority on contract 1: inputs,
   parameters, rules, targets, cost. This skill does not replace it.
2. Read the project with `getCurrentDocument`. Effects are placed in **ruler seconds**, like
   zooms and annotations. `effects` lists the regions, `effectDefinitions` the code's name, cost
   and parameters, without the code (`getEffect` reads it).
3. Decide the moments the effect acts on: a click, a beat, a block of the interface. Write them
   down with their ruler seconds; you will look at exactly those moments.

## The loop

1. **Write** the shader and its parameters, and lay it with `addEffect`: `startSec`, `endSec`,
   and `effect` with `name`, `description` (one sentence on what it does, for the next agent),
   `code` and `params`. Leave `target` out: the default `image` keeps text readable.
2. **Read the answer.** Code that does not compile comes back with the compiler's error at the
   line of your code: fix that line and call again. An accepted effect returns its tier and, when
   the region is longer than the tier is meant for, a recommendation.
3. **Look at the moments it acts,** never at a random frame:
   - `getContactSheet` with `projectId`, `startSec` / `endSec` over the 1 to 2 s where the effect
     moves, `count` 12 to 24: the animation frame by frame in one image.
   - `getFrames` with `projectId` and `region` on the part that matters (a ring, the loupe's
     glass, a corner of a highlight) to judge it at the video's own resolution.
4. **Re-tune.** A value change is `setEffect` with `values` on the region (`effectRegionId`);
   a code change is `setEffectDefinition` on the `effectId`, which recompiles and updates every
   region using it. Moving or resizing the region is `setEffect` with `startSec` / `endSec`.
   To see exactly what a re-tune changed, call `createCheckpoint` before it and `getBeforeAfter`
   with that `checkpointId` after it: each moment comes back as a before and after pair, with the
   region of the frame that changed. A moment that reads unchanged shows no difference the
   comparison can see: a faint change can pass it, so compare a `region` when it matters.
5. **Stop** when the effect reads at a glance and nothing on screen fights it. Remove a failed
   attempt with `removeModifier` on the region id; its definition goes with its last region.

Expect two or three iterations. More than five on one look means the idea, not the tuning, is
wrong: simplify it.

## What an effect reads

| Input | Use it for |
|---|---|
| `frame(uv)` | The composed picture at the output's resolution: grading, distortion, glows. |
| `footage(p)` | The recording itself at its own resolution, at point `p` of its surface, with no cursor, webcam, frame or background. Anything that magnifies. |
| `image(p)`, `ctx.image` | The effect's own image, when you gave it one: a logo, a texture, a mask. `p` is the image's own uv; `ctx.image` holds its size in pixels (xy) and its width over height (z). See "An image of its own". |
| `ctx.time` | Programme seconds, continuous through cuts and speed changes. |
| `ctx.region` | x: progress 0 to 1 over the region; y: its length in s; z: seconds since it began. Entrances and exits. |
| `ctx.cursor` | xy: the pointer tip in uv; z: 1 while it is on screen. |
| `ctx.clicks[i]` | The last 4 clicks of the last 2 s, newest first: xy where, z seconds since, w 1 when the slot is used. |
| `ctx.footage`, `ctx.camera` | The recording's and the webcam's rectangles in uv (x, y, w, h); the camera is zero-sized without one. |
| `fx_to_footage(uv)`, `fx_from_footage(p)` | Map between output uv and the recording's surface (0 to 1 across the recording), zoom, layout and 3D camera included. |
| `ctx.footage_aspect`, `ctx.aspect`, `ctx.resolution` | Round distances on the recording, round distances on the output, output size. |
| `params.<name>` | Your declared parameters. |
| `fx_px(n)`, `fx_hash(p)` | n pixels of a 1080p output as a fraction of its height; a random number identical on every GPU. |

**Pick the space.** Output uv is the picture as framed: right for a grade, a vignette, a click
ring. The recording's surface moves, scales and tilts with the recording: right for anything
that sits on the interface, a highlight on a block, a ripple lying on the screen under a 3D
camera. Map in with `fx_to_footage`, compute, map back with `fx_from_footage` before `frame()`.

**Interface geometry comes from you.** The compositor sees pixels, not the page. To act on a
button, a card or a connection, measure it in the page while you record and write it into the
code as constants. The contract's last section, "lift real UI blocks out of the recording", gives
the conversion to fractions of the recorded frame and how to hide and redraw the cursor.

## Parameters

- Declare a parameter only when moving it visibly changes the effect over its whole range: each
  one becomes a control in the editor. Up to 8.
- Names are snake_case. Labels are short, in the user's language.
- Give every number a default that already looks right; the user should never need to touch it.

## Animate a parameter instead of rewriting the shader

When the motion is a timing decision, a fade in, a pulse at a given second, a slow drift, keep
the shader simple and move a parameter with keyframes: pass `animate` to `addEffect` or
`setEffect`, a list of `{ atSec, value, ease }` per parameter. The contract's "Animating a
parameter" section has the exact form.

- `atSec` counts from the start of the region. Before the first keyframe and after the last, the
  parameter holds its value.
- `ease` shapes the move to the next keyframe: `ease-out` for something that appears,
  `ease-in-out` for a move across the picture, `{ "spring": { "bounce": 0.2 } }` for a settle with
  a little life, `hold` for a step. Never leave a visible move linear.
- Re-time it with `setEffect` alone: a parameter you pass replaces its whole list, an empty list
  removes it. The code does not change, so nothing recompiles.
- Write the motion in the code only when it follows something the shader computes itself: a
  click's age, the pointer.

Read the result back with `getEffect`: it shows `animate`. If it does not, the installed
OpenScreen is older than this skill and held the parameter still: update it, or drive the motion
from `ctx.region` in the code.

## An image of its own

An effect can read one image file: the product's logo, a texture, a mask. Pass its absolute path
(PNG or JPEG) as `effect.image` in `addEffect`, or as `image` in `setEffectDefinition` (`null`
takes it away). OpenScreen keeps its own copy, so the user's file can move afterwards.

- `image(p)` takes the image's own uv, (0,0) its top-left corner and (1,1) its bottom-right, and
  is transparent outside it. Place the image by mapping the output's uv into it:
  `image((uv - corner) / size)`, with `size.x = size.y * ctx.image.z / ctx.aspect` to keep its
  proportions.
- It returns straight alpha: `mix(c.rgb, logo.rgb, logo.a * params.opacity)`.
- Give a file close to the size it is shown at. Shown under half its size, an image shimmers.
- One image per effect. For several pictures, lay them side by side in one file.
- Fade it in with `animate` on an opacity parameter, never with a hard cut.

The cookbook's "Logo in a corner" is the complete effect. If `addEffect` answers that `image` is
unknown, or that `image()` has no definition although you passed a file, the installed OpenScreen
is older than this skill: say so, and offer the update. Any other refusal says what is wrong, and
the answer follows from it:
- The file: a relative path, not a PNG or a JPEG, unreadable, over 32 MB. Fix the path or the
  file and call again.
- This OpenScreen: no ffmpeg to read the image with, or no image for an effect where it runs. Tell
  the user, and go on without the image: a shader that calls `image()` does not compile without
  one, so take those calls out of the code, or pick an effect that needs no picture.

## Cost: stay light

The tier counts `frame()`, `footage()` and `image()` reads per pixel, loops multiplied by their
bound.

| Tier | Reads | Lay it over |
|---|---|---|
| light | 8 or fewer | anything, the whole video included |
| medium | up to 32 | up to a minute |
| heavy | up to 128 | up to 10 s: a transition, a key moment |
| very heavy | more | a few seconds |

- Read `frame(uv)` once and reuse the value. Compute masks and shapes analytically: math is
  cheap, reads are what costs.
- Return early where the effect does nothing: test the click slot's `w` and age, or the distance
  to the shape, before sampling.
- A blur or a glow from many taps belongs in a short region. A soft glow drawn as an analytic
  falloff (`exp`, `smoothstep`) costs no read at all.
- `footage()` also has the recording copied once per frame; read it only where you magnify.
- Tiers are recommendations, never refusals, but without a GPU even a light effect slows export.

## Taste

- **Quiet and in the product's colours.** An effect underlines the product, it never competes
  with it. No glitch, shake or flash on a product demo unless the user asks for one.
- **No wide soft gradients and no per-pixel random grain.** Video compression turns them into
  bands and mush. Prefer flat colour, fine structured detail (lines, dots) and analytic glows.
- **Exact contours.** An effect that outlines or follows the interface follows the real shape:
  measured rectangles with their real corner radius, the real path of a line sampled every 3 px or
  less, its real stroke width. A shortcut that cuts a corner reads as a mistake.
- **Anti-aliased edges** over about `fx_px(1)` with `smoothstep`, and hairlines of 1 to 2 px.
- **One effect at a time.** Two regions never overlap; for two looks at once, write one shader.

## Pitfalls that cost iterations

- **Reserved words.** WGSL reserves many common words, `target` among them. If the compiler says
  "reserved keyword", rename the variable.
- **Loops.** Only `for` with a literal start, a literal bound and a literal step, at most 4096
  iterations per pixel in total. A `while`, a `loop` or a bound computed at run time is refused.
- **Additive or screen blends vanish on white.** Mix toward a colour (`mix(c.rgb, tint.rgb, k)`)
  so the effect reads on light and dark interfaces alike.
- **Distortion that folds.** A displacement whose stretch passes about 1 turns the image inside
  out (torn edges, mirrored buttons). Cap the amplitude rather than raising the strength.
- **Magnifying `frame()` magnifies blur.** Read `footage()` inside a loupe or a lens.
- **`fract(sin(x) * 43758.5453)` differs between GPUs.** Use `fx_hash` for anything random.
- **Pixels instead of uv.** The preview renders smaller than the export: express sizes with
  `fx_px` or uv, never raw pixel counts.
- **Circles that are ovals.** Multiply x by `ctx.aspect` (output) or `ctx.footage_aspect`
  (recording surface) before taking a length.
- **Large constant tables** slow every frame on some GPUs. A moving shape gets a few keyframes
  mixed on `ctx.time`, not a long table.
- **Alpha.** Return `frame(uv).a` as alpha for the `image` and `both` targets. The `text` target
  works in premultiplied alpha.
- **Cuts.** `ctx.region.z` and `ctx.time` run on programme time, which skips trimmed spans. A
  timing measured on the raw take moves by the length of any cut before it.

## Cookbook

`references/cookbook.md` holds three complete, compiled effects with their parameters: a soft
ring on each click, a glass loupe on one detail, a spotlight on an interface block. Start from the
closest one rather than from a blank file. Read it before writing your first effect in a session.
