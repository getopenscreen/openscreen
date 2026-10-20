---
id: faq
title: "OpenScreen 常見問題：授權、隱私與連結"
sidebar_label: 常見問題
description: "OpenScreen 可以免費用於商業用途嗎？可以，它採用 MIT 授權。本頁也解答浮水印、離線使用、隱私、安裝程式簽署與官方連結等常見問題。"
keywords:
  - OpenScreen 常見問題
  - 商業用途 免費
  - MIT 授權
  - 無浮水印
  - 離線螢幕錄影
  - OpenScreen 原始專案
---

# OpenScreen 常見問題

OpenScreen 是一款採用 MIT 授權的免費螢幕錄影與影片剪輯軟體，支援 Windows、macOS 與 Linux。它可以免費用於商業用途，不需要帳號，也沒有浮水印。本頁解答大家在安裝前常問的問題：授權、哪些資料會經過網路、安裝程式如何簽署，以及哪些網站是官方網站。它和 openscreen.io 上的 Open Screen 並不是同一個產品。

## OpenScreen 可以免費用於商業用途嗎？ {#is-openscreen-free-for-commercial-use}

**可以。** OpenScreen 以 [MIT 授權](https://github.com/getopenscreen/openscreen/blob/main/LICENSE)釋出。

- 你可以使用、複製、修改、散布與販售它。唯一的條件是在軟體的副本中保留著作權聲明與許可聲明。
- 授權條款涵蓋的是軟體本身，並未提及你用它製作的影片。
- 沒有帳號，沒有付費方案，也沒有進階功能。

## OpenScreen 會加上浮水印嗎？ {#does-openscreen-add-a-watermark}

**不會。** MP4 與 GIF 匯出都沒有浮水印，也沒有需要付費才能移除浮水印的版本。格式說明請見[匯出](./export.md)。

## OpenScreen 可以離線使用嗎？ {#does-openscreen-work-offline}

**錄影、轉錄與算繪都在你的電腦上執行。** OpenScreen 沒有上傳功能，所以你的錄影會留在你的磁碟上。不過應用程式仍會建立一些網路連線，因此說它「完全離線」並不正確：

- **huggingface.co，只有一次。** 第一次轉錄時會下載 Whisper 模型（約 264 MB）與一個小於 1 MB 的語音偵測模型，每個都以 SHA-256 雜湊值驗證。之後轉錄就不再需要網路連線。
- **github.com，每種語言一次。** 在有 GPU 的電腦上，第一次進行英文或法文轉錄時，還會下載為每個字詞重新對時的模型：英文約 110 MB，法文約 350 MB。
- **github.com 與 api.github.com。** 會自行更新的版本每 24 小時檢查一次新版本，你手動要求時也會檢查。預設只會通知你有新版本可用。
- **fonts.googleapis.com，僅限 1.x 中加入的字體。** 在先前版本中加入的自訂標註字體仍會在啟動時載入，儘管 2.x 已不再繪製它。
- **PostHog，每天一次。** 活躍安裝數的匿名計數，會送到 PostHog 位於歐盟的伺服器。內容包括應用程式版本、作業系統、處理器架構、應用程式的安裝方式、應用程式是直接使用還是由 AI 代理透過其 MCP 伺服器使用，以及這是否為當週與當月的第一次計數。僅此而已：沒有安裝識別碼（每次計數都使用新的隨機 ID），不保留 IP 位址，也不含任何與你錄影有關的資訊。若要關閉，請在系統匣選單中取消勾選**傳送匿名使用計數**，或設定 `DO_NOT_TRACK=1`。
- **你的 AI 提供者，僅在你連接時。** 聊天剪輯會送出你的訊息，以及它讀取的專案資料，例如時間軸與逐字稿。字幕翻譯會送出字幕文字。在你連接提供者之前，這兩項功能都保持關閉。請參閱 [AI 剪輯](./ai-editing.md)。

## OpenScreen 會收集分析資料或當機報告嗎？ {#does-openscreen-collect-analytics-or-crash-reports}

**每天一次匿名計數，除此之外沒有別的。** 應用程式中沒有任何分析或當機回報 SDK，也沒有任何機制會記錄你在其中的操作。

- 應用程式每天回報一次有一個安裝處於活躍狀態。[OpenScreen 可以離線使用嗎？](#does-openscreen-work-offline)準確列出這項計數包含的內容與關閉方式。
- 這項計數不帶安裝識別碼：每次計數都使用新的隨機 ID，其中也沒有其他專屬於你電腦的資訊。
- AI 提供者的金鑰會透過 Electron 的 `safeStorage` 加密儲存。如果無法加密，金鑰就不會被儲存。

## 安裝 OpenScreen 安全嗎？ {#is-openscreen-safe-to-install}

**原始碼是公開的，macOS 版與 Store 版都有簽署。** 請只從[官方連結](#what-are-the-official-openscreen-links)中列出的網址下載。

- **macOS：** 從 1.9.0 開始的版本都以 Apple Developer ID 簽署，並經過公證。
- **Windows，Microsoft Store：** 套件由 Microsoft 簽署，因此安裝時不會出現警告。
- **Windows，`.exe` 安裝程式：** 沒有程式碼簽署。SmartScreen 會顯示「Windows 已保護您的電腦」。請選擇**其他資訊**，再選擇**仍要執行**，或改用 Store 版。

各平台的安裝步驟請見[安裝](./installation.md)。

## OpenScreen 可以在哪些系統上執行？ {#which-systems-does-openscreen-run-on}

| 系統 | 最低需求 | 套件 |
|---|---|---|
| macOS | 13 Ventura | 適用於 Apple Silicon 與 Intel 的 `.dmg` |
| Windows | 10 版本 1903，x64 或 ARM64 | Microsoft Store（x64）、`.exe` 安裝程式（x64 與 ARM64） |
| Linux | x64、PipeWire 與 xdg-desktop-portal | AppImage、`.deb`、`.rpm`、`.pacman`、Nix flake |

- 在 Windows 上，原生擷取需要組建 19041（Windows 10 版本 2004）。較舊的組建會改用瀏覽器擷取。
- 請準備 8 GB 記憶體，建議 16 GB。

## Windows 或 Linux 有 ARM64 版本嗎？ {#is-there-an-arm64-build-for-windows-or-linux}

**Windows 有。Linux 則只能透過 Nix。**

- Windows on ARM 在 [Releases](https://github.com/getopenscreen/openscreen/releases) 頁面上有自己的 `.exe` 安裝程式。Microsoft Store 套件只提供 x64。
- Linux 套件只提供 x64。在 ARM64 Linux 上，Nix flake 會為 `aarch64-linux` 從原始碼建置 OpenScreen。
- Apple Silicon Mac 有原生的 `.dmg`。

## 可以用 winget、Homebrew 或 Flathub 安裝 OpenScreen 嗎？ {#can-i-install-openscreen-with-winget-homebrew-or-flathub}

- **winget：** 可以，透過 Store 來源安裝：`winget install --source msstore OpenScreen`。
- **Homebrew：** 可以，透過官方 tap 安裝：`brew install --cask getopenscreen/openscreen/openscreen`。每次發布穩定版都會更新這個 cask。
- **Flathub：** 沒有上架。

## 這是原始的 OpenScreen 專案嗎？ {#is-this-the-original-openscreen-project}

**這是它的延續。**

- Siddharth Vaddem 建立了 OpenScreen，並在 v1.5.0 之後封存了[原始儲存庫](https://github.com/siddharthvaddem/openscreen)。
- 在他的同意下，開發工作移到了 [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen)，沿用相同的名稱與相同的 MIT 授權。
- 已封存的 README 稱本專案為由一位核心貢獻者主導、社群驅動的衍生專案。這位貢獻者就是負責維護本專案的 Etienne Lescot。README 中的連結 github.com/EtienneLescot/openscreen 會重新導向到目前的儲存庫。
- 已封存的儲存庫不會再有任何更新。交接經過請見 [Picking up OpenScreen（英文部落格文章）](/blog/2026/06/15/picking-up-openscreen/)。

## OpenScreen 和 openscreen.io 或 openscreen.net 有關嗎？ {#is-openscreen-related-to-openscreenio-or-openscreennet}

- **openscreen.io：** 沒有關係。那是另一個產品 Open Screen，其網站將它介紹為 macOS 的螢幕錄影軟體。OpenScreen 與它沒有任何關聯。
- **openscreen.net：** 不是 OpenScreen 的官方網站。

## OpenScreen 的官方連結有哪些？ {#what-are-the-official-openscreen-links}

| 項目 | 連結 |
|---|---|
| 網站 | [getopenscreen.com](https://getopenscreen.com/) |
| 原始碼、版本與問題回報 | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5?cid=website) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| 原始專案（已封存，唯讀） | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## 如果錄影中途被中斷會怎樣？ {#what-happens-if-a-recording-is-interrupted}

在 Windows 與 macOS 上，原生錄影程式會以每段一秒的方式寫入分段 MP4（fragmented MP4）。如果錄影中途被中斷，檔案仍可播放到最後一個完整的分段。

錯誤回報與功能請求請提交到 [GitHub issues](https://github.com/getopenscreen/openscreen/issues)。

## 為什麼在 macOS 上選擇要錄製的內容時，OpenScreen 會結束？ {#why-does-openscreen-quit-on-macos-when-i-choose-what-to-record}

**多半是另一個應用程式要求它結束。** 有些 Mac 工具一旦判定某個應用程式的最後一個視窗已經關閉，就會讓該應用程式結束。例如開啟後的 [Vorssaint](https://github.com/vorssaint/vorssaint-utils) **Quit on close** 選項。它不會把 OpenScreen 的錄製控制面板 HUD 算成視窗，因為 HUD 浮在其他視窗之上。因此，在下列任一情況發生後一兩秒，它就會讓 OpenScreen 結束：

- 在 macOS 15.2 及更新版本上，Apple 的系統選擇器開啟期間，HUD 會隱藏。
- 在 macOS 15.2 之前，選好之後，OpenScreen 自己的來源選擇視窗會關閉，因此應用程式可能在倒數期間消失。

OpenScreen 的結束方式和按下 ⌘Q 相同：沒有錯誤訊息，也沒有當機報告。

- **解決方法**：把 OpenScreen 加入該工具的例外清單，或關閉這個選項。在 Vorssaint 中依序進入 **Quit on close**、**Exceptions**、**Add app…**。
- **若要查看是哪個應用程式發出要求**，請在 OpenScreen 結束後立刻於終端機中執行下列指令。每一行中，時間後面的名稱就是送出結束要求的應用程式：

```sh
/usr/bin/log show --last 5m --info --style compact --predicate 'eventMessage CONTAINS "AESendMessage(aevt,quit"'
```

## 為什麼在 Windows 10 上無法點選錄製控制面板？ {#why-cant-i-click-the-recording-bar-on-windows-10}

**請更新到 OpenScreen 2.1.0：它修正了這個問題。** 在 2.0.0 中，於 Windows 10 以及 22H2 之前的 Windows 11 上，讓錄製控制面板不出現在影片裡的保護機制也會擋住對它的點選（[issue #1105](https://github.com/getopenscreen/openscreen/issues/1105)）。從 2.1.0 起，OpenScreen 在這些版本上不啟用這項保護，所以錄製控制面板可以接受點選。它因此可能會出現在你的錄影中。

如果你曾在 2.0.0 中設定 `OPENSCREEN_DISABLE_CONTENT_PROTECTION` 來繞過這個問題，請刪除它，然後登出 Windows 再重新登入：

```powershell
reg delete HKCU\Environment /v OPENSCREEN_DISABLE_CONTENT_PROTECTION /f
```

## OpenScreen 不做哪些事？ {#what-doesnt-openscreen-do}

如果你需要以下任何一項，OpenScreen 就不是合適的工具：

- **託管分享。** 沒有分享連結、雲端儲存、團隊工作區或留言功能。你的檔案會留在你的磁碟上。請參閱[以 OpenScreen 替代 Loom](/alternatives/loom/)。
- **直播。** 請參閱 [OpenScreen 與 OBS Studio 比較](/compare/openscreen-vs-obs/)。
- **字幕檔。** 字幕會燒錄進影片，沒有 SRT 或 VTT 匯出。請參閱[字幕](./captions.md)。
- **行動裝置。** 沒有行動應用程式，也不支援 iOS 或 Android 擷取。

## 如何開始使用？ {#how-do-i-get-started}

1. 從[下載頁面](/download/)取得適用於你系統的安裝程式。
2. 依照[安裝](./installation.md)中對應平台的步驟安裝。
3. 依照[快速入門](./quick-start.md)錄製、修剪並匯出第一支影片。

## 資料來源 {#sources}

2026 年 9 月查證：

- 原始儲存庫與其封存公告：[github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- 官方 Homebrew tap：[github.com/getopenscreen/homebrew-openscreen](https://github.com/getopenscreen/homebrew-openscreen)
- Open Screen：[openscreen.io](https://openscreen.io/)
- Vorssaint 的 *Quit on close* 選項（2026 年 10 月查證）：[github.com/vorssaint/vorssaint-utils](https://github.com/vorssaint/vorssaint-utils)

Open Screen、Loom、OBS Studio 以及本頁提到的其他產品名稱，均為其各自所有者的商標。OpenScreen 與 Open Screen（openscreen.io）、Loom 或 OBS Studio 均無關聯。
