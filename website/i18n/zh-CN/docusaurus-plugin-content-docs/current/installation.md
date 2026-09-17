---
id: installation
title: 在 Windows、macOS 和 Linux 上安装 OpenScreen
sidebar_label: 安装
sidebar_position: 2
description: "通过 Microsoft Store 或 winget、经过公证的 macOS .dmg，或 Linux 的 .deb、.rpm、.pacman、AppImage 和 Nix 安装 OpenScreen，并附系统要求。"
keywords:
  - 安装录屏软件
  - 下载 OpenScreen
  - Microsoft Store
  - winget
  - macOS dmg
  - Windows 安装程序
  - Linux deb
  - Fedora rpm
  - AppImage
  - Nix flake
---

# 在 Windows、macOS 和 Linux 上安装 OpenScreen

在 Windows 上，推荐通过 [Microsoft Store](#windows) 安装。其他平台请从[下载页面](/download/)或直接从 [GitHub Releases](https://github.com/getopenscreen/openscreen/releases) 下载适合你平台的最新安装程序。

## 系统要求 {#system-requirements}

| | 最低配置 | 推荐配置 |
|---|---|---|
| **Windows** | Windows 10 版本 1903（内部版本 18362）或更高，x64，Intel 第 8 代 / AMD Ryzen 2000 系列或更新。原生采集需要 Windows 10 版本 2004（内部版本 19041）或更高；更早的内部版本通过[浏览器采集回退方案](#platform-differences)录制 | Windows 11，Intel 第 12 代 / AMD Ryzen 4000 系列或更新 |
| **macOS** | macOS 13（Ventura）：ScreenCaptureKit 采集所需 | macOS 14 或更高 |
| **Linux** | x64。需要 `xdg-desktop-portal` 和 PipeWire，录制离不开它们：原生采集辅助程序经由它们工作，这一环节出现故障时会作为错误报告出来。只有当某个构建缺少辅助程序本身时，[浏览器采集回退方案](#platform-differences)才会接手。录制系统音频还需要以 PipeWire 作为声音服务器（[Ubuntu 22.10+](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976) 和 [Fedora 34+](https://fedoraproject.org/wiki/Changes/DefaultPipeWire) 的默认设置）。在 Wayland 上记录鼠标点击，需要你的用户属于 `input` 组，详见 [Wayland 上的鼠标点击](#mouse-clicks-on-wayland) | 同左，并保持更新 |
| **内存** | 8 GB | 16 GB |

:::note Windows 上的旧款集成显卡
集成显卡早于约第 8 代 Intel（或同级别的 AMD Ryzen 2000 系列）的电脑并不会被禁止安装，但其中一些存在已知的驱动稳定性问题，可能导致录制无法停止和保存，详见 [#460](https://github.com/getopenscreen/openscreen/issues/460)。如果遇到这种情况，请在失败后立即（在开始下一次录制之前）打开托盘图标或**帮助 → 保存诊断信息**，并把生成的文件附到错误报告中。
:::

## macOS {#macos}

从 [Releases](https://github.com/getopenscreen/openscreen/releases) 下载 `.dmg` 安装程序，把 OpenScreen 拖到“应用程序”文件夹中。从 1.9.0 起的版本都使用 Developer ID 证书签名，并经过 Apple 公证，因此 Gatekeeper 不会拦截，也不需要在终端中执行任何步骤。

然后前往**系统设置 → 隐私与安全性**，为 OpenScreen 授予**屏幕录制**和**辅助功能**权限。有了“屏幕录制”权限，它才能进行采集。默认的可编辑光标需要“辅助功能”权限，才能记录光标形状和点击：在该模式下，如果没有这项权限就按下录制，会弹出一个带有该设置链接的提示；授予权限后再次按下录制，录制就会开始。

:::note macOS 15 及更高版本会定期重新询问
macOS 会不时为所有第三方录屏软件重新请求屏幕录制权限。这个提示来自操作系统，并不表示你的安装有问题或更新出了错。收到询问时再次授予即可。
:::

:::tip 从 1.9.0 之前的版本升级？
那些版本没有使用 Developer ID 证书签名，而 macOS 会把“屏幕录制”和“辅助功能”授权与应用的签名绑定在一起，因此它无法识别新版本和旧版本是同一个应用，你授予旧版本的权限也不会延续过来。如果授予权限后新版本仍然无法录制，请在“系统设置”中把 OpenScreen 从这两项权限的列表里移除，然后重新启动它，并重新授予权限。
:::

## Windows {#windows}

**推荐：Microsoft Store**。[从 Microsoft Store 获取 OpenScreen](https://apps.microsoft.com/detail/9MXQ1HQJL5G5)，或在终端中安装同一个安装包：

```powershell
winget install --source msstore OpenScreen
```

Microsoft 会在认证过程中为 Store 安装包签名，因此安装时不会出现安全警告，而且 Store 会自动保持它为最新版本。

**替代方案：独立安装程序**。如果你无法使用 Store（Windows LTSC、受管控的工作电脑、离线安装，或需要某个特定的旧版本），可以从 [Releases](https://github.com/getopenscreen/openscreen/releases) 下载并运行 `.exe`。

:::note .exe 的 SmartScreen 警告
`.exe` 没有代码签名，因此 Windows SmartScreen 会显示 **Windows 已保护你的电脑**，并提示发布者未知。选择**更多信息 → 仍要运行**即可继续。请只从 Releases 页面下载 `.exe`；如果你需要已签名的安装包，请使用 Store 版。
:::

## Linux {#linux}

每个版本都会发布四个 x64 软件包，请选择与你的发行版对应的那个。在 aarch64 上，请使用下文的 Nix flake，它会从源代码构建。

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

**任意发行版（AppImage）**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

如果 AppImage 因沙盒错误而无法启动：
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix（flake）**

免安装试用：
```bash
nix run github:getopenscreen/openscreen
```

安装到你的用户配置文件：
```bash
nix profile install github:getopenscreen/openscreen
```

作为 NixOS 系统模块：
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

Home Manager 用户可以使用 `openscreen.homeManagerModules.default`，配合同样的 `programs.openscreen.enable = true;`。

根据你的桌面环境，你可能需要授予屏幕录制权限。

### Wayland 上的鼠标点击 {#mouse-clicks-on-wayland}

Wayland 没有提供输入事件的门户，因此 OpenScreen 改为直接从内核的 evdev 接口（`/dev/input/event*`）读取左键按下事件。这些设备节点的所有者是 `root:input`，所以只有当你的用户属于 `input` 组时，录制才能把点击和普通的光标移动区分开：

```bash
sudo usermod -aG input $USER
```

注销并重新登录后，新的组才会生效。没有这项设置也不会出问题：录制的效果和以前完全一样，只是每个光标采样都会记录为移动。

读取范围被刻意限定得很窄：只读取鼠标左键（`BTN_LEFT`），绝不读取键盘按键。如果即使有权限也要完全关闭这个读取功能，请在启动 OpenScreen 的环境中设置 `OPENSCREEN_DISABLE_CLICK_CAPTURE=1`。

:::caution
`input` 组并不只对 OpenScreen 生效：加入后，以你的用户身份运行的任何程序都能读取所有输入设备，包括键盘。请仅在你接受这一点的机器上加入该组。
:::

**触控板**：只有物理点击（把触控板按下去直到它下沉）才会被记录。**轻触点击不会被记录**，因为轻触是由合成器的输入栈（libinput）自行合成、供自己使用的，从不会写回 OpenScreen 读取的内核设备，所以在 evdev 这一层根本看不到。使用鼠标，或关闭轻触点击的触控板，每次点击都会被记录。

## 平台差异 {#platform-differences}

编辑工具在所有平台上都一样：缩放、背景、裁剪/剪辑/变速、标注、转录、字幕和项目。所有导出格式在每个平台上都可用；不同的是**采集**，以及 Linux 上的 MP4 导出可以使用哪种编码器：

| | macOS | Windows | Linux |
|---|---|---|---|
| 采集管线 | 原生（ScreenCaptureKit） | 内部版本 19041 及更高为原生（Windows Graphics Capture）；更早的内部版本或缺少辅助程序时回退到浏览器采集 | 原生（经由 ScreenCast 门户的 PipeWire）；缺少辅助程序时回退到浏览器采集，并失去硬件编码和光标遥测 |
| 自定义光标主题 / 点击效果 | ✅：点击和光标形状需要“辅助功能”权限 | ✅ | ✅ Wayland 上可用：点击采集需要 `input` 组（[详情](#mouse-clicks-on-wayland)） |
| 摄像头 | 浏览器采集，保存为单独的文件（仍可用作画中画） | 原生采集，保存为单独的文件 | 浏览器采集，保存为单独的文件（仍可用作画中画） |
| 系统音频 | 开箱即用；macOS 14.2+ 会弹出权限提示 | 开箱即用 | 需要以 PipeWire 作为声音服务器（Ubuntu 22.10+、Fedora 34+ 的默认设置） |
| MP4 导出 | ✅ | ✅ | ✅：GPU 栈条件允许时，通过 VAAPI 在 GPU 上进行 H.264 编码（见下方说明），否则使用软件编码；H.265 仅支持软件编码 |
| GIF 导出 | ✅ | ✅ | ✅ |
| 本机转录 | Metal（Apple Silicon）/ CPU | Vulkan / CPU | Vulkan / CPU |

:::note Linux 上的 MP4 导出
实时预览和 MP4 导出背后的 GPU 合成器有三个后端：Windows 上是 Direct3D 11，macOS 上是 Metal，Linux 上是 wgpu/WGSL，三个平台的构建都包含它。在 Linux 上，如果 GPU 驱动提供 VAAPI，*并且* Vulkan 设备能以 dmabuf 形式交出帧（`VK_KHR_external_memory_fd` 和 `VK_EXT_external_memory_dma_buf`），H.264 导出会把每个合成好的帧直接交给 `h264_vaapi`，无需经过 CPU 拷贝。只要缺少其中任何一项（没有渲染节点、驱动不支持 VAAPI、Vulkan 设备不支持这些扩展），导出就会回退到软件编码器，只是耗时更长，其他一切不变。在 Linux 上，H.265 导出始终使用软件编码器。
:::

OpenScreen 在各个系统上能做什么，以及什么情况下其他工具更合适，汇总在 [Windows](/screen-recorder-windows/)、[Mac](/screen-recorder-mac/) 和 [Linux](/screen-recorder-linux/) 页面中。

下一步：[快速上手](./quick-start.md)会带你完成第一次录制。
