---
id: intro
title: "OpenScreen docs: install, record, edit, export"
sidebar_label: Introduction
sidebar_position: 1
description: "Docs for OpenScreen 1.11.0, the MIT-licensed screen recorder and editor: install it, then record, edit, caption, and export on Windows, macOS, and Linux."
keywords:
  - screen recorder
  - open source screen recorder
  - free screen recorder
  - video editor
  - OpenScreen documentation
  - Windows
  - macOS
  - Linux
---

# OpenScreen docs: install, record, edit, export

OpenScreen is a **free, open-source screen recorder and editor**. It records through each platform's native capture API (ScreenCaptureKit on macOS, Windows Graphics Capture on Windows, PipeWire through the ScreenCast portal on Linux), and composites both the live preview and the final export on the GPU through a native Rust renderer (Direct3D 11 on Windows, Metal on macOS, wgpu on Linux) — one path, so what you see in the editor is what comes out of the export.

These pages describe **OpenScreen 1.11.0**, the stable release of September 9, 2026. What changed in each release, and why, is in the [development journal](/blog/).

:::note
OpenScreen ships often. Between releases, the `.openscreen` project format and the [CLI](/docs/cli/) can still change.
:::

## What you can do

- [Record](./recording.md) a specific window or your whole screen, with system audio, microphone, and webcam — from a floating HUD or from the editor itself.
- Build a project from several sources: [import, trim, crop, reorder, and split clips](./media-library.md) on one timeline.
- [Edit](./editing-timeline.md) with zooms, trims, per-region speed, Full Camera segments, text/image/arrow/blur annotations, cursor themes, webcam layouts, and background/effects.
- Transcribe on-device with Whisper, then [burn in captions](./captions.md) — restyled live, translatable into 15 languages through your own LLM provider — or cut your recording by deleting words from the transcript.
- Optionally connect your own LLM key to [edit by chat](./ai-editing.md) — off by default, never required.
- [Export](./export.md) to MP4 (720p/1080p/source, H.264 or H.265) or animated GIF.

Questions about licensing, watermarks, or what goes over the network are answered in the [FAQ](/docs/faq/). How OpenScreen compares with other recorders is on the [Screen Studio](/alternatives/screen-studio/), [Cap](/compare/openscreen-vs-cap/) and [OBS Studio](/compare/openscreen-vs-obs/) pages.

:::note
Recording, editing, transcription, captions, and export need no account and keep working without a network connection. Transcription needs one download first: its Whisper model (~264 MB), fetched on your first run. When a connection is there, the app also loads its annotation fonts from Google Fonts at startup, and builds installed from GitHub Releases check GitHub for updates. AI chat editing and caption translation go online only once you connect a provider yourself, and only to that provider.
:::

## Project facts

| | |
|---|---|
| **License** | MIT — free for personal and commercial use |
| **Documented version** | 1.11.0 ([all releases](https://github.com/getopenscreen/openscreen/releases)) |
| **Platforms** | Windows 10 version 1903 or later (x64), macOS 13 or later (Apple Silicon and Intel), Linux (x64 packages; aarch64 through the Nix flake) — see [Installation](./installation.md) |
| **Origin** | Created by Siddharth Vaddem, who [archived the original repository](https://github.com/siddharthvaddem/openscreen) after v1.5.0. Development continues here with his approval, under the same name and the same MIT license. |

## Official links

| | |
|---|---|
| **Website** | [getopenscreen.com](https://getopenscreen.com/) |
| **Source code, releases, issues** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## Status of this site

Everything under **Features** in the sidebar documents what's actually shipped in the app today, not the roadmap. The deeper internal specs this site is built from — architecture notes, engineering docs, test plans — still live in the repo and aren't migrated here yet:

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
