---
id: installation
title: "Windows・macOS・Linux へのインストール"
sidebar_label: インストール
sidebar_position: 2
description: "OpenScreen を Microsoft Store や winget、公証済みの macOS 用 .dmg、Linux 用の .deb・.rpm・.pacman・AppImage・Nix でインストールする方法と、システム要件を解説します。"
keywords:
  - 画面録画ソフト インストール
  - OpenScreen ダウンロード
  - Microsoft Store
  - winget
  - macOS dmg
  - Windows インストーラー
  - Linux deb
  - Fedora rpm
  - AppImage
  - Nix flake
---

# OpenScreen のインストール（Windows・macOS・Linux）

Windows では [Microsoft Store](#windows) からのインストールをおすすめします。それ以外のプラットフォームでは、[ダウンロードページ](/download/)または [GitHub Releases](https://github.com/getopenscreen/openscreen/releases) から、お使いのプラットフォーム向けの最新のインストーラーをダウンロードしてください。

## システム要件 {#system-requirements}

| | 最小 | 推奨 |
|---|---|---|
| **Windows** | Windows 10 バージョン 1903（ビルド 18362）以降、x64、Intel 第 8 世代 / AMD Ryzen 2000 シリーズ以降。ネイティブキャプチャには Windows 10 バージョン 2004（ビルド 19041）以降が必要で、それより古いビルドでは[ブラウザーキャプチャへのフォールバック](#platform-differences)で録画します | Windows 11、Intel 第 12 世代 / AMD Ryzen 4000 シリーズ以降 |
| **macOS** | macOS 13（Ventura）。キャプチャに使う ScreenCaptureKit の要件です | macOS 14 以降 |
| **Linux** | x64。録画には `xdg-desktop-portal` と PipeWire が必要です。ネイティブのキャプチャヘルパーはこれらを経由し、そこで失敗するとエラーとして報告されます。[ブラウザーキャプチャへのフォールバック](#platform-differences)に切り替わるのは、ビルドにヘルパー自体が含まれていない場合だけです。システム音声には、さらにサウンドサーバーとして PipeWire が必要です（[Ubuntu 22.10 以降](https://discourse.ubuntu.com/t/kinetic-kudu-release-notes/27976)と [Fedora 34 以降](https://fedoraproject.org/wiki/Changes/DefaultPipeWire)では既定）。Wayland でマウスのクリックを記録するには、ユーザーが `input` グループに属している必要があります。[Wayland でのマウスクリック](#mouse-clicks-on-wayland)を参照してください | 同じ構成を最新の状態に保ったもの |
| **RAM** | 8 GB | 16 GB |

:::note Windows の古い内蔵グラフィックス
おおむね第 8 世代 Intel（または同等の AMD Ryzen 2000 シリーズ）より古い内蔵グラフィックスを搭載したマシンでも、インストールはブロックされません。ただし一部の環境には既知のドライバーの安定性の問題があり、録画の停止と保存に失敗することがあります（[#460](https://github.com/getopenscreen/openscreen/issues/460) を参照）。この問題が起きた場合は、失敗の直後に（次の録画を始める前に）トレイアイコンか**ヘルプ → 診断情報を保存**を開き、保存されたファイルをバグ報告に添付してください。
:::

## macOS {#macos}

[Releases](https://github.com/getopenscreen/openscreen/releases) から `.dmg` インストーラーをダウンロードし、OpenScreen を「アプリケーション」フォルダーにドラッグします。1.9.0 以降のビルドは Developer ID 証明書で署名され、Apple の公証を受けています。そのため Gatekeeper にブロックされず、ターミナルでの操作も必要ありません。

次に、**システム設定 → プライバシーとセキュリティ**を開き、OpenScreen に**画面収録**と**アクセシビリティ**を許可します。画面収録は、そもそもキャプチャを行うための権限です。アクセシビリティは、既定の編集可能なカーソルのモードでカーソルの形状とクリックを記録するために必要です。このモードでは、アクセシビリティを許可していない状態で録画を押すと、設定へのリンクを含む確認画面が開きます。許可してからもう一度録画を押すと、録画が始まります。

:::note macOS 15 以降では定期的に再確認されます
macOS は、サードパーティ製のすべての画面録画ソフトに対して、ときどき画面収録の許可を求め直します。この確認はオペレーティングシステムが表示するもので、インストールが壊れていることや、アップデートに失敗したことを意味するものではありません。求められたら、もう一度許可してください。
:::

:::tip 1.9.0 より前のバージョンからアップグレードする場合
それらのビルドは Developer ID 証明書で署名されていませんでした。macOS は画面収録とアクセシビリティの許可をアプリの署名に結び付けているため、新しいビルドが同じアプリだと判断できず、古いビルドに与えた許可は引き継がれません。許可したあとも新しいバージョンで録画できない場合は、システム設定で両方の権限から OpenScreen の項目を削除し、アプリを起動し直して、改めて許可してください。
:::

## Windows {#windows}

**推奨：Microsoft Store。** [Microsoft Store で OpenScreen を入手する](https://apps.microsoft.com/detail/9MXQ1HQJL5G5)か、ターミナルから同じパッケージをインストールします。

```powershell
winget install --source msstore OpenScreen
```

Store のパッケージは認定の過程で Microsoft が署名するため、セキュリティの警告なしでインストールでき、Store が最新の状態に保ちます。

**別の方法：スタンドアロンのインストーラー。** Store を使えない場合（Windows LTSC、制限の厳しい業務用マシン、オフラインでのインストール、特定の古いバージョンが必要な場合など）は、[Releases](https://github.com/getopenscreen/openscreen/releases) から `.exe` をダウンロードして実行してください。

:::note .exe での SmartScreen の警告
`.exe` はコード署名されていないため、Windows SmartScreen が **Windows によって PC が保護されました** と表示し、発行元が不明であると報告します。続行するには、**詳細情報 → 実行**を選んでください。`.exe` は必ず Releases ページからダウンロードしてください。署名済みのパッケージが必要な場合は、Store 版を使ってください。
:::

## Linux {#linux}

リリースごとに 4 種類の x64 パッケージを公開しています。お使いのディストリビューションに合うものを選んでください。aarch64 では、ソースからビルドする下記の Nix flake を使ってください。

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

**すべてのディストリビューション（AppImage）**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

AppImage がサンドボックスのエラーで起動しない場合：
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix（flake）**

インストールせずに試す：
```bash
nix run github:getopenscreen/openscreen
```

ユーザープロファイルにインストールする：
```bash
nix profile install github:getopenscreen/openscreen
```

NixOS のシステムモジュールとして使う：
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

Home Manager を使っている場合は、`openscreen.homeManagerModules.default` を同じ `programs.openscreen.enable = true;` とともに使えます。

デスクトップ環境によっては、画面録画の権限を許可する必要があります。

### Wayland でのマウスクリック {#mouse-clicks-on-wayland}

Wayland には入力イベント用のポータルがないため、OpenScreen は代わりに、カーネルの evdev インターフェース（`/dev/input/event*`）から左ボタンの押下を直接読み取ります。これらのデバイスノードの所有者は `root:input` です。そのため、録画でクリックを通常のカーソル移動と区別できるのは、ユーザーが `input` グループに属している場合だけです。

```bash
sudo usermod -aG input $USER
```

新しいグループを有効にするには、いったんログアウトしてから再ログインしてください。この設定がなくても何も壊れません。録画はこれまでとまったく同じように動作し、カーソルのサンプルがすべて移動として記録されるだけです。

読み取る範囲は意図的に狭くしています。読み取るのは左マウスボタン（`BTN_LEFT`）だけで、キー入力は一切読み取りません。権限がある環境でもこの読み取りを完全にオフにするには、OpenScreen を起動する環境で `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` を設定してください。

:::caution
`input` グループは OpenScreen だけのものではありません。追加すると、あなたのユーザーで動くすべてのプログラムが、キーボードを含むすべての入力デバイスを読み取れるようになります。このマシンでそれを許容できる場合にのみ追加してください。
:::

**タッチパッド：** 記録されるのは物理的なクリック（パッドを沈み込むまで押す操作）だけです。**タップによるクリックは記録されません。** タップはコンポジターの入力スタック（libinput）が自身のために合成するもので、OpenScreen が読み取るカーネルデバイスには書き戻されないため、evdev の層には何も現れないからです。マウスや、タップによるクリックをオフにしたタッチパッドなら、すべてのクリックが記録されます。

## プラットフォームごとの違い {#platform-differences}

編集ツールはどのプラットフォームでも同じです（ズーム、背景、クロップ・トリム・再生速度、注釈、文字起こし、字幕、プロジェクト）。すべてのエクスポート形式がすべてのプラットフォームで使えます。違うのは**キャプチャ**と、Linux の MP4 エクスポートで使えるエンコーダーです。

| | macOS | Windows | Linux |
|---|---|---|---|
| キャプチャの仕組み | ネイティブ（ScreenCaptureKit） | ビルド 19041 以降はネイティブ（Windows Graphics Capture）。それより古いビルドやヘルパーがない場合はブラウザーにフォールバック | ネイティブ（ScreenCast ポータル経由の PipeWire）。ヘルパーがない場合はブラウザーにフォールバックし、ハードウェアエンコードとカーソルテレメトリは使えなくなる |
| カスタムカーソルテーマ / クリックエフェクト | ✅ クリックとカーソルの形状にはアクセシビリティの権限が必要 | ✅ | ✅ Wayland で対応。クリックのキャプチャには `input` グループが必要（[詳細](#mouse-clicks-on-wayland)） |
| ウェブカメラ | ブラウザーでキャプチャし、別ファイルとして保存（PiP としても引き続き使用可能） | ネイティブでキャプチャし、別ファイルとして保存 | ブラウザーでキャプチャし、別ファイルとして保存（PiP としても引き続き使用可能） |
| システム音声 | 設定不要で動作。macOS 14.2 以降では許可の確認あり | 設定不要で動作 | サウンドサーバーとして PipeWire が必要（Ubuntu 22.10 以降、Fedora 34 以降では既定） |
| MP4 エクスポート | ✅ | ✅ | ✅ GPU スタックが対応していれば VAAPI 経由で H.264 を GPU でエンコード（下の注記を参照）、それ以外はソフトウェア。H.265 はソフトウェアのみ |
| GIF エクスポート | ✅ | ✅ | ✅ |
| 端末上での文字起こし | Metal（Apple Silicon）/ CPU | Vulkan / CPU | Vulkan / CPU |

:::note Linux での MP4 エクスポート
ライブプレビューと MP4 エクスポートを担う GPU コンポジターには、3 つのバックエンド（Windows では Direct3D 11、macOS では Metal、Linux では wgpu/WGSL）があり、3 つのビルドすべてに含まれています。Linux では、GPU ドライバーが VAAPI に対応し、*かつ* Vulkan デバイスがフレームを dmabuf として受け渡せる（`VK_KHR_external_memory_fd` と `VK_EXT_external_memory_dma_buf`）場合、H.264 エクスポートは合成した各フレームを CPU へコピーせずに `h264_vaapi` に渡します。そのどれかが欠けている場合（レンダーノードがない、ドライバーが VAAPI に対応していない、Vulkan デバイスがこれらの拡張に対応していない）、エクスポートはソフトウェアエンコーダーにフォールバックし、時間が長くかかるだけで、ほかには何も変わりません。Linux では、H.265 のエクスポートは常にソフトウェアエンコーダーを使います。
:::

各 OS で OpenScreen ができること、そしてほかのツールのほうが適している場合については、[Windows](/screen-recorder-windows/)、[Mac](/screen-recorder-mac/)、[Linux](/screen-recorder-linux/) の各ページにまとめています。

次は、[クイックスタート](./quick-start.md)で最初の録画の手順を説明します。
