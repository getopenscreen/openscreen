---
id: intro
title: "OpenScreen 文档：安装、录制、编辑、导出"
sidebar_label: 简介
sidebar_position: 1
description: "OpenScreen 1.11.0 文档。这是一款采用 MIT 许可证的录屏与剪辑软件：先安装，再在 Windows、macOS 和 Linux 上录制、编辑、添加字幕并导出。"
keywords:
  - 录屏软件
  - 开源录屏软件
  - 免费录屏软件
  - 视频剪辑软件
  - OpenScreen 文档
  - Windows
  - macOS
  - Linux
---

# OpenScreen 文档：安装、录制、编辑、导出

OpenScreen 是一款**免费、开源的录屏与剪辑软件**。它通过各平台的原生采集 API 录制（macOS 上是 ScreenCaptureKit，Windows 上是 Windows Graphics Capture，Linux 上是经由 ScreenCast 门户的 PipeWire），并用原生 Rust 渲染器在 GPU 上合成实时预览和最终导出（Windows 上是 Direct3D 11，macOS 上是 Metal，Linux 上是 wgpu）。两者走的是同一条路径，所以你在编辑器里看到的，就是导出的结果。

本文档介绍的是 **OpenScreen 1.11.0**，即 2026 年 9 月 9 日发布的稳定版。每个版本改了什么、为什么改，都记录在[开发日志（英文）](/blog/)中。

:::note
OpenScreen 发布频繁。在两个版本之间，`.openscreen` 项目格式和 [CLI](/docs/cli/) 仍可能发生变化。
:::

## 你可以做什么 {#what-you-can-do}

- 连同系统音频、麦克风和摄像头，[录制](./recording.md)某个窗口或整个屏幕，可以从悬浮的 HUD 开始，也可以直接在编辑器里开始。
- 用多个来源组建一个项目：在同一条时间轴上[导入、修剪、裁剪、重新排序和拆分片段](./media-library.md)。
- 用缩放、剪辑区间、分区间变速、全屏摄像头区间、文本/图片/箭头/模糊标注、光标主题、摄像头布局以及背景和效果来[编辑](./editing-timeline.md)。
- 用 Whisper 在本机转录，然后[烧录字幕](./captions.md)：字幕样式可实时调整，也可以通过你自己的 LLM 提供方翻译成 15 种语言；你还可以在转录文本中删除词语来剪切录制内容。
- 可以选择连接你自己的 LLM 密钥，[通过聊天来编辑](./ai-editing.md)：此功能默认关闭，任何时候都不是必需的。
- [导出](./export.md)为 MP4（720p/1080p/Source，H.264 或 H.265）或 GIF 动图。

关于许可证、水印以及哪些内容会通过网络传输的问题，请参阅[常见问题](/docs/faq/)。OpenScreen 与其他录屏软件的对比，见 [Screen Studio](/alternatives/screen-studio/)、[Cap](/compare/openscreen-vs-cap/) 和 [OBS Studio](/compare/openscreen-vs-obs/) 页面。

:::note
录制、编辑、转录、字幕和导出都不需要账号，没有网络连接也能照常使用。转录需要先下载一次：首次运行时会获取它的 Whisper 模型（约 264 MB）。有网络连接时，应用还会在启动时从 Google Fonts 加载标注所用的字体，从 GitHub Releases 安装的版本也会向 GitHub 检查更新。AI 聊天编辑和字幕翻译只有在你亲自连接提供方之后才会联网，并且只连接该提供方。
:::

## 项目概况 {#project-facts}

| | |
|---|---|
| **许可证** | MIT：个人和商业用途均免费 |
| **文档对应版本** | 1.11.0（[所有版本](https://github.com/getopenscreen/openscreen/releases)） |
| **平台** | Windows 10 版本 1903 或更高（x64），macOS 13 或更高（Apple Silicon 和 Intel），Linux（x64 软件包；aarch64 通过 Nix flake 支持）。详见[安装](./installation.md) |
| **由来** | 由 Siddharth Vaddem 创建，他在 v1.5.0 之后[归档了原始仓库](https://github.com/siddharthvaddem/openscreen)。经他同意，开发在这里继续进行，沿用相同的名称和相同的 MIT 许可证。 |

## 官方链接 {#official-links}

| | |
|---|---|
| **网站** | [getopenscreen.com](https://getopenscreen.com/) |
| **源代码、版本发布、Issue** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## 本站现状 {#status-of-this-site}

侧边栏中**功能**下的所有页面，记录的都是应用目前实际提供的功能，而不是路线图。本站所依据的更深入的内部规格（架构说明、工程文档、测试计划）仍保存在仓库中，尚未迁移到这里（均为英文）：

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
