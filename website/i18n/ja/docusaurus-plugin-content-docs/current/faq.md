---
id: faq
title: "よくある質問：ライセンス・プライバシー・リンク"
sidebar_label: よくある質問
description: "OpenScreen は商用利用も無料？ はい、MIT ライセンスです。透かし、オフラインでの利用、プライバシー、インストーラーの署名、公式リンクについての質問に回答します。"
keywords:
  - OpenScreen よくある質問
  - 商用利用 無料
  - MIT ライセンス
  - 透かしなし
  - 画面録画 オフライン
  - OpenScreen 本家
---

# OpenScreen よくある質問

OpenScreen は、Windows、macOS、Linux に対応した、MIT ライセンスの無料の画面録画・動画編集ソフトです。商用利用も無料で、アカウント登録は不要、透かしも入りません。このページでは、インストール前によく寄せられる質問（ライセンス、ネットワーク通信の内容、インストーラーの署名、どのサイトが公式か）に回答します。なお、openscreen.io の Open Screen とは別の製品です。

## OpenScreen は商用利用も無料ですか？ {#is-openscreen-free-for-commercial-use}

**はい。** OpenScreen は [MIT ライセンス](https://github.com/getopenscreen/openscreen/blob/main/LICENSE)で公開されています。

- 使用、複製、改変、配布、販売ができます。唯一の条件は、ソフトウェアの複製に著作権表示と許諾表示を含めることです。
- ライセンスの条文が対象とするのはソフトウェアです。このソフトウェアで作った動画については何も定めていません。
- アカウントも、有料プランも、プレミアム機能もありません。

## OpenScreen は透かし（ウォーターマーク）を入れますか？ {#does-openscreen-add-a-watermark}

**いいえ。** MP4 と GIF のエクスポートに透かしは入らず、透かしを消すための有料版もありません。形式については[エクスポート](./export.md)を参照してください。

## OpenScreen はオフラインで使えますか？ {#does-openscreen-work-offline}

**録画、文字起こし、レンダリングはお使いのパソコン上で実行されます。** OpenScreen にはアップロード機能がないため、録画はディスク上に残ります。ただし、アプリはいくつかのネットワーク接続を行うため、「完全オフライン」と言うのは誤りです。

- **Google Fonts（起動のたび）。** アプリは、テキスト注釈用のフォントを Google のサーバー（fonts.googleapis.com を含む）から読み込みます。
- **huggingface.co（一度だけ）。** 最初の文字起こしで約 264 MB の Whisper モデルをダウンロードし、SHA-256 ハッシュで検証します。それ以降、文字起こしに接続は必要ありません。
- **github.com と api.github.com。** 自動でアップデートするビルドは、24 時間ごとと、ユーザーが求めたときに、新しいリリースを確認します。既定では、新しいリリースがあることを知らせるだけです。
- **AI プロバイダー（接続した場合のみ）。** チャット編集では、あなたのメッセージと、エージェントが読み取るプロジェクトのデータ（タイムラインや文字起こしなど）が送信されます。字幕の翻訳では、字幕のテキストが送信されます。どちらも、プロバイダーを接続するまではオフです。[AI 編集](./ai-editing.md)を参照してください。

## OpenScreen は利用状況の分析データやクラッシュレポートを収集しますか？ {#does-openscreen-collect-analytics-or-crash-reports}

**いいえ。** アプリのコードには、利用状況の分析やクラッシュレポートのための SDK は含まれていません。

- アプリが報告を送る先となる OpenScreen のサーバーは存在しません。
- AI プロバイダーのキーは、Electron の `safeStorage` で暗号化して保存されます。暗号化が利用できない場合、キーは保存されません。

## OpenScreen は安全にインストールできますか？ {#is-openscreen-safe-to-install}

**ソースコードは公開されており、macOS 版と Store 版は署名されています。** ダウンロードは、[公式リンク](#what-are-the-official-openscreen-links)に掲載したリンクからのみ行ってください。

- **macOS：** 1.9.0 以降のビルドは Apple Developer ID で署名され、公証を受けています。
- **Windows（Microsoft Store）：** パッケージは Microsoft が署名するため、警告なしでインストールできます。
- **Windows（`.exe` インストーラー）：** コード署名されていません。SmartScreen が「Windows によって PC が保護されました」と表示します。**詳細情報**を選んでから**実行**を選ぶか、代わりに Store 版を使ってください。

各プラットフォームの手順は[インストール](./installation.md)にあります。

## OpenScreen はどの OS で動作しますか？ {#which-systems-does-openscreen-run-on}

| OS | 最小要件 | パッケージ |
|---|---|---|
| macOS | 13 Ventura | Apple Silicon 用と Intel 用の `.dmg` |
| Windows | 10 バージョン 1903、x64 | Microsoft Store、`.exe` インストーラー |
| Linux | x64、PipeWire と xdg-desktop-portal | AppImage、`.deb`、`.rpm`、`.pacman`、Nix flake |

- Windows でネイティブキャプチャを使うには、ビルド 19041（Windows 10 バージョン 2004）が必要です。それより古いビルドでは、ブラウザーキャプチャにフォールバックします。
- RAM は 8 GB を目安にしてください。推奨は 16 GB です。

## Windows や Linux 向けの ARM64 版はありますか？ {#is-there-an-arm64-build-for-windows-or-linux}

**パッケージ化されたものはありません。** Windows と Linux のリリースは x64 のみです。

- ARM64 の Linux では、Nix flake が `aarch64-linux` 向けに OpenScreen をソースからビルドします。
- Apple Silicon の Mac 向けには、ネイティブの `.dmg` があります。

## winget、Homebrew、Flathub で OpenScreen をインストールできますか？ {#can-i-install-openscreen-with-winget-homebrew-or-flathub}

- **winget：** はい。Store のソース経由でインストールできます（`winget install --source msstore OpenScreen`）。
- **Homebrew：** 公式の cask はありません。2026 年 9 月時点で、元のプロジェクトの `siddharthvaddem/openscreen` tap は、まだバージョン 1.5.0 に固定されています。代わりに[ダウンロードページ](/download/)の `.dmg` を使ってください。
- **Flathub：** 掲載されていません。

## これは元の OpenScreen プロジェクトですか？ {#is-this-the-original-openscreen-project}

**その後継です。**

- Siddharth Vaddem が OpenScreen を開発し、v1.5.0 のあとに[元のリポジトリ](https://github.com/siddharthvaddem/openscreen)をアーカイブしました。
- 開発は彼の了承のもと、同じ名前、同じ MIT ライセンスで [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) に移りました。
- アーカイブされた README では、このプロジェクトはコアコントリビューターの 1 人が率いる、コミュニティ主導のスピンオフとされています。その人物が、メンテナーの Etienne Lescot です。README 内のリンク github.com/EtienneLescot/openscreen は、現在のリポジトリにリダイレクトされます。
- アーカイブされたリポジトリは更新されません。引き継ぎの経緯は [Picking up OpenScreen（英語）](/blog/2026/06/15/picking-up-openscreen/)で説明しています。

## OpenScreen は openscreen.io や openscreen.net と関係がありますか？ {#is-openscreen-related-to-openscreenio-or-openscreennet}

- **openscreen.io：** 関係ありません。openscreen.io は別の製品 Open Screen のサイトで、同サイトは Open Screen を macOS 用の画面録画ソフトとして紹介しています。OpenScreen はこれと提携していません。
- **openscreen.net：** OpenScreen の公式サイトではありません。

## OpenScreen の公式リンクは？ {#what-are-the-official-openscreen-links}

| 内容 | リンク |
|---|---|
| ウェブサイト | [getopenscreen.com](https://getopenscreen.com/) |
| ソースコード、リリース、Issue | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |
| Microsoft Store | [apps.microsoft.com/detail/9MXQ1HQJL5G5](https://apps.microsoft.com/detail/9MXQ1HQJL5G5) |
| Discord | [getopenscreen.com/discord](https://getopenscreen.com/discord/) |
| 元のプロジェクト（アーカイブ済み、読み取り専用） | [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) |

## 録画が途中で途切れたらどうなりますか？ {#what-happens-if-a-recording-is-interrupted}

Windows と macOS では、ネイティブのレコーダーが 1 秒単位のフラグメントで fragmented MP4 を書き込みます。録画が途中で途切れても、ファイルは最後の完全なフラグメントまで再生できます。

バグの報告や機能のリクエストは [GitHub の Issue](https://github.com/getopenscreen/openscreen/issues) にお寄せください。

## OpenScreen にできないことは？ {#what-doesnt-openscreen-do}

次のいずれかが必要な場合、OpenScreen は適したツールではありません。

- **オンライン共有。** 共有リンク、クラウドストレージ、チームのワークスペース、コメント機能はありません。ファイルはディスク上に残ります。[Loom の代替としての OpenScreen](/alternatives/loom/)を参照してください。
- **ライブ配信。** [OpenScreen と OBS Studio の比較](/compare/openscreen-vs-obs/)を参照してください。
- **字幕ファイル。** 字幕は動画に焼き込まれます。SRT や VTT のエクスポートはありません。[字幕と文字起こし](./captions.md)を参照してください。
- **モバイル。** モバイルアプリはなく、iOS や Android の画面もキャプチャできません。

## どうやって始めればいいですか？ {#how-do-i-get-started}

1. [ダウンロードページ](/download/)から、お使いのシステム用のインストーラーを入手します。
2. [インストール](./installation.md)の、お使いのプラットフォーム向けの手順に従います。
3. [クイックスタート](./quick-start.md)で、最初の動画を録画、トリム、エクスポートします。

## 出典 {#sources}

2026 年 9 月に確認：

- 元のリポジトリとそのアーカイブの告知：[github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen)
- 元のプロジェクトの Homebrew tap：[github.com/siddharthvaddem/homebrew-openscreen](https://github.com/siddharthvaddem/homebrew-openscreen)
- Open Screen：[openscreen.io](https://openscreen.io/)

Open Screen、Loom、OBS Studio、およびこのページに記載のその他の製品名は、各所有者の商標です。OpenScreen は、Open Screen（openscreen.io）、Loom、OBS Studio のいずれとも提携していません。
