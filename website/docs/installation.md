---
id: installation
title: Install OpenScreen on Windows, macOS, and Linux
sidebar_label: Installation
sidebar_position: 2
description: "Install OpenScreen from the Microsoft Store or winget, a notarized macOS .dmg, or Linux .deb, .rpm, .pacman, AppImage, and Nix, plus system requirements."
keywords:
  - install screen recorder
  - download OpenScreen
  - Microsoft Store
  - winget
  - macOS dmg
  - Windows installer
  - Linux deb
  - Fedora rpm
  - AppImage
  - Nix flake
---

# Install OpenScreen on Windows, macOS, and Linux

On Windows, the recommended route is the [Microsoft Store](#windows). Everywhere else, download the latest installer for your platform from the [download page](/download/), or straight from [GitHub Releases](https://github.com/getopenscreen/openscreen/releases).

## System requirements

| | Minimum | Recommended |
|---|---|---|
| **Windows** | Windows 10 version 1903 (build 18362) or later, x64, Intel 8th Gen / AMD Ryzen 2000 series or newer. Native capture needs Windows 10 version 2004 (build 19041) or later; older builds record through the [browser-capture fallback](#platform-differences) | Windows 11, Intel 12th Gen / AMD Ryzen 4000 series or newer |
| **macOS** | macOS 13 (Ventura) — required by ScreenCaptureKit for capture | macOS 14 or later |
| **Linux** | x64. `xdg-desktop-portal` and PipeWire, which recording needs: the native capture helper goes through them, and a failure there is reported as an error. The [browser-capture fallback](#platform-differences) only takes over when a build is missing the helper itself. System audio additionally needs PipeWire as the sound server (the default on [Ubuntu 22.10+](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976) and [Fedora 34+](https://fedoraproject.org/wiki/Changes/DefaultPipeWire)). Recording mouse clicks on Wayland needs your user in the `input` group — see [Mouse clicks on Wayland](#mouse-clicks-on-wayland) | Same, kept up to date |
| **RAM** | 8 GB | 16 GB |

:::note Older integrated graphics on Windows
Machines with integrated graphics older than roughly 8th-generation Intel (or the equivalent AMD Ryzen 2000 series) are not blocked from installing, but some have known driver stability issues that can make a recording fail to stop and save — see [#460](https://github.com/getopenscreen/openscreen/issues/460). If you hit this, open the tray icon or **Help → Save Diagnostics** right after the failure (before starting another recording) and attach the file to a bug report.
:::

## macOS

Download the `.dmg` installer from [Releases](https://github.com/getopenscreen/openscreen/releases) and drag OpenScreen into your Applications folder. Builds from 1.9.0 onward are signed with a Developer ID certificate and notarized by Apple, so Gatekeeper does not block them and no terminal step is needed.

Then go to **System Settings → Privacy & Security** and grant **Screen Recording** and **Accessibility** to OpenScreen. Screen Recording is what lets it capture at all. Accessibility is what the default editable cursor needs to record the cursor shape and clicks: in that mode, pressing record without it opens a prompt that links to the setting, and recording starts once you have granted it and press record again.

:::note macOS 15 and later re-ask periodically
macOS re-requests screen-recording permission from time to time for every third-party screen recorder. That prompt comes from the operating system — it does not mean your install is broken or that an update went wrong. Grant it again when asked.
:::

:::tip Upgrading from a version older than 1.9.0?
Those builds were not signed with a Developer ID certificate, and macOS ties Screen Recording and Accessibility grants to an app's signature — so it cannot tell the new build is the same app, and the permissions you granted the old one do not carry over. If a new version won't record even after granting them, remove OpenScreen's entries under both permissions in System Settings, then launch it again and grant them fresh.
:::

## Windows

**Recommended: Microsoft Store.** [Get OpenScreen from the Microsoft Store](https://apps.microsoft.com/detail/9MXQ1HQJL5G5), or install the same package from a terminal:

```powershell
winget install --source msstore OpenScreen
```

Microsoft signs the Store package during certification, so it installs without a security warning, and the Store keeps it up to date.

**Alternative: standalone installer.** Download and run the `.exe` from [Releases](https://github.com/getopenscreen/openscreen/releases) if you can't use the Store — Windows LTSC, a locked-down work machine, an offline install, or a specific older version.

:::note SmartScreen warning on the .exe
The `.exe` is not code-signed, so Windows SmartScreen shows **Windows protected your PC** and reports an unknown publisher. Choose **More info → Run anyway** to continue. Download the `.exe` only from the Releases page; if you want a signed package, use the Store build.
:::

## Linux

Four x64 packages are published per release — pick the one matching your distro. On aarch64, use the Nix flake below, which builds from source.

**Debian / Ubuntu / Pop!_OS**
```bash
sudo apt install ./Openscreen-Linux-*.deb
```

**Fedora / RHEL / CentOS**
```bash
sudo dnf install ./Openscreen-Linux-*.rpm
```

**Arch / Manjaro**
```bash
sudo pacman -U Openscreen-Linux-*.pacman
```

**Any distro (AppImage)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

If the AppImage fails to launch with a sandbox error:
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix (flake)**

Try it without installing:
```bash
nix run github:getopenscreen/openscreen
```

Install into your user profile:
```bash
nix profile install github:getopenscreen/openscreen
```

As a NixOS system module:
```nix
{
  inputs.openscreen.url = "github:getopenscreen/openscreen";

  outputs = { nixpkgs, openscreen, ... }: {
    nixosConfigurations.<host> = nixpkgs.lib.nixosSystem {
      modules = [
        openscreen.nixosModules.default
        { programs.openscreen.enable = true; }
      ];
    };
  };
}
```

Home Manager users can use `openscreen.homeManagerModules.default` with the same `programs.openscreen.enable = true;`.

You may need to grant screen-recording permission depending on your desktop environment.

### Mouse clicks on Wayland

Wayland exposes no portal for input events, so OpenScreen reads left-button presses straight from the kernel's evdev interface (`/dev/input/event*`) instead. Those device nodes are owned by `root:input`, so a recording only distinguishes a click from ordinary cursor movement when your user is in the `input` group:

```bash
sudo usermod -aG input $USER
```

Log out and back in for the new group to take effect. Nothing breaks without it — recording works exactly as it did before, and every cursor sample is simply recorded as a move.

The scope is deliberately narrow: only the left mouse button (`BTN_LEFT`) is ever read, never keystrokes. To turn the reader off entirely even where the permission exists, set `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` in the environment OpenScreen is launched from.

:::caution
The `input` group is not limited to OpenScreen: every program running as your user can then read every input device, keyboard included. Add yourself only if you accept that on this machine.
:::

**Touchpads:** only a physical click — pressing the pad down until it depresses — is recorded. **Tap-to-click is not**, because your compositor's input stack (libinput) synthesises those taps for its own use and never writes them back to the kernel device that OpenScreen reads, so there is nothing at the evdev layer to see. A mouse, or a touchpad with tap-to-click turned off, records every click.

## Platform differences

The editing tools are the same everywhere — zooms, backgrounds, crop/trim/speed, annotations, transcription, captions, and projects. Every export format works on every platform; what differs is **capture**, and which encoder the Linux MP4 export can use:

| | macOS | Windows | Linux |
|---|---|---|---|
| Capture pipeline | Native (ScreenCaptureKit) | Native (Windows Graphics Capture) on build 19041 and later; browser fallback on older builds or without the helper | Native (PipeWire via the ScreenCast portal); browser fallback without the helper, losing hardware encode and cursor telemetry |
| Custom cursor themes / click effects | ✅ — clicks and cursor shape need the Accessibility permission | ✅ | ✅ on Wayland — click capture needs the `input` group ([details](#mouse-clicks-on-wayland)) |
| Webcam | Browser capture, saved as a separate file (still works as PiP) | Native capture, saved as a separate file | Browser capture, saved as a separate file (still works as PiP) |
| System audio | Works out of the box; permission prompt on macOS 14.2+ | Works out of the box | Needs PipeWire as the sound server (default on Ubuntu 22.10+, Fedora 34+) |
| MP4 export | ✅ | ✅ | ✅ — H.264 on the GPU through VAAPI when the GPU stack allows it (see the note below), software otherwise; H.265 is software-only |
| GIF export | ✅ | ✅ | ✅ |
| On-device transcription | Metal (Apple Silicon) / CPU | Vulkan / CPU | Vulkan / CPU |

:::note MP4 export on Linux
The GPU compositor behind the live preview and MP4 export has three backends — Direct3D 11 on Windows, Metal on macOS, wgpu/WGSL on Linux — and ships in all three builds. On Linux, an H.264 export hands each composited frame to `h264_vaapi` without a CPU copy when the GPU driver exposes VAAPI *and* the Vulkan device can hand the frame over as a dmabuf (`VK_KHR_external_memory_fd` and `VK_EXT_external_memory_dma_buf`). When any of that is missing — no render node, a driver without VAAPI, a Vulkan device without those extensions — the export falls back to a software encoder and simply takes longer; nothing else changes. H.265 exports always use the software encoder on Linux.
:::

What OpenScreen does on each system, and when another tool fits it better, is summarized on the [Windows](/screen-recorder-windows/), [Mac](/screen-recorder-mac/) and [Linux](/screen-recorder-linux/) pages.

Next: [Quick start](./quick-start.md) walks through your first recording.
