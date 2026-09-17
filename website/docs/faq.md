---
id: faq
title: "OpenScreen FAQ: license, privacy and links"
sidebar_label: FAQ
description: "Is OpenScreen free for commercial use? Yes, under the MIT license. Answers on watermarks, offline use, privacy, signed installers and official links."
keywords:
  - OpenScreen FAQ
  - free for commercial use
  - MIT license
  - no watermark
  - offline screen recorder
  - OpenScreen original project
---

# OpenScreen FAQ

OpenScreen is a free, MIT-licensed screen recorder and video editor for Windows, macOS and Linux. It is free for commercial use, with no account and no watermark. This page answers the questions people ask before installing it: licensing, what goes over the network, how the installers are signed, and which sites are official. It is not the same product as Open Screen at openscreen.io.

## Is OpenScreen free for commercial use?

**Yes.** OpenScreen is released under the [MIT license](https://github.com/getopenscreen/openscreen/blob/main/LICENSE).

- You can use, copy, modify, distribute and sell it. The one condition is to keep the copyright and permission notice with copies of the software.
- The license text covers the software. It says nothing about the videos you make with it.
- There is no account, no paid tier and no premium feature.

## Does OpenScreen add a watermark?

**No.** MP4 and GIF exports carry no watermark, and there is no paid version that removes one. See [Export](./export.md) for the formats.

## Does OpenScreen work offline?

**Recording, transcription and rendering run on your machine.** OpenScreen has no upload feature, so your recordings stay on your disk. The app still makes a few network connections, so "fully offline" would be wrong:

- **Google Fonts, at every launch.** The app loads the fonts for its text annotations from Google's servers, fonts.googleapis.com included.
- **huggingface.co, once.** The first transcription downloads the Whisper model, about 264 MB, and checks it against a SHA-256 hash. After that, transcription needs no connection.
- **github.com and api.github.com.** Builds that update themselves check for a new release every 24 hours, and when you ask. By default they only tell you one is available.
- **Your AI provider, only if you connect one.** Chat editing sends your messages and the project data it reads, such as the timeline and transcript. Caption translation sends the caption text. Both stay off until you connect a provider. See [AI editing](./ai-editing.md).

## Does OpenScreen collect analytics or crash reports?

**No.** The app's code contains no analytics or crash-reporting SDK.

- There is no OpenScreen server for the app to report to.
- AI provider keys are stored encrypted with Electron's `safeStorage`. If encryption is unavailable, the key is not saved.

## Is OpenScreen safe to install?

**The source is public, and the macOS and Store builds are signed.** Download only from the links in [Official links](#what-are-the-official-openscreen-links).

- **macOS:** builds from 1.9.0 onward are signed with an Apple Developer ID and notarized.
- **Windows, Microsoft Store:** Microsoft signs the package, so it installs without a warning.
- **Windows, `.exe` installer:** not code-signed. SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**, or use the Store build instead.

[Installation](./installation.md) has the steps for each platform.

## Which systems does OpenScreen run on?

| System | Minimum | Packages |
|---|---|---|
| macOS | 13 Ventura | `.dmg` for Apple Silicon and for Intel |
| Windows | 10 version 1903, x64 | Microsoft Store, `.exe` installer |
| Linux | x64, PipeWire and xdg-desktop-portal | AppImage, `.deb`, `.rpm`, `.pacman`, Nix flake |

- On Windows, native capture needs build 19041 (Windows 10 version 2004). Older builds fall back to browser capture.
- Plan for 8 GB of RAM, 16 GB recommended.

## Is there an ARM64 build for Windows or Linux?

**No packaged one.** Windows and Linux releases are x64 only.

- On ARM64 Linux, the Nix flake builds OpenScreen from source for `aarch64-linux`.
- Apple Silicon Macs get a native `.dmg`.

## Can I install OpenScreen with winget, Homebrew or Flathub?

- **winget:** yes, through the Store source: `winget install --source msstore OpenScreen`.
- **Homebrew:** there is no official cask. As of September 2026, the `siddharthvaddem/openscreen` tap from the original project still pins version 1.5.0. Use the `.dmg` from the [download page](/download/) instead.
- **Flathub:** there is no listing.

## Is this the original OpenScreen project?

**It is the continuation of it.**

- Siddharth Vaddem created OpenScreen and archived the [original repository](https://github.com/siddharthvaddem/openscreen) after v1.5.0.
- Development moved to [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) with his approval, under the same name and the same MIT license.
- The archived README calls this project a community-driven spin-off led by one of the core contributors. That is Etienne Lescot, who maintains it. The README's link, github.com/EtienneLescot/openscreen, redirects to the current repository.
- The archived repository receives no updates. [Picking up OpenScreen](/blog/2026/06/15/picking-up-openscreen/) explains the handover.

## Is OpenScreen related to openscreen.io or openscreen.net?

- **openscreen.io:** no. It is a different product, Open Screen, which its site presents as a screen recorder for macOS. OpenScreen is not affiliated with it.
- **openscreen.net:** it is not an official OpenScreen site.

## What are the official OpenScreen links?

| What | Link |
|---|---|
| Website | [getopenscreen.com](https://getopenscreen.com/) |
| Source code, releases and issues | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| Original project, archived and read-only | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## What happens if a recording is interrupted?

On Windows and macOS, the native recorders write fragmented MP4 in one-second fragments. If a recording is cut off, the file still plays up to the last complete fragment.

Bug reports and feature requests go to [GitHub issues](https://github.com/getopenscreen/openscreen/issues).

## What doesn't OpenScreen do?

If you need any of these, OpenScreen is not the right tool:

- **Hosted sharing.** No share links, cloud storage, team workspaces or comments. Your files stay on your disk. See [OpenScreen as a Loom alternative](/alternatives/loom/).
- **Live streaming.** See [OpenScreen vs OBS Studio](/compare/openscreen-vs-obs/).
- **Caption files.** Captions are burned into the video. There is no SRT or VTT export. See [Captions](./captions.md).
- **Mobile.** No mobile app, and no iOS or Android capture.

## How do I get started?

1. Get the installer for your system from the [download page](/download/).
2. Follow [Installation](./installation.md) for your platform.
3. Record, trim and export a first video with the [Quick start](./quick-start.md).

## Sources

Checked September 2026:

- Original repository and its archive notice: [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- Homebrew tap of the original project: [github.com/siddharthvaddem/homebrew-openscreen](https://github.com/siddharthvaddem/homebrew-openscreen)
- Open Screen: [openscreen.io](https://openscreen.io/)

Open Screen, Loom, OBS Studio and the other product names on this page are trademarks of their respective owners. OpenScreen is not affiliated with Open Screen (openscreen.io), Loom or OBS Studio.
