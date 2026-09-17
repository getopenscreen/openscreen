---
id: installation
title: 在 Windows、macOS 與 Linux 上安裝 OpenScreen
sidebar_label: 安裝
sidebar_position: 2
description: "透過 Microsoft Store 或 winget、經過公證的 macOS .dmg，或 Linux 的 .deb、.rpm、.pacman、AppImage 與 Nix 安裝 OpenScreen，並附上各平台的系統需求。"
keywords:
  - 螢幕錄影軟體 安裝
  - 下載 OpenScreen
  - Microsoft Store
  - winget
  - macOS dmg
  - Windows 安裝程式
  - Linux deb
  - Fedora rpm
  - AppImage
  - Nix flake
---

# 在 Windows、macOS 與 Linux 上安裝 OpenScreen

在 Windows 上，建議的安裝方式是 [Microsoft Store](#windows)。其他平台請從[下載頁面](/download/)下載適用於你平台的最新安裝程式，或直接到 [GitHub Releases](https://github.com/getopenscreen/openscreen/releases) 下載。

## 系統需求 {#system-requirements}

| | 最低需求 | 建議配備 |
|---|---|---|
| **Windows** | Windows 10 版本 1903（組建 18362）或更新版本，x64，Intel 第 8 代／AMD Ryzen 2000 系列或更新的處理器。原生擷取需要 Windows 10 版本 2004（組建 19041）或更新版本；較舊的組建會透過[瀏覽器擷取備援](#platform-differences)錄影 | Windows 11，Intel 第 12 代／AMD Ryzen 4000 系列或更新的處理器 |
| **macOS** | macOS 13（Ventura），這是 ScreenCaptureKit 擷取的必要條件 | macOS 14 或更新版本 |
| **Linux** | x64。錄影需要 `xdg-desktop-portal` 與 PipeWire：原生擷取輔助程式會透過它們運作，那裡發生的失敗會以錯誤回報。只有在某個組建本身缺少輔助程式時，[瀏覽器擷取備援](#platform-differences)才會接手。系統音訊另外需要以 PipeWire 作為音效伺服器（[Ubuntu 22.10 以上](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976)與 [Fedora 34 以上](https://fedoraproject.org/wiki/Changes/DefaultPipeWire)的預設）。在 Wayland 上記錄滑鼠點擊，需要你的使用者屬於 `input` 群組，詳見 [Wayland 上的滑鼠點擊](#mouse-clicks-on-wayland) | 相同，並保持更新 |
| **記憶體** | 8 GB | 16 GB |

:::note Windows 上較舊的內建顯示晶片
內建顯示晶片早於約第 8 代 Intel（或同級 AMD Ryzen 2000 系列）的電腦並不會被禁止安裝，但其中有些機型存在已知的驅動程式穩定性問題，可能導致錄影無法停止與儲存，詳見 [#460](https://github.com/getopenscreen/openscreen/issues/460)。如果遇到這個問題，請在失敗後立即（在開始下一段錄影之前）開啟系統匣圖示或 **說明 → 儲存診斷資料**，並將產生的檔案附加到錯誤回報中。
:::

## macOS {#macos}

從 [Releases](https://github.com/getopenscreen/openscreen/releases) 下載 `.dmg` 安裝檔，然後將 OpenScreen 拖曳到「應用程式」資料夾。從 1.9.0 開始的版本都以 Developer ID 憑證簽署，並經過 Apple 公證，因此 Gatekeeper 不會阻擋，也不需要在終端機進行任何操作。

接著前往 **系統設定 → 隱私權與安全性**，將 **螢幕錄製** 與 **輔助使用** 權限授予 OpenScreen。「螢幕錄製」是讓它能夠擷取畫面的必要權限。「輔助使用」則是預設的可編輯游標記錄游標形狀與點擊時所需要的：在這個模式下，若沒有這項權限就按下錄製，會開啟一個連到該設定的提示；授予權限後再按一次錄製，錄影就會開始。

:::note macOS 15 及更新版本會定期重新詢問
macOS 會不時針對每一款第三方螢幕錄影軟體重新要求螢幕錄製權限。這個提示來自作業系統本身，並不代表你的安裝有問題或更新出了差錯。被詢問時，再次授予權限即可。
:::

:::tip 從 1.9.0 之前的版本升級？
那些版本並未以 Developer ID 憑證簽署，而 macOS 會將「螢幕錄製」與「輔助使用」的授權綁定在應用程式的簽章上，因此它無法判斷新版本是同一個應用程式，你先前授予舊版本的權限也不會延續。如果新版本在授予權限後仍無法錄影，請在「系統設定」中移除 OpenScreen 在這兩項權限下的項目，然後重新啟動它，再重新授予權限。
:::

## Windows {#windows}

**建議：Microsoft Store。** [從 Microsoft Store 取得 OpenScreen](https://apps.microsoft.com/detail/9MXQ1HQJL5G5)，或從終端機安裝同一個套件：

```powershell
winget install --source msstore OpenScreen
```

Microsoft 會在認證過程中簽署 Store 套件，因此安裝時不會出現安全性警告，而且 Store 會讓它保持在最新版本。

**替代方案：獨立安裝程式。** 如果你無法使用 Store（例如 Windows LTSC、受到管控的公司電腦、離線安裝，或需要特定的舊版本），請從 [Releases](https://github.com/getopenscreen/openscreen/releases) 下載並執行 `.exe`。

:::note .exe 的 SmartScreen 警告
`.exe` 沒有程式碼簽署，因此 Windows SmartScreen 會顯示 **Windows 已保護您的電腦**，並指出發行者不明。請選擇 **其他資訊 → 仍要執行** 繼續安裝。請只從 Releases 頁面下載 `.exe`；如果你想要已簽署的套件，請使用 Store 版。
:::

## Linux {#linux}

每個版本都會發布四種 x64 套件，請選擇符合你發行版的那一種。在 aarch64 上，請使用下方從原始碼建置的 Nix flake。

**Debian／Ubuntu／Pop!_OS**
```bash
sudo apt install ./Openscreen-Linux-*.deb
```

**Fedora／RHEL／CentOS**
```bash
sudo dnf install ./Openscreen-Linux-*.rpm
```

**Arch／Manjaro**
```bash
sudo pacman -U Openscreen-Linux-*.pacman
```

**任何發行版（AppImage）**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

如果 AppImage 因沙箱錯誤而無法啟動：
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS／Nix（flake）**

免安裝直接試用：
```bash
nix run github:getopenscreen/openscreen
```

安裝到你的使用者設定檔：
```bash
nix profile install github:getopenscreen/openscreen
```

作為 NixOS 系統模組：
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

Home Manager 使用者可以搭配相同的 `programs.openscreen.enable = true;` 使用 `openscreen.homeManagerModules.default`。

視你的桌面環境而定，你可能需要授予螢幕錄製權限。

### Wayland 上的滑鼠點擊 {#mouse-clicks-on-wayland}

Wayland 沒有提供輸入事件的 portal，因此 OpenScreen 改為直接從核心的 evdev 介面（`/dev/input/event*`）讀取左鍵按下的事件。這些裝置節點的擁有者是 `root:input`，所以只有在你的使用者屬於 `input` 群組時，錄影才能分辨點擊與一般的游標移動：

```bash
sudo usermod -aG input $USER
```

登出後再重新登入，新群組才會生效。沒有這項設定也不會出問題：錄影的運作與先前完全相同，每個游標取樣都只會被記錄為移動。

讀取範圍刻意限縮：只會讀取滑鼠左鍵（`BTN_LEFT`），絕不讀取鍵盤輸入。即使在已有權限的環境中，若要完全關閉這個讀取功能，請在啟動 OpenScreen 的環境中設定 `OPENSCREEN_DISABLE_CLICK_CAPTURE=1`。

:::caution
`input` 群組並不只對 OpenScreen 生效：加入後，以你的使用者身分執行的任何程式都能讀取所有輸入裝置，包括鍵盤。請只在你能接受這一點的電腦上加入這個群組。
:::

**觸控板：** 只有實體點擊（把觸控板按下去，直到它確實下沉）才會被記錄。**輕觸點按不會被記錄**，因為你的合成器的輸入堆疊（libinput）會自行合成這些輕觸，供它自己使用，而且從不寫回 OpenScreen 所讀取的核心裝置，所以在 evdev 層根本看不到它們。使用滑鼠，或關閉輕觸點按功能的觸控板，則每次點擊都會被記錄。

## 平台差異 {#platform-differences}

剪輯工具在所有平台上都相同：縮放、背景、裁切／修剪／變速、標註、轉錄、字幕與專案。每種匯出格式在每個平台上都能使用；不同的是**擷取**方式，以及 Linux 的 MP4 匯出可以使用哪種編碼器：

| | macOS | Windows | Linux |
|---|---|---|---|
| 擷取管線 | 原生（ScreenCaptureKit） | 組建 19041 及更新版本為原生（Windows Graphics Capture）；較舊的組建或缺少輔助程式時，改用瀏覽器擷取備援 | 原生（透過 ScreenCast portal 的 PipeWire）；缺少輔助程式時改用瀏覽器擷取備援，但會失去硬體編碼與游標遙測資料 |
| 自訂游標主題／點擊效果 | ✅，點擊與游標形狀需要「輔助使用」權限 | ✅ | ✅ 支援 Wayland，點擊擷取需要 `input` 群組（[詳細說明](#mouse-clicks-on-wayland)） |
| 網路攝影機 | 瀏覽器擷取，另存為獨立檔案（仍可作為子母畫面使用） | 原生擷取，另存為獨立檔案 | 瀏覽器擷取，另存為獨立檔案（仍可作為子母畫面使用） |
| 系統音訊 | 開箱即用；macOS 14.2 以上會出現權限提示 | 開箱即用 | 需要以 PipeWire 作為音效伺服器（Ubuntu 22.10 以上、Fedora 34 以上的預設） |
| MP4 匯出 | ✅ | ✅ | ✅，GPU 堆疊允許時，H.264 會透過 VAAPI 在 GPU 上編碼（見下方說明），否則使用軟體編碼；H.265 僅支援軟體編碼 |
| GIF 匯出 | ✅ | ✅ | ✅ |
| 本機轉錄 | Metal（Apple Silicon）／CPU | Vulkan／CPU | Vulkan／CPU |

:::note Linux 上的 MP4 匯出
負責即時預覽與 MP4 匯出的 GPU 合成器有三種後端（Windows 上是 Direct3D 11，macOS 上是 Metal，Linux 上是 wgpu/WGSL），三個版本都內建。在 Linux 上，當 GPU 驅動程式提供 VAAPI，*而且* Vulkan 裝置能以 dmabuf 形式交出影格（`VK_KHR_external_memory_fd` 與 `VK_EXT_external_memory_dma_buf`）時，H.264 匯出會把每個合成完成的影格直接交給 `h264_vaapi`，不經過 CPU 複製。只要缺少其中任何一項（沒有算繪節點、驅動程式不支援 VAAPI、Vulkan 裝置沒有這些擴充功能），匯出就會改用軟體編碼器，只是花的時間比較長，其他都不變。在 Linux 上，H.265 匯出一律使用軟體編碼器。
:::

OpenScreen 在各系統上的功能，以及何時其他工具更適合，整理在 [Windows](/screen-recorder-windows/)、[Mac](/screen-recorder-mac/) 與 [Linux](/screen-recorder-linux/) 頁面中。

下一步：[快速入門](./quick-start.md)會帶你完成第一次錄影。
