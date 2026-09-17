---
id: intro
title: "ドキュメント：導入・録画・編集・エクスポート"
sidebar_label: 概要
sidebar_position: 1
description: "MIT ライセンスの画面録画・編集ソフト OpenScreen 1.11.0 のドキュメント。インストール方法と、Windows・macOS・Linux での録画、編集、字幕、エクスポートの手順を解説します。"
keywords:
  - 画面録画ソフト
  - 画面録画 オープンソース
  - 画面録画 無料
  - 動画編集ソフト
  - OpenScreen 使い方
  - Windows
  - macOS
  - Linux
---

# OpenScreen ドキュメント：インストール、録画、編集、エクスポート

OpenScreen は**無料・オープンソースの画面録画・編集ソフト**です。各プラットフォームのネイティブなキャプチャ API（macOS では ScreenCaptureKit、Windows では Windows Graphics Capture、Linux では ScreenCast ポータル経由の PipeWire）で録画し、ライブプレビューと最終的なエクスポートの両方を、ネイティブの Rust レンダラーで GPU 上で合成します（Windows では Direct3D 11、macOS では Metal、Linux では wgpu）。プレビューとエクスポートが同じ経路を通るため、エディターで見たものがそのままエクスポートされます。

このドキュメントは、2026 年 9 月 9 日に公開された安定版 **OpenScreen 1.11.0** について説明しています。各リリースで何がなぜ変わったかは、[開発ジャーナル（英語）](/blog/)にまとめています。

:::note
OpenScreen は頻繁にリリースされます。リリースの間に、`.openscreen` プロジェクト形式や [CLI](/docs/cli/) が変わることがまだあります。
:::

## できること {#what-you-can-do}

- 特定のウィンドウや画面全体を、システム音声、マイク、ウェブカメラとともに[録画](./recording.md)できます。録画はフローティング HUD からも、エディター自体からも開始できます。
- 複数のソースからプロジェクトを組み立てられます。1 本のタイムライン上で[クリップのインポート、トリム、クロップ、並べ替え、分割](./media-library.md)ができます。
- ズーム、トリム、範囲ごとの再生速度、フルスクリーンカメラのセグメント、テキスト・画像・矢印・ぼかしの注釈、カーソルテーマ、ウェブカメラのレイアウト、背景とエフェクトで[編集](./editing-timeline.md)できます。
- Whisper で端末上で文字起こしし、[字幕を焼き込めます](./captions.md)。字幕はリアルタイムにスタイルを変更でき、自分で接続した LLM プロバイダーを通じて 15 言語に翻訳できます。文字起こしから単語を削除して、録画をカットすることもできます。
- 必要なら自分の LLM キーを接続して、[チャットで編集](./ai-editing.md)できます。この機能は既定でオフで、必須ではありません。
- MP4（720p/1080p/Source、H.264 または H.265）やアニメーション GIF に[エクスポート](./export.md)できます。

ライセンス、透かし、ネットワーク通信についての質問には、[よくある質問](/docs/faq/)で回答しています。OpenScreen とほかの録画ソフトとの比較は、[Screen Studio](/alternatives/screen-studio/)、[Cap](/compare/openscreen-vs-cap/)、[OBS Studio](/compare/openscreen-vs-obs/) の各ページにあります。

:::note
録画、編集、文字起こし、字幕、エクスポートにはアカウントが不要で、ネットワークに接続していなくても動作します。ただし文字起こしには、最初に一度だけダウンロードが必要です。初回実行時に Whisper モデル（約 264 MB）を取得します。接続がある場合、アプリは起動時に注釈用のフォントを Google Fonts から読み込みます。また、GitHub Releases からインストールしたビルドは、GitHub でアップデートを確認します。AI チャット編集と字幕の翻訳が通信を行うのは、あなたが自分でプロバイダーを接続した場合だけで、通信先もそのプロバイダーだけです。
:::

## プロジェクト概要 {#project-facts}

| | |
|---|---|
| **ライセンス** | MIT（個人でも商用でも無料で利用可能） |
| **対象バージョン** | 1.11.0（[すべてのリリース](https://github.com/getopenscreen/openscreen/releases)） |
| **プラットフォーム** | Windows 10 バージョン 1903 以降（x64）、macOS 13 以降（Apple Silicon と Intel）、Linux（x64 パッケージ。aarch64 は Nix flake で対応）。詳しくは[インストール](./installation.md)を参照 |
| **経緯** | Siddharth Vaddem が開発し、v1.5.0 のあとに[元のリポジトリをアーカイブ](https://github.com/siddharthvaddem/openscreen)しました。開発は彼の了承のもと、同じ名前、同じ MIT ライセンスでここに引き継がれています。 |

## 公式リンク {#official-links}

| | |
|---|---|
| **ウェブサイト** | [getopenscreen.com](https://getopenscreen.com/) |
| **ソースコード、リリース、Issue** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| **Microsoft Store** | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| **Discord** | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |

## このサイトの状況 {#status-of-this-site}

サイドバーの**機能**以下のページはすべて、ロードマップではなく、現在アプリに実際に搭載されている内容を説明しています。このサイトの元になった、より詳しい内部仕様（アーキテクチャのメモ、エンジニアリング文書、テスト計画）はまだリポジトリにあり、ここには移行されていません（いずれも英語）。

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)
