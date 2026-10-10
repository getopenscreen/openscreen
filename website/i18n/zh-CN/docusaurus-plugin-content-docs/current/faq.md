---
id: faq
title: "OpenScreen 常见问题：许可证、隐私和链接"
sidebar_label: 常见问题
description: "OpenScreen 可以免费商用吗？可以，它采用 MIT 许可证。本页还解答水印、离线使用、隐私、安装程序签名和官方链接等问题。"
keywords:
  - OpenScreen 常见问题
  - 免费商用
  - MIT 许可证
  - 无水印
  - 离线录屏软件
  - OpenScreen 原项目
---

# OpenScreen 常见问题

OpenScreen 是一款免费的录屏与视频剪辑软件，采用 MIT 许可证，支持 Windows、macOS 和 Linux。它可以免费用于商业用途，无需账号，也没有水印。本页解答大家在安装前常问的问题：许可证、哪些内容会通过网络传输、安装程序如何签名，以及哪些网站是官方网站。它与 openscreen.io 上的 Open Screen 不是同一个产品。

## OpenScreen 可以免费商用吗？ {#is-openscreen-free-for-commercial-use}

**可以**。OpenScreen 以 [MIT 许可证](https://github.com/getopenscreen/openscreen/blob/main/LICENSE)发布。

- 你可以使用、复制、修改、分发和出售它。唯一的条件是：在软件的副本中保留版权声明和许可声明。
- 许可证文本针对的是软件本身，并未提及你用它制作的视频。
- 没有账号，没有付费版，也没有高级功能。

## OpenScreen 会添加水印吗？ {#does-openscreen-add-a-watermark}

**不会**。导出的 MP4 和 GIF 都没有水印，也不存在去除水印的付费版本。支持的格式请参阅[导出](./export.md)。

## OpenScreen 可以离线使用吗？ {#does-openscreen-work-offline}

**录制、转录和渲染都在你的电脑上运行**。OpenScreen 没有上传功能，所以你的录制内容都保留在你的磁盘上。不过，应用仍会建立少量网络连接，所以说它“完全离线”是不对的：

- **Google Fonts，每次启动时**。应用会从 Google 的服务器（包括 fonts.googleapis.com）加载文本标注所用的字体。
- **huggingface.co，仅一次**。第一次转录时会下载约 264 MB 的 Whisper 模型，并用 SHA-256 哈希值进行校验。此后转录无需联网。
- **github.com 和 api.github.com**。能够自动更新的版本每 24 小时检查一次新版本，你手动检查时也会连接。默认情况下，它们只会通知你有新版本可用。
- **你的 AI 提供方，仅在你连接之后**。聊天编辑会发送你的消息以及它读取的项目数据，例如时间轴和转录文本。字幕翻译会发送字幕文本。在你连接提供方之前，这两项功能都处于关闭状态。请参阅 [AI 编辑](./ai-editing.md)。

## OpenScreen 会收集分析数据或崩溃报告吗？ {#does-openscreen-collect-analytics-or-crash-reports}

**不会**。应用代码中不包含任何分析或崩溃报告 SDK。

- 不存在可供应用上报数据的 OpenScreen 服务器。
- AI 提供方的密钥通过 Electron 的 `safeStorage` 加密存储。如果无法加密，密钥就不会被保存。

## 安装 OpenScreen 安全吗？ {#is-openscreen-safe-to-install}

**源代码是公开的，macOS 版和 Store 版都经过签名**。请只从[官方链接](#what-are-the-official-openscreen-links)中列出的地址下载。

- **macOS**：从 1.9.0 起的版本都使用 Apple Developer ID 签名，并经过公证。
- **Windows，Microsoft Store**：安装包由 Microsoft 签名，因此安装时不会出现警告。
- **Windows，`.exe` 安装程序**：没有代码签名。SmartScreen 会显示“Windows 已保护你的电脑”。请选择**更多信息**，再选择**仍要运行**；也可以改用 Store 版。

[安装](./installation.md)页面列出了各平台的安装步骤。

## OpenScreen 支持哪些系统？ {#which-systems-does-openscreen-run-on}

| 系统 | 最低要求 | 安装包 |
|---|---|---|
| macOS | 13 Ventura | 分别适用于 Apple Silicon 和 Intel 的 `.dmg` |
| Windows | 10 版本 1903，x64 | Microsoft Store、`.exe` 安装程序 |
| Linux | x64，PipeWire 和 xdg-desktop-portal | AppImage、`.deb`、`.rpm`、`.pacman`、Nix flake |

- 在 Windows 上，原生采集需要内部版本 19041（Windows 10 版本 2004）。更早的内部版本会回退到浏览器采集。
- 内存请按 8 GB 准备，推荐 16 GB。

## 有适用于 Windows 或 Linux 的 ARM64 版本吗？ {#is-there-an-arm64-build-for-windows-or-linux}

**没有打包好的版本**。Windows 和 Linux 的发布版本只有 x64。

- 在 ARM64 Linux 上，Nix flake 会从源代码为 `aarch64-linux` 构建 OpenScreen。
- Apple Silicon Mac 有原生的 `.dmg`。

## 可以通过 winget、Homebrew 或 Flathub 安装 OpenScreen 吗？ {#can-i-install-openscreen-with-winget-homebrew-or-flathub}

- **winget**：可以，通过 Store 源安装：`winget install --source msstore OpenScreen`。
- **Homebrew**：可以，通过官方 tap 安装：`brew install --cask getopenscreen/openscreen/openscreen`。每次发布稳定版都会更新这个 cask。
- **Flathub**：没有上架。

## 这是原版 OpenScreen 项目吗？ {#is-this-the-original-openscreen-project}

**这是它的延续**。

- Siddharth Vaddem 创建了 OpenScreen，并在 v1.5.0 之后归档了[原始仓库](https://github.com/siddharthvaddem/openscreen)。
- 经他同意，开发迁移到了 [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen)，沿用相同的名称和相同的 MIT 许可证。
- 已归档的 README 称本项目是由一位核心贡献者主导、社区驱动的衍生项目。这位贡献者就是 Etienne Lescot，由他负责维护。README 中的链接 github.com/EtienneLescot/openscreen 会重定向到当前仓库。
- 已归档的仓库不再更新。交接经过见 [Picking up OpenScreen（英文）](/blog/2026/06/15/picking-up-openscreen/)。

## OpenScreen 与 openscreen.io 或 openscreen.net 有关系吗？ {#is-openscreen-related-to-openscreenio-or-openscreennet}

- **openscreen.io**：没有关系。那是另一个产品 Open Screen，其网站将它介绍为一款 macOS 录屏软件。OpenScreen 与它没有任何关联。
- **openscreen.net**：不是 OpenScreen 的官方网站。

## OpenScreen 的官方链接有哪些？ {#what-are-the-official-openscreen-links}

| 内容 | 链接 |
|---|---|
| 网站 | [getopenscreen.com](https://getopenscreen.com/) |
| 源代码、版本发布和 Issue | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| 原项目，已归档，只读 | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## 如果录制中断了会怎样？ {#what-happens-if-a-recording-is-interrupted}

在 Windows 和 macOS 上，原生录制器会写入以一秒为分段的分段式 MP4。如果录制意外中断，文件仍可播放到最后一个完整的分段为止。

错误报告和功能请求请提交到 [GitHub issues](https://github.com/getopenscreen/openscreen/issues)。

## 为什么在 macOS 上选择要录制的内容时，OpenScreen 会退出？ {#why-does-openscreen-quit-on-macos-when-i-choose-what-to-record}

**多半是另一个应用让它退出的。** 有些 Mac 工具一旦认定某个应用的最后一个窗口已经关闭，就会让该应用退出。例如开启后的 [Vorssaint](https://github.com/vorssaint/vorssaint-utils) **Quit on close** 选项。它不会把 OpenScreen 的录制栏 HUD 算作窗口，因为 HUD 浮在其他窗口之上。于是，在下面任一情况发生后一两秒，它就会让 OpenScreen 退出：

- 在 macOS 15.2 及更高版本上，Apple 的系统选择器打开期间，HUD 会隐藏。
- 在 macOS 15.2 之前，选好之后，OpenScreen 自己的来源选择窗口会关闭，因此应用可能在倒计时期间消失。

OpenScreen 的退出方式与按下 ⌘Q 相同：没有错误提示，也没有崩溃报告。

- **解决方法**：把 OpenScreen 加入该工具的例外列表，或关闭这个选项。在 Vorssaint 中依次进入 **Quit on close**、**Exceptions**、**Add app…**。
- **要查看是哪个应用发出的请求**，请在 OpenScreen 退出后立即在终端中运行下面的命令。每一行中，时间后面的名称就是发出退出请求的应用：

```sh
/usr/bin/log show --last 5m --info --style compact --predicate 'eventMessage CONTAINS "AESendMessage(aevt,quit"'
```

## 为什么在 Windows 10 上无法点击录制栏？ {#why-cant-i-click-the-recording-bar-on-windows-10}

**在 Windows 10 上的 OpenScreen 2.0.0 中，让录制栏不出现在视频里的保护机制，也可能挡住对它的点击。** 录制栏（HUD）显示在屏幕上，却不响应任何点击。托盘图标的右键菜单仍然可用。修复进度见 [issue #1105](https://github.com/getopenscreen/openscreen/issues/1105)。在修复发布之前，请关闭这项保护。此方法适用于 Microsoft Store 版本和 `.exe` 安装程序：

1. 在命令提示符或 PowerShell 中运行：

   ```powershell
   setx OPENSCREEN_DISABLE_CONTENT_PROTECTION 1
   ```

2. 退出 OpenScreen：右键点击它的托盘图标，然后选择**退出**。
3. 像平常一样重新启动 OpenScreen。

关闭保护后，录制栏可能会出现在你的录制内容中。

等更新修复这个问题后，删除该变量，然后注销 Windows 并重新登录：

```powershell
reg delete HKCU\Environment /v OPENSCREEN_DISABLE_CONTENT_PROTECTION /f
```

## OpenScreen 不能做什么？ {#what-doesnt-openscreen-do}

如果你需要以下任何一项，OpenScreen 并不是合适的工具：

- **在线托管分享**。没有分享链接、云存储、团队空间或评论功能。你的文件保留在你的磁盘上。请参阅 [OpenScreen 作为 Loom 替代方案](/alternatives/loom/)。
- **直播**。请参阅 [OpenScreen 与 OBS Studio 对比](/compare/openscreen-vs-obs/)。
- **字幕文件**。字幕会烧录进视频，不支持导出 SRT 或 VTT。请参阅[字幕](./captions.md)。
- **移动端**。没有移动应用，也不能录制 iOS 或 Android。

## 如何开始使用？ {#how-do-i-get-started}

1. 从[下载页面](/download/)获取适合你系统的安装程序。
2. 按照[安装](./installation.md)中对应平台的步骤操作。
3. 跟着[快速上手](./quick-start.md)，录制、修剪并导出你的第一个视频。

## 资料来源 {#sources}

核查于 2026 年 9 月：

- 原始仓库及其归档声明：[github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- 官方 Homebrew tap：[github.com/getopenscreen/homebrew-openscreen](https://github.com/getopenscreen/homebrew-openscreen)
- Open Screen：[openscreen.io](https://openscreen.io/)
- Vorssaint 的 *Quit on close* 选项（核查于 2026 年 10 月）：[github.com/vorssaint/vorssaint-utils](https://github.com/vorssaint/vorssaint-utils)

Open Screen、Loom、OBS Studio 以及本页提及的其他产品名称，均为其各自所有者的商标。OpenScreen 与 Open Screen（openscreen.io）、Loom 或 OBS Studio 均无关联。
