---
id: cli
title: "画面録画 CLI：スクリプトとエージェントから使う"
sidebar_label: CLI
description: "OpenScreen の画面録画 CLI は、スクリプト、CI ジョブ、コーディングエージェントから .openscreen プロジェクトの録画、字幕付け、エクスポートを行い、結果を NDJSON で出力します。"
keywords:
  - 画面録画 CLI
  - 画面録画 コマンドライン
  - ヘッドレス 画面録画
  - デモ動画 自動化
  - NDJSON
  - openscreen export
---

# 画面録画 CLI

OpenScreen のコマンドラインインターフェースは、デスクトップアプリ自身の実行ファイルに組み込まれています。`openscreen record`、`captions`、`export`、`pack`、`info`、`sources` はウィンドウを開かずにターミナルから実行でき、`--json` を付けると出力が stdout への NDJSON になります。スクリプト、CI ジョブ、コーディングエージェントは、テイクを録画し、`.openscreen` プロジェクトをただの JSON として編集し、エディターの**エクスポート**ボタンと同じネイティブコンポジターで MP4 や GIF をレンダリングできます。

これはサーバー向けのツールではありません。どのコマンドも Electron を起動するため、ウィンドウは表示されなくてもディスプレイサーバーが必要です。また、録画には実際のデスクトップセッションが必要です。[CLI が適さない場合](#when-the-cli-is-not-the-right-tool)を参照してください。

:::caution
CLI と `.openscreen` プロジェクト形式には、今後もリリース間で互換性のない変更が入る可能性があります。アップデートのたびに、スクリプトを確認してください。
:::

## CLI の実行 {#running-the-cli}

まず [OpenScreen をインストール](/download/)してください（[インストール](./installation.md)を参照）。どのコマンドも、アプリの実行ファイルのサブコマンドです。

| インストール方法 | 実行ファイル |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Windows インストーラー | セットアップ時に選んだフォルダー内の `Openscreen.exe`。現在のユーザー向けのインストールでは `%LOCALAPPDATA%\Programs\Openscreen\`、全ユーザー向けでは `C:\Program Files\Openscreen\` |
| Linux `.deb`、`.rpm`、`.pacman` | `openscreen` |
| Linux AppImage | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

このページの例では `openscreen` と表記しています。macOS と Windows では、フルパスかエイリアスを使ってください。

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`、`--help`、`-h` で使い方が表示されます。
- サブコマンドより前に置いた Chromium のスイッチは読み飛ばされます。ホスト上で Chromium のサンドボックスを起動できない場合は、`./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen` のように実行します。
- CLI の実行はアプリの単一インスタンスロックを取得しないため、デスクトップアプリを開いたままでも動作します。
- ソースのチェックアウトから使う場合は、[Build and packaging（英語）](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md)の説明に従ってアプリとネイティブヘルパーをビルドし、`npm run cli -- <command> [options]` を実行します。

## コマンド {#commands}

### `openscreen record` {#openscreen-record}

コマンドラインから画面を録画するには、`record` を実行します。デスクトップアプリと同じ録画フックを使い、ファイルは GUI で作った録画と同じく、アプリの録画ディレクトリに保存されます。保存されるのは画面の動画と、ポインターのデータを取得できた場合は `<video>.cursor.json` のカーソルテレメトリファイルです。このファイルは、編集可能なカーソルと `--auto-zoom` が読み取ります。

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| オプション | 意味 |
|---|---|
| `--display <n>` | 画面のインデックス。`openscreen sources` の一覧に対応します（既定値 0） |
| `--window <title>` | タイトルに `<title>` を含む最初のウィンドウを録画します（大文字と小文字は区別しません）。`--display` より優先されます |
| `--mic` | 既定のマイクから録音します |
| `--mic-device <name>` | ラベルに `<name>` を含むマイクから録音します（大文字と小文字は区別しません）。`--mic` も指定したことになります |
| `--system-audio` | システム音声を録音します |
| `--cursor <editable-overlay\|system>` | `editable-overlay`（既定）はシステムのポインターを隠してデータとして記録し、エディターでスタイルを変えられるようにします。`system` はポインターを映像に描き込みます |
| `--duration <seconds>` | 指定した時間が経過したら自動的に停止します |
| `--project <out.openscreen>` | 終了時に、録画を参照するプロジェクトファイルを書き出します。`export` やエディターですぐに使えます。末尾は `.openscreen` でなければなりません |
| `--json` | stdout に NDJSON のイベントを出力します |

ウェブカメラのオプションはありません。CLI の録画に含まれるのは、画面と音声だけです。

**停止方法。** `--duration` を指定しない場合は、Ctrl+C（SIGINT）、SIGTERM、または stdin に `stop`、`q`、`quit` のいずれかを入力して Enter を押すと、録画が停止します。stdin を閉じても停止しません。強制終了すると通常の終了処理が省かれるため、`done` イベントもプロジェクトファイルも書き出されません。

**プラットフォームごとの違い**

- **macOS。** キャプチャは ScreenCaptureKit のヘルパーを経由し、フォールバックはありません。画面収録の権限が必要です。ターミナルから起動した開発用ビルドでは、ターミナルに権限を与えてください。`--mic` を指定すると、マイクへのアクセスがまだ許可されていなければ、CLI が許可を求めます。ポインターのクリックと形状は、アクセシビリティの権限がある場合にのみ記録されます。
- **Windows。** キャプチャは Windows Graphics Capture のヘルパーを経由し、Windows 10 ビルド 19041 以降で使えます。それより古いビルドやヘルパーがない場合は、ブラウザーキャプチャにフォールバックします。Windows には SIGTERM が届かないため、Ctrl+C、stdin の `stop`、または `--duration` を使ってください。
- **Linux。** キャプチャは PipeWire のヘルパーと、デスクトップの ScreenCast ポータルを経由します。何を録画するかはポータル自身のピッカーが決め、ピッカーは実行のたびに開いて応答を待ちます。そのため、`--display` と `--window` ではソースを選べず、Linux では無人で録画を開始できません。`xdg-desktop-portal` のあるデスクトップセッションが必要で、ディスプレイのない SSH セッションでは録画できません。Chromium のキャプチャにフォールバックするのは、ヘルパーを含まないビルドだけです。

### `openscreen sources` {#openscreen-sources}

アプリから見えるディスプレイ、ウィンドウ、マイクを一覧表示し、スクリプトが `--display`、`--window`、`--mic-device` の値を選べるようにします。Linux では、`record` で何をキャプチャするかは、それでもポータルのピッカーが決めます。

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

`--json` を指定すると、ペイロードは最後の `done` イベントの中に入ります。

```json
{
  "event": "done",
  "success": true,
  "sources": {
    "displays": [{ "index": 0, "id": "screen:1:0", "name": "Entire screen" }],
    "windows": [{ "id": "window:210:0", "name": "My App" }],
    "microphones": [{ "label": "Built-in Microphone" }],
    "microphoneLabelsUnavailable": false
  }
}
```

`microphoneLabelsUnavailable` は、デバイス名の取得にまだ許可されていない権限が必要な場合や、数秒以内にデバイスの一覧を読み取れなかった場合に `true` になります。

**`-o` がある理由。** CLI が stdout に書き込むのは自身の出力だけで、Chromium の診断情報は stderr に送られます。問題は、プロセスを包むラッパーのほうです。画面のないマシンで GUI のバイナリを動かす一般的な方法である Ubuntu の `xvfb-run` は、stderr を stdout にまとめます。そのため、Chromium の起動時の警告が JSON の前に入り込み、`openscreen sources --json | jq` が失敗します。`-o <file>` なら、どのラッパーにもリダイレクトされない場所に書き込めるうえ、シェルのクォートやエンコーディングの違いも避けられます。

2 つのチャネルでは、データの形が異なります。stdout はストリーム中のイベントのひとつなので、ペイロードを `done` イベントで包みます。ファイルには、ペイロードだけが入ります。

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

ファイルは成功した場合にのみ、アトミックに書き込まれます。失敗した実行では、以前のファイルはそのまま残ります。ファイルがあるかどうかではなく、終了コードを確認してください。

### `openscreen export` {#openscreen-export}

エディターがプレビューとエクスポートに使うのと同じネイティブコンポジターで、プロジェクトを MP4 または GIF にレンダリングします。ズーム、トリム、再生速度の範囲、注釈と字幕、カーソル、背景は、すべてプロジェクトから読み込まれます。

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| オプション | 意味 |
|---|---|
| `-o, --out <path>` | 出力ファイル。拡張子（`.mp4` または `.gif`）で形式が決まります。既定値は、プロジェクトのパスの拡張子を `.mp4` または `.gif` にしたものです |
| `--format <mp4\|gif>` | プロジェクトに保存された形式を上書きします。`--out` と一致している必要があります |
| `--quality <medium\|good\|source>` | 出力サイズ。`medium` は 720p、`good` は 1080p、`source` はクロップ後のもっとも小さいクリップに合わせるため、アップスケールしません。GIF もこのサイズが出発点になります |
| `--gif-fps <15\|20\|25\|30>` | GIF のフレームレート |
| `--gif-size <medium\|large\|original>` | 上記のサイズに適用する GIF の高さの上限。720、1080、上限なしのいずれかです |
| `--auto-zoom` | レンダリングの前に、記録されたポインターが止まった箇所にズームを追加します。エディターの[自動ズーム](/features/auto-zoom/)と同じエンジンを使います。既存のズームは保持され、新しいズームがそれと重なることはありません |
| `--audio <file>` | ナレーションのファイル（mp3、wav、m4a）を MP4 にミックスします。MP4 のみ |
| `--audio-mode <mix\|replace>` | `mix`（既定）は録画の音声を 40% のゲインでナレーションの下に残し、`replace` は録画の音声を取り除きます |
| `--audio-offset <seconds>` | ナレーションが始まるまでの遅延（既定値 0） |
| `--json` | stdout に NDJSON で進行状況と結果を出力します |

CLI からの MP4 エクスポートは、常に **H.264・60 fps** です。コーデックやフレームレートのオプションはありません。デスクトップアプリの[エクスポート](./export.md)ダイアログでは、H.265 と、24 または 30 fps も選べます。

`--audio` はレンダリングのあとに処理されます。映像ストリームは手を加えずにコピーされ、新しい AAC トラックがミックスされて、同じ出力ファイルに上書きされます。

**メディアの置き場所。** プロジェクトを読み込むとき、アプリが参照先のメディアを自動的に承認するのは、そのメディアが録画ディレクトリの中か、プロジェクトファイルと同じフォルダーの中にある場合だけです。手書きのプロジェクトはメディアと同じ場所に置くか、録画ディレクトリを使う CLI で録画してください。

**キャンセルはできません。** 停止の要求を受け付けるのは `record` だけです。エクスポートを中止するには、プロセスを終了するしかありません。その場合、出力先に残ったものは使えないものとして扱ってください。

### `openscreen captions` {#openscreen-captions}

プロジェクトの音声をお使いのマシン上で Whisper によって文字起こしし、字幕の注釈をプロジェクトファイルに書き込みます。何もアップロードされず、言語は自動で検出されます。初回実行時には、デスクトップアプリと同じく、Whisper モデル（約 264 MB）を一度だけダウンロードします。

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` と `--max-words` で、字幕 1 つあたりの単語数を設定します。既定値は 2 と 7 です。
- もう一度実行すると、以前に追加した字幕が置き換えられます。自分で追加した注釈は保持されます。
- プロジェクトの画面動画には、音声トラックが必要です（たとえば `record --mic` で録音したもの）。
- 字幕はエクスポートに焼き込まれます。字幕ファイルは出力されません。[字幕と文字起こし](./captions.md)を参照してください。

### `openscreen pack` {#openscreen-pack}

プロジェクトと、それが参照するすべてのファイル（画面動画、ウェブカメラの動画、カーソルテレメトリ）をひとつのフォルダーにコピーし、コピーしたプロジェクト内のメディアのパスを書き換えます。

```bash
openscreen pack demo.openscreen --out bundle/
```

必須のオプションである `--out` の短縮形として、`-o` も使えます。このフォルダーは移動したり、CI のアーティファクトとして保存したりできます。保存されている絶対パスが存在しなくなった場合、アプリはプロジェクトファイルと同じ場所にある同名のファイルを使います。

### `openscreen info` {#openscreen-info}

プロジェクトが参照しているものと、その画面動画がまだ存在するかどうかを表示します。あわせて、エクスポート設定と、ズーム、トリム、再生速度の範囲、注釈のそれぞれの数も表示します。

```bash
openscreen info demo.openscreen --json
```

参照先の画面動画がない場合は、終了コード 1 で終了します。

## 機械可読な出力 {#machine-readable-output}

`--json` を指定すると、stdout には 1 行に 1 つの JSON オブジェクトが出力されます。stderr には、アプリ自身のログ行を含め、診断情報だけが出力されます。

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| イベント | 送信されるタイミング | フィールド |
|---|---|---|
| `started` | `record`、`sources`、`export`、`captions` の実行開始時 | `command` |
| `log` | `Recording started` のようなステータス行 | `message` |
| `progress` | エクスポートのフレームがエンコードされたとき | `percentage`、`currentFrame`、`totalFrames`、`estimatedTimeRemaining`（秒）。`--audio` のミックス中は `percentage` と `phase: "mixing-voiceover"` |
| `stopping` | `record` が停止の要求を受け取ったとき | `reason`：`SIGINT`、`SIGTERM`、`stdin` のいずれか |
| `warning` | 注意事項付きで実行が成功したとき | `message` |
| `error` | 失敗が報告されたとき | `message` |
| `done` | 実行が終了したとき（成否を問わず） | `success`、続いて結果または `error` |

`done` に含まれる内容：

- **export：** `outputPath`、`format`、`width`、`height`。
- **record：** `screenVideoPath`、`cursorDataPath`（テレメトリファイルの書き込み先。ファイルが存在しない場合もあります）、`durationMs`。`--project` を指定した場合は、書き込んだプロジェクトを表す `projectPath` と `projectData` も含まれます。
- **sources：** `sources`。
- **captions：** `projectPath`、`captionCount`。
- **pack：** `projectPath`、`files`、`cursorData`。`pack` は `started` イベントを送信しません。

`info --json` は、`event` フィールドのない要約オブジェクトを 1 つだけ出力します。

失敗した `pack` や `info` は、`done` なしで `error` イベントで終わります。クラッシュした場合は、`error` イベントで終わることも、stdout にそれ以上何も出力されないこともあります。終了コードで判断してください。

**終了コード**

| コード | 意味 |
|---|---|
| `0` | 成功 |
| `1` | 失敗（画面動画が見つからないプロジェクトに対する `info` を含む） |
| `2` | 引数の誤り。`--json` を指定していても、メッセージと使い方はプレーンテキストで stderr に出力されます |

## 例：プロダクトデモを自動で作る {#example-an-automated-product-demo}

スクリプトやコーディングエージェントは、エディターを開かずに、字幕とズームの入ったデモを作成できます。

```bash
# 1. Record 20 seconds of one window, with narration from the microphone
openscreen record --window "MyProduct" --mic --duration 20 --project demo.openscreen --json

# 2. Caption the narration on this machine
openscreen captions demo.openscreen --json

# 3. Add a manual zoom and a text label by editing the project JSON
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("demo.openscreen", "utf8"));
  p.editor.zoomRegions.push({ id: "z1", startMs: 2000, endMs: 6000, depth: 3,
    focus: { cx: 0.5, cy: 0.4 }, focusMode: "manual", source: "manual" });
  p.editor.annotationRegions.push({ id: "a1", startMs: 500, endMs: 4000,
    type: "text", content: "One-click setup", textContent: "One-click setup",
    position: { x: 8, y: 6 }, size: { width: 40, height: 12 },
    style: { fontSize: 24, color: "#fff" }, zIndex: 1 });
  fs.writeFileSync("demo.openscreen", JSON.stringify(p, null, 2));
'

# 4. Render, with automatic zooms added where the pointer paused
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --json
```

手順 3 の `depth` は 1 から 6 まで（1.25× から 5×。3 は 1.8×）で、`cx` と `cy` はズームの中心を、フレームに対する比率で指定します。

代わりに音声合成エンジンでナレーションを付けるには、`--mic` なしで録画し、エクスポート時にナレーションをミックスします。mp3、wav、m4a を書き出せるエンジンならどれでも使えます。ここでは macOS の `say` を例に示します。

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` が読み取るのは録画自体の音声トラックで、エクスポート時にミックスしたナレーションではありません。そのため、この方法では音声合成のナレーションに字幕は付きません。

**ほかのツールで作った動画をエクスポートする。** `export` は、OpenScreen で録画した動画でなくても使えます。受け付ける最小のプロジェクトは、メディアのパスと空の editor オブジェクトだけのもので、既定の設定を持つ全長 1 本のクリップになります。

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

このファイルは、クリップと同じフォルダーに保存してください。カーソルテレメトリがなければ、`--auto-zoom` の手がかりになるものはありません。

## ディスプレイ、CI、サーバー {#displays-ci-and-servers}

- どのコマンドも Electron を起動し、Electron は Chromium を起動するため、ウィンドウが開かなくてもディスプレイサーバーが必要です。画面のない Linux マシンでは、`xvfb-run` で起動した仮想 X サーバーがその役割を果たします。
- `export` は何もキャプチャしないため、Vulkan ドライバーがあれば、この方法で動作します。Linux のコンポジターは Vulkan でレンダリングするので、GPU のないマシンでは Mesa の lavapipe のようなソフトウェアドライバーが必要です。このプロジェクトの Nix ビルドのワークフローは、画面のない Linux ランナー上で `xvfb-run` と lavapipe を使い、生成したクリップから MP4 をこの方法でレンダリングしています。MP4 が出力されなければ、ワークフローは失敗します。
- `record` はこの方法では動作しません。同じランナーでは Chromium がキャプチャするディスプレイを見つけられず、そもそも Linux ではポータルのピッカーに人が応答する必要があります。

## CLI が適さない場合 {#when-the-cli-is-not-the-right-tool}

- **ディスプレイやデスクトップセッションのないサーバーで録画したい。** 録画には実際のデスクトップが必要で、Linux では実行のたびに誰かがポータルのピッカーに応答しなければなりません。
- **安定した、バージョン管理された API が必要。** CLI とプロジェクト形式は、リリース間で変わる可能性があります。
- **コマンドラインからコーデック、フレームレート、ビットレートを制御したい。** CLI の MP4 エクスポートは H.264・60 fps で、MP4 のビットレートはアプリでも調整できません。
- **スクリプトによる録画でウェブカメラを使いたい。** `record` にはカメラのオプションがありません。
- **字幕ファイルが必要。** 字幕は動画に焼き込まれるだけです。

エディターで同じ手順を実際に行う方法は、[プロダクトデモ動画の作り方](./guides/product-demo-video.md)を参照してください。ライセンスとネットワーク利用については、[よくある質問](./faq.md)で回答しています。

## ソースコード {#source-code}

CLI は [OpenScreen のリポジトリ](https://github.com/getopenscreen/openscreen)に含まれています。

- `electron/cli/args.ts`：引数パーサーと使い方のテキスト。`args.test.ts` で単体テストされています。
- `electron/cli/cliMain.ts`：ウィンドウなしの起動処理、stdio のプロトコル、停止シグナル、終了コード。
- `electron/cli/projectCommands.ts`：`pack` と `info`。
- `src/cli/`：`record`、`sources`、`export`、`captions` を非表示のウィンドウで実行するランナー。
- `src/lib/cliContracts.ts`：両側で共有するリクエストと結果の型。
