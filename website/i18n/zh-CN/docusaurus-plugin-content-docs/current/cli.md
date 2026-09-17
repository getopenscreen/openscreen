---
id: cli
title: "录屏 CLI：供脚本和 AI 代理使用"
sidebar_label: CLI
description: "OpenScreen 的录屏 CLI 可以在脚本、CI 任务和 AI 编程代理中录制、添加字幕并导出 .openscreen 项目，并以 NDJSON 格式输出。"
keywords:
  - 录屏 CLI
  - 命令行录屏
  - 无界面录屏
  - 自动制作产品演示视频
  - NDJSON
  - openscreen export
---

# 录屏 CLI

OpenScreen 的命令行界面内置在桌面应用自身的可执行文件中。`openscreen record`、`captions`、`export`、`pack`、`info` 和 `sources` 可以在终端中运行，而不会打开窗口；`--json` 会把它们的输出变成 stdout 上的 NDJSON。脚本、CI 任务或 AI 编程代理可以录制一段内容，把 `.openscreen` 项目当作普通 JSON 来编辑，再用与编辑器**导出**按钮相同的原生合成器渲染出 MP4 或 GIF。

它不是服务器工具。每条命令都会启动 Electron，即使不显示窗口，Electron 也需要显示服务器；录制则需要真实的桌面会话。请参阅[什么情况下不适合使用 CLI](#when-the-cli-is-not-the-right-tool)。

:::caution
CLI 和 `.openscreen` 项目格式在不同版本之间仍可能发生不兼容的变更。每次更新后，请检查你的脚本。
:::

## 运行 CLI {#running-the-cli}

请先[安装 OpenScreen](/download/)（参见[安装](./installation.md)）。每条命令都是应用可执行文件的子命令：

| 安装方式 | 可执行文件 |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Windows 安装程序 | 安装时所选文件夹中的 `Openscreen.exe`：为当前用户安装时是 `%LOCALAPPDATA%\Programs\Openscreen\`，为所有用户安装时是 `C:\Program Files\Openscreen\` |
| Linux `.deb`、`.rpm`、`.pacman` | `openscreen` |
| Linux AppImage | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

本页示例中写的都是 `openscreen`。在 macOS 和 Windows 上，请使用完整路径或别名：

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`、`--help` 或 `-h` 会打印用法说明。
- 放在子命令之前的 Chromium 开关会被跳过。如果 Chromium 的沙盒无法在主机上启动，请运行 `./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen`。
- CLI 运行时不会占用应用的单实例锁，所以在桌面应用打开时也能使用。
- 如果从源代码检出目录运行，请按照 [Build and packaging（英文）](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md)的说明构建应用及其原生辅助程序，然后运行 `npm run cli -- <command> [options]`。

## 命令 {#commands}

### `openscreen record` {#openscreen-record}

要从命令行录制屏幕，请运行 `record`。它驱动的是与桌面应用相同的录制钩子，生成的文件会保存到应用的录制目录中，与在图形界面中录制的内容放在一起：包括屏幕视频，以及（在采集到指针数据时）一个供可编辑光标和 `--auto-zoom` 读取的 `<video>.cursor.json` 光标遥测文件。

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| 选项 | 含义 |
|---|---|
| `--display <n>` | 屏幕索引，与 `openscreen sources` 列出的一致（默认为 0） |
| `--window <title>` | 录制标题包含 `<title>` 的第一个窗口，不区分大小写。优先级高于 `--display` |
| `--mic` | 采集默认麦克风 |
| `--mic-device <name>` | 采集名称包含 `<name>` 的麦克风，不区分大小写。隐含 `--mic` |
| `--system-audio` | 采集系统音频 |
| `--cursor <editable-overlay\|system>` | `editable-overlay`（默认）会隐藏系统指针并将其记录为数据，以便编辑器重新设置样式。`system` 会把指针绘制到视频中 |
| `--duration <seconds>` | 经过这段时间后自动停止 |
| `--project <out.openscreen>` | 完成后写出一个引用该录制的项目文件，可直接用于 `export` 或编辑器。必须以 `.openscreen` 结尾 |
| `--json` | 在 stdout 上输出 NDJSON 事件 |

没有摄像头选项：CLI 录制只包含屏幕和音频。

**停止录制**。未指定 `--duration` 时，可以按 Ctrl+C（SIGINT）、发送 SIGTERM，或在其 stdin 中输入 `stop`、`q` 或 `quit` 并按回车来停止录制。关闭 stdin 不会停止录制。强制终止进程会跳过正常的收尾流程，因此既不会写出 `done` 事件，也不会写出项目文件。

**各平台说明**

- **macOS**。采集通过 ScreenCaptureKit 辅助程序进行，没有回退方案。需要“屏幕录制”权限；对于从终端启动的开发版本，请把该权限授予终端。使用 `--mic` 时，如果尚未授予麦克风权限，CLI 会请求该权限。只有具备“辅助功能”权限时，才会记录指针的点击和形状。
- **Windows**。采集通过 Windows Graphics Capture 辅助程序进行，要求 Windows 10 内部版本 19041 或更高。在更早的内部版本上，或缺少辅助程序时，OpenScreen 会回退到浏览器采集。Windows 从不发送 SIGTERM：请使用 Ctrl+C、stdin 中的 `stop` 或 `--duration`。
- **Linux**。采集通过 PipeWire 辅助程序和桌面的 ScreenCast 门户进行。录制什么由门户自己的选择器决定，而且它每次运行都会打开并等待回应，因此 `--display` 和 `--window` 无法选择来源，Linux 上的录制也无法在无人值守的情况下开始。它需要一个带有 `xdg-desktop-portal` 的桌面会话：没有显示器的 SSH 会话无法录制。只有缺少辅助程序的构建才会回退到 Chromium 的采集。

### `openscreen sources` {#openscreen-sources}

列出应用能看到的显示器、窗口和麦克风，方便脚本选择 `--display`、`--window` 和 `--mic-device` 的值。在 Linux 上，`record` 采集什么仍由门户选择器决定。

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

使用 `--json` 时，数据会放在最后的 `done` 事件中返回：

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

当读取设备名称需要尚未授予的权限，或者无法在几秒内读取到设备列表时，`microphoneLabelsUnavailable` 为 `true`。

**为什么要有 `-o`**。CLI 只把自己的输出写到 stdout；Chromium 的诊断信息会写到 stderr。但包装该进程的程序就是另一回事了。Ubuntu 的 `xvfb-run` 是在没有屏幕的机器上运行图形界面程序的常用方式，它会把 stderr 合并到 stdout 中，于是 Chromium 的启动警告会出现在 JSON 之前，导致 `openscreen sources --json | jq` 失败。`-o <file>` 会写入任何包装程序都无法重定向的位置，同时还能避开 shell 引号和编码方面的差异。

这两个渠道输出的数据结构不同。stdout 会把数据包在 `done` 事件中，因为它只是事件流中的一个事件。文件中则只有数据本身：

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

文件只在成功时写入，并且是原子写入：运行失败时，之前已有的文件不会被改动。请检查退出码，而不是检查文件是否存在。

### `openscreen export` {#openscreen-export}

使用编辑器预览和导出所用的原生合成器，把项目渲染为 MP4 或 GIF。缩放、剪辑区间、速度区间、标注和字幕、光标以及背景，全部取自项目。

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| 选项 | 含义 |
|---|---|
| `-o, --out <path>` | 输出文件。扩展名（`.mp4` 或 `.gif`）决定格式。默认：项目路径，扩展名换成 `.mp4` 或 `.gif` |
| `--format <mp4\|gif>` | 覆盖项目中保存的格式。必须与 `--out` 一致 |
| `--quality <medium\|good\|source>` | 输出尺寸：`medium` 为 720p，`good` 为 1080p，`source` 以裁剪后最小的片段为准，因此绝不会放大。GIF 也以这个尺寸为起点 |
| `--gif-fps <15\|20\|25\|30>` | GIF 帧率 |
| `--gif-size <medium\|large\|original>` | 在上述尺寸基础上施加的 GIF 高度上限：720、1080 或不限 |
| `--auto-zoom` | 渲染之前，在录制的指针停顿处添加缩放，使用与编辑器[自动缩放](/features/auto-zoom/)相同的引擎。已有的缩放会保留，新的缩放绝不会与它们重叠 |
| `--audio <file>` | 把一个配音文件（mp3、wav 或 m4a）混入 MP4。仅限 MP4 |
| `--audio-mode <mix\|replace>` | `mix`（默认）会以 40% 增益把录制原声保留在配音之下；`replace` 则去掉原声 |
| `--audio-offset <seconds>` | 配音开始前的延迟（默认为 0） |
| `--json` | 在 stdout 上输出 NDJSON 格式的进度和结果 |

CLI 导出的 MP4 始终是 **60 fps 的 H.264**。没有编码格式或帧率选项。桌面应用的[导出](./export.md)对话框另外还提供 H.265 以及 24 或 30 fps。

`--audio` 在渲染完成后才起作用：视频流会原样复制，然后混合出一条新的 AAC 音轨，并覆盖写入同一个输出文件。

**媒体文件可以放在哪里**。加载项目时，只有位于应用录制目录或项目文件所在文件夹中的引用媒体，才会被应用自动允许使用。请把手写的项目文件和它的媒体放在一起，或者用 CLI 录制，因为 CLI 使用的就是录制目录。

**无法取消**。只有 `record` 会响应停止请求。要放弃一次导出，唯一的办法是结束进程；此时输出路径上留下的任何内容都应视为不可用。

### `openscreen captions` {#openscreen-captions}

在你的电脑上用 Whisper 转录项目的音频，然后把字幕标注写入项目文件。不会上传任何内容，语言会自动检测。与桌面应用一样，首次运行时会下载一次约 264 MB 的 Whisper 模型。

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` 和 `--max-words` 设置每条字幕的词数。默认值分别为 2 和 7。
- 再次运行会替换它之前添加的字幕。你自己添加的标注会保留。
- 项目的屏幕视频必须带有音轨，例如由 `record --mic` 录制的视频。
- 字幕会烧录进导出的视频中，不会输出字幕文件。请参阅[字幕](./captions.md)。

### `openscreen pack` {#openscreen-pack}

把项目及其引用的所有内容（屏幕视频、摄像头视频、光标遥测数据）复制到同一个文件夹中，并改写复制出的项目中的媒体路径。

```bash
openscreen pack demo.openscreen --out bundle/
```

`--out` 为必填项，也可以用简写 `-o`。这个文件夹可以移动，也可以作为 CI 产物保存：当保存的绝对路径不再存在时，应用会改用项目文件旁边的同名文件。

### `openscreen info` {#openscreen-info}

打印项目引用了哪些内容、其屏幕视频是否仍然存在，以及它的导出设置和其中包含的缩放、剪辑区间、速度区间和标注的数量。

```bash
openscreen info demo.openscreen --json
```

当引用的屏幕视频缺失时，它以退出码 1 退出。

## 机器可读的输出 {#machine-readable-output}

使用 `--json` 时，stdout 每行输出一个 JSON 对象。stderr 只输出诊断信息，包括应用自身的日志行。

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| 事件 | 发送时机 | 字段 |
|---|---|---|
| `started` | `record`、`sources`、`export` 或 `captions` 开始运行时 | `command` |
| `log` | 一条状态信息，例如 `Recording started` | `message` |
| `progress` | 导出的帧完成编码时 | `percentage`、`currentFrame`、`totalFrames`、`estimatedTimeRemaining`（单位为秒）。混合 `--audio` 期间：`percentage` 和 `phase: "mixing-voiceover"` |
| `stopping` | `record` 收到停止请求时 | `reason`：`SIGINT`、`SIGTERM` 或 `stdin` |
| `warning` | 运行成功，但有需要注意的情况时 | `message` |
| `error` | 报告了故障时 | `message` |
| `done` | 运行结束时，无论成功与否 | `success`，然后是结果或 `error` |

`done` 携带的内容：

- **export**：`outputPath`、`format`、`width`、`height`。
- **record**：`screenVideoPath`、`cursorDataPath`（遥测文件的写入位置；该文件可能不存在）、`durationMs`；使用 `--project` 时，还有 `projectPath` 和 `projectData`，即它写出的项目。
- **sources**：`sources`。
- **captions**：`projectPath`、`captionCount`。
- **pack**：`projectPath`、`files`、`cursorData`。`pack` 不发送 `started` 事件。

`info --json` 会打印一个不含 `event` 字段的摘要对象。

`pack` 或 `info` 失败时，会以 `error` 事件结束，不会有 `done`。崩溃时可能以 `error` 事件结束，也可能 stdout 上再无任何输出。请以退出码为准。

**退出码**

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 失败，包括对屏幕视频已缺失的项目运行 `info` |
| `2` | 参数错误。即使使用了 `--json`，错误信息和用法说明也会以纯文本形式输出到 stderr |

## 示例：自动制作产品演示视频 {#example-an-automated-product-demo}

脚本或 AI 编程代理无需打开编辑器，就能制作一段带字幕和缩放的演示视频：

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

在第 3 步中，`depth` 的取值范围是 1 到 6（对应 1.25× 到 5×；3 对应 1.8×），`cx` 和 `cy` 以画面的比例值指定缩放中心的位置。

如果想改用文字转语音引擎来配音，请在录制时不加 `--mic`，然后在导出时混入配音。任何能输出 mp3、wav 或 m4a 的引擎都可以；下面以 macOS 的 `say` 为例：

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` 读取的是录制内容本身的音轨，而不是导出时混入的配音，所以用这种方式制作的文字转语音配音不会生成字幕。

**导出用其他工具制作的视频**。`export` 并不要求必须是 OpenScreen 录制的内容。它能接受的最简项目只包含一个媒体路径和一个空的 editor，这会变成一个使用默认设置、完整长度的片段：

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

请把它保存在与该视频片段相同的文件夹中。没有光标遥测数据时，`--auto-zoom` 就无从处理。

## 显示器、CI 与服务器 {#displays-ci-and-servers}

- 每条命令都会启动 Electron，而 Electron 会启动 Chromium，所以即使不打开任何窗口，也必须有显示服务器。在没有屏幕的 Linux 机器上，可以用 `xvfb-run` 启动一个虚拟 X 服务器来提供。
- `export` 不采集任何内容，所以只要有 Vulkan 驱动，就可以这样运行：Linux 合成器通过 Vulkan 渲染，没有 GPU 的机器需要软件驱动，例如 Mesa 的 lavapipe。本项目的 Nix 构建工作流就是这样做的：在没有屏幕的 Linux 运行器上，于 `xvfb-run` 下配合 lavapipe，用一个生成的片段渲染出 MP4；如果没有生成 MP4，工作流就会失败。
- `record` 则不行。在同一个运行器上，Chromium 找不到可以采集的显示器；而且在 Linux 上，门户选择器本来就需要有人来操作。

## 什么情况下不适合使用 CLI {#when-the-cli-is-not-the-right-tool}

- **你需要在服务器上录制**，而服务器没有显示器或桌面会话。录制需要真实的桌面环境，而且在 Linux 上，每次运行都得有人回应门户选择器。
- **你需要稳定且带版本号的 API**。CLI 和项目格式在不同版本之间仍可能变化。
- **你需要在命令行中控制编码格式、帧率或码率**。CLI 导出的 MP4 固定为 60 fps 的 H.264，而 MP4 的码率在应用中也无法调整。
- **你需要在脚本录制中包含摄像头**。`record` 没有摄像头选项。
- **你需要字幕文件**。字幕只会烧录进视频。

想在编辑器中亲手完成同样的步骤，请参阅[如何制作产品演示视频](./guides/product-demo-video.md)。关于许可证和网络使用的解答，请参阅[常见问题](./faq.md)。

## 源代码 {#source-code}

CLI 是 [OpenScreen 仓库](https://github.com/getopenscreen/openscreen)的一部分：

- `electron/cli/args.ts`：参数解析器和用法说明文本，单元测试位于 `args.test.ts`。
- `electron/cli/cliMain.ts`：无窗口启动、stdio 协议、停止信号和退出码。
- `electron/cli/projectCommands.ts`：`pack` 和 `info`。
- `src/cli/`：`record`、`sources`、`export` 和 `captions` 的隐藏窗口运行器。
- `src/lib/cliContracts.ts`：两端共用的请求和结果类型。
