---
id: product-demo-video
title: How to make a product demo video
sidebar_label: Product demo video
description: "How to make a product demo video in OpenScreen: script it, record at 60 fps, then add a webcam, automatic zooms, cuts, blur and captions, and export."
keywords:
  - product demo video
  - how to record a software demo
  - demo video with zoom and captions
  - screen recording tutorial
  - teleprompter
---

# How to make a product demo video

To make a product demo video, write a short script, record the product at a steady pace, then edit: cut the dead time, zoom in on what matters, hide private data, add captions, and export in the shape your channel needs. This guide does each step in OpenScreen, a free, MIT-licensed screen recorder and editor for Windows, macOS and Linux, where recording, editing, transcription and export run on your machine. OpenScreen produces a video file. It does not host the video or build a clickable walkthrough; if you need either, see [When OpenScreen is not the right tool](#when-openscreen-is-not-the-right-tool).

## Before you start

- Install OpenScreen from the [download page](/download/). [Installation](../installation.md) covers each platform.
- Decide where the video will be watched. That decides the shape: 16:9 for a website or docs page, 9:16 for a vertical feed, 1:1 for a square slot.
- Prepare the product: a demo account, sample data, notifications off.

## 1. Write the script in the Notes window

On Windows and macOS, click **Open Notes** in the HUD. It opens a rich-text window that is saved locally between sessions. Write the script there, one action per line. The Linux HUD has no Notes button.

The Notes window doubles as a teleprompter. **Start auto-scroll** scrolls the text at a speed from 10 to 100. The font size goes from 14 to 48 px, and **Mirror horizontally** flips the text.

:::caution
On Windows, OpenScreen keeps the HUD and the Notes window out of the capture. On macOS it cannot guarantee that, so keep the Notes window on a display you are not recording. On macOS and Linux, use **Hide HUD** if the HUD sits on the recorded screen.
:::

## 2. Record the screen or a window

1. On Windows and macOS, open the source picker and choose a display under **Screens** or a single window under **Windows**. On Linux there is no in-app picker: the system portal asks for the source on every take. OpenScreen has no region capture, so record the window or the screen, then crop the clip in the editor.
2. Turn on the microphone and check its level meter. Turn on system audio if the product makes sound, and the webcam if you want to appear on screen.
3. Keep the editable cursor mode, the default: the pointer is recorded as data, so you can restyle it later. Clicks are recorded on Windows. On macOS they need the Accessibility permission. On Linux your user must be in the `input` group, and touchpad tap-to-click is not captured ([details](../installation.md#mouse-clicks-on-wayland)).
4. Press record. A 3-2-1 countdown runs first and cannot be turned off.

OpenScreen captures at a 60 fps target, up to 3840×2160 on Windows and macOS. On Linux the size is whatever the compositor hands over. While recording you can pause, restart the take, cancel it, or stop.

**Pace for the zooms.** Move the pointer to the thing you are about to explain, then hold it still. The automatic zooms in step 4 look for those pauses: a still pointer for about half a second to 2.6 seconds. A pointer that rests longer than that gets no zoom.

**Long demos on Linux.** Linux writes a regular MP4 that is only finalized when you stop, so a crash mid-take leaves an unreadable file. Record several shorter takes instead; step 5 shows how to join them.

See [Recording](../recording.md) for every HUD control.

## 3. Choose the webcam layout and background

The webcam is recorded to its own file, so its placement is an editing decision you can change at any time. Open the **Camera layout** facet in the editor's inspector:

- **Picture in Picture**, **Vertical Stack**, **Dual Frame**, or **No Webcam**.
- For every layout: mirror, and a crop of the camera image.
- For **Picture in Picture** only: **Camera Shape** (Rect, Circle, Square or Rounded), a size from 10 to 50% (25% by default), and **Shrink on Zoom**, on by default, which makes the camera smaller while a zoom plays so it does not cover the detail. Drag the camera on the canvas to move it.
- **Camera Background**: Original, Blur, Cutout or Custom. Cutout removes the background without a green screen, using a segmentation model that runs on your CPU. This section only appears when the segmentation runtime loads on your machine.

For an intro or outro, press `C` to add a **Full Camera** segment: the camera fills the whole frame for that span.

The **Composition** facet styles the frame. Its background section offers 18 built-in wallpapers, a solid color, a gradient or your own image, and a background blur. Below it are shadow, roundness, padding and motion blur.

## 4. Add automatic zooms

In the timeline toolbar, open **Auto-enhance** and choose **Automatic zooms**. OpenScreen reads the recorded cursor movement and places zoom regions on those pauses, with no network and no model. If it places nothing, it tells you so. The usual causes are a recording without cursor data, no pause in that range, or existing zooms that already cover those moments.

Then review them. Click a zoom to set its level (from 1.25× to 5×), its focus mode (Auto follows the cursor, Manual holds a fixed point) and an optional 3D rotation. Press `Z` to add a zoom by hand, and `Ctrl/Cmd+D` to delete one you do not want.

More on how the zooms are placed: [Auto-zoom](/features/auto-zoom/).

## 5. Cut from the transcript and speed up dead time

**Transcribe first.** Open the **Transcript** facet. If no transcript is there yet, click **Transcribe now**. Transcription runs locally with Whisper. The first run downloads its model once, about 264 MB.

**Cut by text.** In the transcript, select words and press `Delete`: that span is cut from playback and from the export. Silences show up inline as markers: click one to cut it, and click it again to restore it. Hover a cut word to restore it. You can also press `T` to add a trim region on the timeline.

**Speed up what you cannot cut**, such as page loads or typing. Press `S` to add a speed region, pick a preset from 0.25× to 5×, or type any value from 0.1× to 100×. The audio is time-stretched to match.

**Join several takes.** Switch to **Media**, use **Import media** if a take is not listed yet, then drag its card onto the clip row. Dropped on an existing clip, it offers **Add before**, **Add after** or **Split here and insert**. See [Media library](../media-library.md).

If you have connected your own LLM provider, **Auto-enhance → Smart cuts** hands the cutting to the AI agent. It is optional and off until you add a key ([AI editing](../ai-editing.md)). Undo keeps the last 50 steps, agent edits included.

## 6. Blur private data, annotate, add sound

Press `A` to add an annotation, then pick its **Type**:

- **Blur**: Gaussian or Mosaic, rectangle or oval. Place it over emails, API keys or customer names, stretch its region over every frame that shows them, then scrub through to check.
- **Text**: with an optional animation (Fade, Rise, Pop, Slide Left, Typewriter or Pulse).
- **Arrow**: eight directions, adjustable stroke width and color.
- **Image**: a JPG, PNG, GIF or WebP, such as a logo.

For sound, press `V` to record a voice-over on the timeline, or `M` to import music (mp3, wav, m4a, aac, flac, ogg, opus). Each track has its own gain, fades, loop and mute.

The **Cursor** facet restyles the pointer from step 2. Every tool is listed in [Editing & timeline](../editing-timeline.md).

## 7. Burn in captions

In the **Transcript** facet, click **Captions** and turn on **Show captions**. They are drawn live from the transcript, so the cuts from step 5 carry over with no extra step. Set the font, size, bold, color, background plate, position, and 1 to 12 words per line. Check the placement in the preview after any change of shape.

Whisper detects the spoken language, or you can force one of 100 languages with **Regenerate as** in the Media stage. To publish in another language, **Translate** into one of 15 targets and select that language under **Display** before exporting. Translation goes through your own LLM provider, so it needs a key.

Captions are burned into the video. OpenScreen does not write an `.srt` or `.vtt` file, so a player cannot turn them off. Details: [Captions & transcript](../captions.md), and [how the captions feature works](/features/captions/).

## 8. Export

**Pick the shape.** The **Format** control in the **Composition** facet offers 16:9 (the default), 9:16, 1:1, 4:3, 4:5, 16:10, 10:16, or the original shape of your clips.

**Export.** Click **Export** in the top bar:

- **MP4**: 720p, 1080p or Source; 24, 30 or 60 fps; H.264 or H.265. The dialog marks H.264 as the best-compatibility option. The video bitrate is not adjustable, about 8 Mbit/s at 1080p.
- **GIF**: 15, 20, 25 or 30 fps; Medium, Large or Original size; loop on or off. GIFs use 256 colors without dithering, so they suit short clips of flat interface.

There is no watermark. To export another shape, change the format and export again.

**Keep the project.** Save it with `Ctrl/Cmd+S` as an `.openscreen` file, so you can swap a clip and export again when the interface changes. It references your media rather than embedding it; `openscreen pack` gathers everything into one portable folder ([CLI](/docs/cli/)). More in [Export](../export.md).

## Publish the file

OpenScreen does not host your video, create share links or count views. Upload the exported file wherever your audience watches it.

## When OpenScreen is not the right tool

- **You want a hosted link with viewer analytics or comments.** A hosted recorder fits better. Loom, for example, shares each recording as a link on loom.com, and its pricing page lists viewer insights and video comments on every plan (as of September 2026). See [OpenScreen as a Loom alternative](/alternatives/loom/) for the narrower case where OpenScreen does fit.
- **You want an interactive demo** that the viewer clicks through. OpenScreen exports video and GIF only.
- **Your video player needs a separate caption file.** OpenScreen only burns captions in.
- **You record on a phone or tablet.** OpenScreen is a desktop app for Windows, macOS 13 or later, and Linux.

## Sources

- OpenScreen: the [source code at release v1.11.0](https://github.com/getopenscreen/openscreen/tree/v1.11.0).
- Loom: [loom.com](https://www.loom.com) and [loom.com/pricing](https://www.loom.com/pricing), checked September 2026.

Loom is a trademark of its owner. OpenScreen is not affiliated with Loom.
