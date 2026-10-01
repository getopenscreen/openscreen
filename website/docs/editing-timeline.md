---
id: editing-timeline
title: Editing & timeline
sidebar_position: 6
description: "Edit in OpenScreen's timeline: zoom, trim, and speed regions, Full Camera segments, annotations, cursor styling, and the floating inspector."
keywords:
  - video timeline editor
  - zoom regions
  - speed ramping
  - annotations
  - cursor smoothing
  - multi-track editing
---

# Editing & timeline

The editor has three modes, switched from the segmented control in the top bar:

| Mode | What it's for |
|---|---|
| **Media** | Your project's clips: import, search, inspect transcripts, drag onto the timeline. See [Media library](./media-library.md). |
| **Edit** | The preview, the floating inspector, and the full timeline. This is where the project is actually edited. |
| **Record** | Pre-flight config for a new recording — mic, camera, system audio, cursor. See [Recording](./recording.md#recording-from-the-editor-rec-mode). |

Everything below describes **Edit** mode: a resizable preview on top, a timeline underneath. Drag the handle between them to rebalance the split.

## Floating inspector

A floating icon rail sits over the preview. Five facets:

| Facet | What it controls |
|---|---|
| **Composition** | A background section (image, solid color, or gradient behind your recording; upload your own image or pick from presets), with an **Animation** row (None, Drift, Aurora, Waves) that moves gradients and images alike, and a background blur from 0 to 100%. Then the frame: shadow (None, Light, Medium, Strong), padding, corner roundness, and motion blur. Its **Format** row sets the output shape for preview and export: **Auto** (the default for new projects), which wraps the frame around your recording and camera layout with an even padding border, your clips' own shapes under **Original**, plus 16:9, 9:16, 1:1, 4:3, 4:5, 16:10, and 10:16. |
| **Camera layout** | Webcam composite: picture-in-picture, vertical stack, dual frame, or no webcam. Mirror and "shrink on zoom." For picture-in-picture: camera shape (square, or original: the camera's own proportions, so a portrait camera stays portrait), roundness (fully round, a square camera is a circle), size, and position: one of eight spots along the edge, always the same distance from it. Drag the webcam on the canvas and it snaps to the nearest one. |
| **Audio** | The output level, applied the same way in the preview and the export. |
| **Cursor** | Only meaningful for recordings made in the editable cursor mode, on Windows, macOS, or Linux. Show/hide and auto-hide, the cursor style with its **3D cursor** switch, the cursor types (each type the video shows, drawn as recorded or as the arrow), sliders for size (up to four times the default), smoothing, and motion blur, click bounce (None, Light, Strong), and **Click impact**, which pushes the screen back on each click under every camera. |
| **Transcript** | The aggregated transcript across every clip, editable — see [Transcript editing](./captions.md#transcript-editing). Its **Captions** button turns captions on, styles them, and translates them — see [Captions & transcript](./captions.md#captions). |

The **pencil** button on the same rail opens the **Edit clip** modal for the selected clip: a draggable crop rectangle with numeric X/Y/W/H inputs and aspect-ratio presets, plus the clip's in/out points. Crop is per clip, not per project.

Selecting a region on the timeline (a zoom, trim, annotation, speed, or Full Camera block) replaces the facet body with an inspector for that region, described below alongside each region type.

## Timeline toolbar

- **Auto-enhance** (wand icon) — a menu with two one-shot passes:
  - **Automatic zooms** — reads the recorded clicks and zooms in on them. No network, no model. [Auto zoom](/features/auto-zoom/) explains how the zooms are placed.
  - **Smart cuts** (marked *With AI*) — hands the job to the AI agent instead, which needs a [connected provider](./ai-editing.md).
- **Speed** (`S`) — adds a speed-change region at the playhead.
- **Annotation** (`A`) — adds an annotation at the playhead.
- **Trim** (`T`) — drops a two-second cut ("trim region") at the playhead. Drag its edges to resize, like any other region.
- **Add zoom** (`Z`) — drops an animated zoom region at the playhead.
- **Auto focus** (crosshair) — toggle; when on, every zoom region follows the cursor and the per-zoom focus control locks.
- **Full Camera** (`C`) — adds a segment where the webcam takes the whole frame.

Drag a region's edges to resize, or drag the block to move it. Regions snap to the playhead, other region edges, and the timeline's start/end. `Ctrl/Cmd + C` / `Ctrl/Cmd + V` copies a selected region's attributes onto another region of the same kind.

`Shift` + scroll pans the timeline; `Ctrl`/`Cmd` + scroll zooms in and out. Both are shown as hints beside the play controls.

### Zoom regions

Click a zoom block to open its inspector:
- Six depth presets — 1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×.
- **3D camera** — Off, Screen turned left, Screen turned right, or 3D Orbit (a camera that moves with the zoom and follows its focus mode).
- **Focus mode** — Manual (drag the focus marker in the preview) or Auto (follows the recorded cursor). Locked to Auto when the toolbar's Auto-focus toggle is on.
- **Focus position** — numeric X/Y percentage in manual mode.

Zoom regions placed by **Auto-enhance → Automatic zooms** open the same inspector. How that pass works, and how it compares with other recorders' automatic zooms, is on [Auto zoom](/features/auto-zoom/).

### Trim regions

A trimmed span is cut from playback and export. The inspector is a single **Delete** action — press `Del` or use the inspector button. The same cuts can be made from the text instead, in the [transcript](./captions.md#transcript-editing).

### Speed regions

A row of preset buttons (0.5×, 1×, 1.5×, 2×, 4×) and a free numeric field for any other speed from 0.25× to 16×. Export renders the true speed either way.

### Full Camera regions

A span where the webcam fills the frame instead of sitting in its layout box — useful for a talking-head intro in the middle of a screen recording. Only meaningful when the recording has a webcam track.

### Annotations

Four types, picked from the **Type** row in the inspector. Switching type keeps the region's span and its place in the picture.

Text, images and arrows sit on the frame: drag them anywhere, over the padding too. Padding and the recording's size never move them, and a format change keeps their shape. A blur stays on the recording, over what it hides.

- **Text** — content, size (24, 32, 48 or 72, or any size typed next to them), background (None / Dark / Light), text color, and an appearance animation (None / Fade / Rise / Pop / Slide Left / Typewriter / Pulse). The selection box is the text itself: drag a corner to resize it.
- **Image** — upload a JPG, PNG, GIF, or WebP.
- **Arrow** — eight directions, stroke width (1–20), and color.
- **Blur** — a privacy mask. Smooth or Mosaic, rectangle or oval. Drag and resize it over the recording like any other annotation.

:::note
Freehand blur shapes can no longer be drawn. Existing ones still render, but as their bounding box — deliberately over-covering rather than leaving something you marked private visible in the export. The inspector says so when it sees one.
:::

## Cursor styling

If your recording has editable cursor data (native capture in the editable cursor mode, on Windows, macOS, or Linux; [Cursor mode](./recording.md#cursor-mode) lists what each platform records), the Cursor facet lets you tune its style, size, smoothing, motion blur, click bounce, and click impact independently of the raw capture — the underlying cursor path is smoothed deterministically, so what you see in preview matches the final export.

## Keyboard shortcuts

**Keyboard Shortcuts**, in the OpenScreen menu (the logo at the top left), opens the shortcuts dialog, where the configurable ones can be rebound.

| Action | Default |
|---|---|
| Add Zoom | `Z` |
| Add Trim | `T` |
| Add Speed | `S` |
| Add Annotation | `A` |
| Add Full Camera | `C` |
| Add Audio | `M` |
| Record Voiceover | `V` |
| Delete Selected | `Ctrl/Cmd + D` |
| Play / Pause | `Space` |
| Copy region attributes | `Ctrl/Cmd + C` |
| Paste region attributes | `Ctrl/Cmd + V` |
| Open App (works from any app) | `Ctrl/Cmd + Shift + O` |

Fixed (not reassignable):

| Action | Shortcut |
|---|---|
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Shift + Z` (or `+ Y`) |
| Delete Selected (alt) | `Del` / `⌫` |
| Cycle annotations forward / backward | `Tab` / `Shift + Tab` |
| Frame back / forward | `←` / `→` |
| Pan timeline | `Shift + Scroll` |
| Zoom timeline | `Ctrl + Scroll` |

## Saving your work

Edits live in a `.openscreen` project file — separate from any exported video, and fully re-editable. All three actions are in the OpenScreen menu, and on the keyboard:

- **Save Project** (`Ctrl/Cmd + S`) — saves in place, or prompts for a location the first time.
- **Load Project** (`Ctrl/Cmd + O`) — opens an existing `.openscreen` file.
- **New Project** (`Ctrl/Cmd + N`) — clears the current project.

A dot after the project name shows whether it is saved (green) or has unsaved changes (amber), and closing with unsaved changes prompts you to save, discard, or cancel. Undo and redo sit at the top right, beside **Presets**.

When you're ready, head to [Export](./export.md).
