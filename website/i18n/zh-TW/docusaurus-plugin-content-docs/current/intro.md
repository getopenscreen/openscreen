---
id: intro
title: "OpenScreen 說明文件：安裝、錄影、剪輯、匯出"
sidebar_label: 簡介
sidebar_position: 1
description: "OpenScreen 1.11.0 說明文件。這款採用 MIT 授權的螢幕錄影與剪輯軟體，可在 Windows、macOS 與 Linux 上安裝，並用來錄影、剪輯、加上字幕與匯出影片。"
keywords:
  - 螢幕錄影軟體
  - 開源螢幕錄影
  - 免費螢幕錄影軟體
  - 影片剪輯軟體
  - OpenScreen 說明文件
  - Windows
  - macOS
  - Linux
---

# OpenScreen 說明文件：安裝、錄影、剪輯、匯出

OpenScreen 是一款**免費、開源的螢幕錄影與剪輯軟體**。它透過各平台的原生擷取 API 錄影（macOS 上是 ScreenCaptureKit，Windows 上是 Windows Graphics Capture，Linux 上是經由 ScreenCast portal 的 PipeWire），並以原生的 Rust 算繪器在 GPU 上合成即時預覽與最終匯出的畫面（Windows 上是 Direct3D 11，macOS 上是 Metal，Linux 上是 wgpu）。預覽與匯出走同一條路徑，所以你在編輯器裡看到的，就是匯出後的結果。

本文件說明的是 **OpenScreen 1.11.0**，也就是 2026 年 9 月 9 日發布的穩定版。每個版本改了什麼、為什麼改，都記錄在[開發日誌（英文）](/blog/)中。

:::note
OpenScreen 發布頻繁。在兩個版本之間，`.openscreen` 專案格式與 [CLI](/docs/cli/) 仍可能有所變更。
:::

## 你可以做什麼 {#what-you-can-do}

- [錄製](./recording.md)特定視窗或整個螢幕，同時收錄系統音訊、麥克風與網路攝影機；可以從浮動的 HUD 開始，也可以直接在編輯器裡開始。
- 用多個來源組成一個專案：在同一條時間軸上[匯入、修剪、裁切、重新排序與分割片段](./media-library.md)。
- 用縮放、修剪、分段變速、全螢幕攝影機片段、文字／圖片／箭頭／模糊標註、游標主題、網路攝影機版面，以及背景與效果來[剪輯](./editing-timeline.md)。
- 用 Whisper 在本機轉錄，然後[把字幕燒錄進影片](./captions.md)：字幕樣式可以即時調整，也能透過你自己的 LLM 提供者翻譯成 15 種語言；你也可以從逐字稿刪除字詞來剪輯錄影。
- 可選擇連接你自己的 LLM 金鑰，[用聊天來剪輯](./ai-editing.md)：此功能預設關閉，也絕非必要。
- [匯出](./export.md)成 MP4（720p／1080p／Source，H.264 或 H.265）或 GIF 動畫。

授權、浮水印，以及哪些資料會經過網路等問題，都在[常見問題](/docs/faq/)中解答。OpenScreen 與其他錄影軟體的比較，請見 [Screen Studio](/alternatives/screen-studio/)、[Cap](/compare/openscreen-vs-cap/) 與 [OBS Studio](/compare/openscreen-vs-obs/) 頁面。

:::note
錄影、剪輯、轉錄、字幕與匯出都不需要帳號，沒有網路連線也能繼續使用。轉錄需要先下載一次：第一次執行時會取得 Whisper 模型（約 264 MB）。有網路連線時，應用程式啟動時也會從 Google Fonts 載入標註用的字體，而從 GitHub Releases 安裝的版本會向 GitHub 檢查更新。AI 聊天剪輯與字幕翻譯，只有在你自行連接提供者之後才會連線，而且只會連到該提供者。
:::

## 專案概況 {#project-facts}

| | |
|---|---|
| **授權** | MIT：個人與商業用途皆免費 |
| **文件對應版本** | 1.11.0（[所有版本](https://github.com/getopenscreen/openscreen/releases)） |
| **平台** | Windows 10 版本 1903 或更新版本（x64）、macOS 13 或更新版本（Apple Silicon 與 Intel）、Linux（x64 套件；aarch64 透過 Nix flake），詳見[安裝](./installation.md) |
| **由來** | 由 Siddharth Vaddem 建立，他在 v1.5.0 之後[封存了原始儲存庫](https://github.com/siddharthvaddem/openscreen)。在他的同意下，開發工作在這裡繼續進行，沿用相同的名稱與相同的 MIT 授權。 |

## 官方連結 {#official-links}

| | |
|---|---|
| **網站** | [getopenscreen.com](https://getopenscreen.com/) |
| **原始碼、版本、問題回報** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## 本網站的狀態 {#status-of-this-site}

側邊欄**功能**底下的所有頁面，說明的都是應用程式目前實際提供的內容，而不是開發藍圖。本網站所依據的更深入內部規格（架構筆記、工程文件、測試計畫）仍放在儲存庫中，尚未移到這裡（皆為英文）：

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
