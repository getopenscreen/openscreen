---
title: "Making of v2: a demo is never ugly"
title_meta: "Making of OpenScreen v2: a demo is never ugly"
description: How OpenScreen v2 came together. One rule, an audit against it, twenty-one pull requests merged into one branch, and a round of UI work that removed more than it added.
authors: [etienne]
tags: [release]
image: /img/og-image.png
---

v2 started from one sentence rather than a feature list: a demo looks good without touching anything, and touching the settings can't make it ugly. That is the promise the best commercial recorders make, and on September 24 I audited OpenScreen against it.

The result was two rules kept out of ten, and thirty findings. The fixes are gathered in one branch, [#814](https://github.com/getopenscreen/openscreen/pull/814), which is what v2 will be.

<!-- truncate -->

## The audit

Ten rules, each written as something a user should be able to rely on. Defaults that look good. Every value bounded, with a way back to its default. A format change or a cut that breaks nothing. What you see in the preview is what you export.

Measured on the build of that day, the defaults failed first:

- **The default cursor** was 82 px tall in a 1080p export, about four times the system arrow, and it could be pushed to 272 px.
- **The default shadow** drew at 9% opacity, which on most wallpapers means no shadow at all.
- **A 16:9 recording exported as 9:16** filled 20% of the frame.

None of those is a bug in the usual sense. Each one is a setting that works as written and makes the video worse.

## Twenty-one pull requests, one branch

The findings split into six workstreams, and each became a pull request against a shared integration branch instead of `main`. They touch the same panels and the same compositor, and landing them one by one would have meant a week of broken intermediate states on `main`. Merged into one branch in dependency order, they can be tested together and land together.

**Defaults.** The cursor is half its old size, 41 px in 1080p. The shadow is at 27% opacity. New projects start from the look of your last one.

**Bounds in the model.** One table clamps every appearance value, whoever writes it: the panel, the AI agent, a preset or a hand-edited project file. Every slider has a reset.

**The render tells the truth.** Two findings were the kind you only see by measuring. Every text font exported as Segoe UI, pixel for pixel, because the picker offered fonts the app never shipped; five open-licensed families are embedded now. Gradients used only their first and last colour stops, so a red, green and blue gradient drew purple at its midpoint where green belonged.

**Export.** The bitrate the app computed never reached the encoder, so every export ran at 8 Mb/s whatever the frame rate. It is 18.7 Mb/s at 1080p60 now. GIFs are dithered, and the dialog offers four destinations (Web / YouTube, Social, Studio, README GIF) with the codec details folded under Advanced.

**Audio.** Voice is normalised to −16 LUFS with a soft limiter instead of a hard clip, and music ducks under it.

**Framing.** A 16:9 take in a 9:16 export now fills 64% of the frame, in a window that follows the cursor. Zooms are capped at twice the source's own resolution, so a deep zoom no longer magnifies blur. Silence cuts keep 70 ms of breath on each side, so a cut doesn't clip the start of a word.

One thing went the other way. The 17 third-party cursor packs are gone: their terms don't allow redistribution. Five original themes replace them.

## Then the interface

With the rules holding, the panels were the next thing to make ugly by accident. The branch this post was written on carries about a hundred and twenty more commits, and most of them delete something.

**One click per choice.** The selects and dropdowns in the right panel became rows of buttons, so every option is visible and picking one is a single click: format, frame style, the zoom's 3D camera, focus mode, cursor style, caption language and font. Only the fifteen translation targets stay a list.

**Names instead of numbers.** A shadow is None, Light, Medium or Strong. Click bounce is None, Light or Strong. A slider stays where the amount is the point (padding, background blur, cursor size), and a slider with no unit shows no number.

**No explanations under settings.** If the label needs a sentence to be understood, the label is wrong. An option that does nothing in the current context is hidden instead of greyed out with its reason.

**Fewer controls.** The Fit button rewrote four settings without naming any, and padding at 0 already does its job, so it's gone. The seek bar under the transport repeated the ruler right below it, so that went too.

**A timeline you read by colour.** The recording is the main object on the timeline, so it wears the brand's green. Zoom pills are blue, so the most common effect never reads as the clip under it. Every block is a solid card with dark text, because mint can't carry white: 2.3:1 contrast with white text, 8.2:1 with dark ink.

The walkthrough on the [home page](/) and this site's docs were redrawn to match.

## The 3D camera

The 3D work followed the same rule. A camera that rolls during a zoom looks broken rather than cinematic, so a moving camera never rolls now. The fixed angles went through three versions in a day before landing back on the v1.13.0 angle, checked against a real v1.13.0 export rather than from memory. The follow camera became **3D Orbit**, which obeys the zoom's focus mode like the flat zoom does. The 3D cursor dives onto each click in depth, and the click impact that used to live on the zoom is a cursor setting for every camera.

## Before v2 ships

[#814](https://github.com/getopenscreen/openscreen/pull/814) is open, and green except for one compositor test on Linux and macOS that checks the 3D cursor's footprint. After that, it needs a manual pass on real Windows and macOS machines, then the usual release candidates.

It is still not production-grade, and rough edges are expected. If a default still makes your demo worse, that is exactly the bug this release is about: [Discord](https://getopenscreen.com/discord/) or an issue, either works.
