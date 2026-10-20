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

- **huggingface.co, once.** The first transcription downloads the Whisper model, about 264 MB, and a voice-detection model under 1 MB, each checked against a SHA-256 hash. After that, transcription needs no connection.
- **github.com, once per language.** On a machine with a GPU, the first English or French transcription also downloads the model that re-times each word: about 110 MB for English, 350 MB for French.
- **github.com and api.github.com.** Builds that update themselves check for a new release every 24 hours, and when you ask. By default they only tell you one is available.
- **fonts.googleapis.com, only for a font added in 1.x.** A custom annotation font added in an earlier version is still fetched at launch, though 2.x no longer draws it.
- **PostHog, once a day.** An anonymous count of active installs, sent to PostHog's EU servers. It holds the app version, the operating system, the processor architecture, how the app was installed, whether it was used directly or through its MCP server by an AI agent, and whether it is the first count of the week and of the month. That is all: no installation identifier (each count gets a new random ID), no IP address kept, nothing about your recordings. Untick **Send Anonymous Usage Count** in the tray menu to turn it off, or set `DO_NOT_TRACK=1`.
- **Your AI provider, only if you connect one.** Chat editing sends your messages and the project data it reads, such as the timeline and transcript. Caption translation sends the caption text. Both stay off until you connect a provider. See [AI editing](./ai-editing.md).

## Does OpenScreen collect analytics or crash reports?

**One anonymous daily count, nothing else.** The app contains no analytics or crash-reporting SDK, and nothing records what you do in it.

- Once a day, the app reports that one installation was active. [Does OpenScreen work offline?](#does-openscreen-work-offline) lists exactly what that count holds and how to turn it off.
- The count carries no installation identifier: each one gets a new random ID, and nothing else in it is specific to your computer.
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
| Windows | 10 version 1903, x64 or ARM64 | Microsoft Store (x64), `.exe` installer (x64 and ARM64) |
| Linux | x64, PipeWire and xdg-desktop-portal | AppImage, `.deb`, `.rpm`, `.pacman`, Nix flake |

- On Windows, native capture needs build 19041 (Windows 10 version 2004). Older builds fall back to browser capture.
- Plan for 8 GB of RAM, 16 GB recommended.

## Is there an ARM64 build for Windows or Linux?

**On Windows, yes. On Linux, through Nix only.**

- Windows on ARM gets its own `.exe` installer on the [Releases](https://github.com/getopenscreen/openscreen/releases) page. The Microsoft Store package is x64 only.
- Linux packages are x64 only. On ARM64 Linux, the Nix flake builds OpenScreen from source for `aarch64-linux`.
- Apple Silicon Macs get a native `.dmg`.

## Can I install OpenScreen with winget, Homebrew or Flathub?

- **winget:** yes, through the Store source: `winget install --source msstore OpenScreen`.
- **Homebrew:** yes, from the official tap: `brew install --cask getopenscreen/openscreen/openscreen`. Every stable release updates the cask.
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
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5?cid=website) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| Original project, archived and read-only | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## What happens if a recording is interrupted?

On Windows and macOS, the native recorders write fragmented MP4 in one-second fragments. If a recording is cut off, the file still plays up to the last complete fragment.

Bug reports and feature requests go to [GitHub issues](https://github.com/getopenscreen/openscreen/issues).

## Why does OpenScreen quit on macOS when I choose what to record?

**Most likely, another app asks it to quit.** Some Mac utilities quit an app as soon as they decide its last window has closed. One example is the **Quit on close** option of [Vorssaint](https://github.com/vorssaint/vorssaint-utils), when it is turned on. It does not count the HUD, OpenScreen's recording bar, as a window, because the HUD floats above other windows. It then quits OpenScreen a second or two after either of these:

- On macOS 15.2 and later, the HUD hides while Apple's system picker is open.
- Before macOS 15.2, OpenScreen's own source window closes once you pick, so the app can disappear during the countdown.

OpenScreen closes as it does with ⌘Q: no error message and no crash report.

- **To fix it**, add OpenScreen to the utility's exceptions, or turn the option off. In Vorssaint: **Quit on close**, **Exceptions**, **Add app…**.
- **To see which app asked**, run this in Terminal right after OpenScreen closes. On each line, the name after the time is an app that sent a quit request:

```sh
/usr/bin/log show --last 5m --info --style compact --predicate 'eventMessage CONTAINS "AESendMessage(aevt,quit"'
```

## Why can't I click the recording bar on Windows 10?

**Update to OpenScreen 2.1.0: it fixes this.** In 2.0.0, on Windows 10 and on Windows 11 before version 22H2, the protection that keeps the recording bar out of your videos also blocked its clicks ([issue #1105](https://github.com/getopenscreen/openscreen/issues/1105)). Since 2.1.0, OpenScreen leaves that protection off on those versions, so the bar takes clicks. It can then appear in your recordings.

If you set `OPENSCREEN_DISABLE_CONTENT_PROTECTION` to work around the problem in 2.0.0, remove it, then sign out of Windows and back in:

```powershell
reg delete HKCU\Environment /v OPENSCREEN_DISABLE_CONTENT_PROTECTION /f
```

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
- Official Homebrew tap: [github.com/getopenscreen/homebrew-openscreen](https://github.com/getopenscreen/homebrew-openscreen)
- Open Screen: [openscreen.io](https://openscreen.io/)
- Vorssaint's *Quit on close* option, checked October 2026: [github.com/vorssaint/vorssaint-utils](https://github.com/vorssaint/vorssaint-utils)

Open Screen, Loom, OBS Studio and the other product names on this page are trademarks of their respective owners. OpenScreen is not affiliated with Open Screen (openscreen.io), Loom or OBS Studio.
