---
id: ai-editing
title: AI 编辑
sidebar_position: 8
description: "连接你自己的 LLM 密钥，在聊天面板中编辑 OpenScreen 项目。此功能可选，默认关闭：在你连接模型之前，不会向任何模型发送内容。"
keywords:
  - AI 视频剪辑
  - LLM 视频编辑
  - 聊天编辑
  - 自带密钥
  - 隐私
---

# AI 编辑

OpenScreen 提供一个可选的 AI 代理，可以在聊天面板中编辑你的项目。**在你亲自连接提供方之前，它一直处于关闭状态**，在此之前不会向任何模型发送任何内容。连接之后，AI 代理只与该提供方通信，[字幕翻译](./captions.md#translation)也是如此。应用的其他网络用途（下载转录模型、检查更新）列在[常见问题](./faq.md#does-openscreen-work-offline)中。

:::tip
以上这些都不是必需的。无论你是否打开过聊天面板，录制、编辑、转录、字幕和导出都无需账号、无需提供方即可使用。其中只有转录需要下载一次：首次运行时下载的[转录模型](./captions.md#transcribing)。
:::

## 连接提供方 {#connecting-a-provider}

打开聊天栏（在**编辑**模式下，顶栏最左侧的开关），然后进入 **AI 设置**，选择一个提供方并粘贴 API 密钥：

| 提供方 | 说明 |
|---|---|
| **Claude API**（Anthropic） | |
| **OpenAI API** | |
| **Gemini API**（Google） | |
| **Mistral API** | |
| **OpenRouter API** | 一个密钥，多种模型。 |
| **MiniMax API** / **MiniMax Token Plan** | |
| **OpenAI Compatible** | 任何 OpenAI 格式的端点，由你提供基础 URL。 |

你的密钥通过操作系统的凭据保护机制（Electron `safeStorage`）加密存储；如果无法加密，写入会直接失败，而不会退回到明文保存。OpenScreen 的服务器永远看不到你的密钥，因为根本就没有这样的服务器：请求会从你的电脑直接发送到你选择的提供方。如果你完全不想保存密钥，也可以使用各提供方专用的环境变量。

:::note
ChatGPT 和 GitHub Copilot 登录选项已**在 1.8.0 中移除**。它们的工作方式是随应用分发属于这些厂商的第一方客户端凭据，而我们无权再分发这些凭据。请改用基于 API 密钥的提供方。
:::

## 使用 AI 代理 {#using-the-agent}

用日常语言描述你想要的编辑，例如“剪掉开头的空白”“我打开终端时放大画面”。AI 代理通过真实、可撤销的时间轴操作来完成编辑，而不是重新渲染：它可以添加和调整删减区间、缩放、速度区间、标注（文字、箭头，以及遮住屏幕上隐私信息的模糊）、导入的音轨及其淡入淡出和全屏摄像头区间，在你的点击处添加自动缩放，编辑片段的入点/出点和裁剪，放入另一个素材的画面，复制、重新排序或移除片段，还会读取转录文本，找到你所指的内容。它还能设置视频的外观：背景、边距、圆角、阴影、设备边框、画面比例、摄像头布局、光标和总音量。它还可以开启[字幕](./captions.md)，设置字幕的样式和位置，并亲自把字幕翻译成另一种语言。它还能写出设置里没有的视觉效果：参见[自定义效果](./effects.md)。

它周围的面板包括：

- **对话**：历史记录、重命名、删除以及新建对话。每个对话都保留各自的 AI 代理状态。
- **模型选择器**：来自已连接提供方的实时模型列表；如果提供方支持，还可以调节推理强度。
- **上下文用量表**：已用 token 数相对于预算的估算值，并提供**压缩上下文**操作，它会总结较早的对话轮次，而不是直接丢弃。
- **回退到此消息**：撤回 AI 代理在该时间点之后所做的编辑以及之后的每一轮对话，同时恢复项目、对话和 AI 代理状态。
- **智能体编辑**：**AI 设置**中的一个开关。关闭时，AI 代理尝试的每项编辑都会被拒绝：它仍然可以读取项目，并描述它会做出的修改，但在你重新打开这个开关之前，不会应用任何修改。

`Ctrl/Cmd + Z` 撤销 AI 代理的编辑，与撤销手动编辑完全一样。

时间轴自动增强菜单中的**智能剪切**（标有“*使用 AI*”）就是这个 AI 代理，只是执行一次性的提示词。（另一项**自动缩放**读取录制下来的点击，完全不需要提供方。）

## 还有哪些功能会用到你的提供方 {#what-else-uses-your-provider}

[字幕翻译](./captions.md#translation)是对同一模型发起的单次文本转换调用：它不运行 AI 代理循环，也无法改动你的文档。如果你在聊天中提出要求，AI 代理会改为自己翻译字幕，结果放入同一个翻译层。无论哪种情况，转录和字幕渲染都完全在本机进行。

## 使用 Claude Code、Codex 或其他 MCP 客户端 {#using-claude-code-codex-or-another-mcp-client}

如果你已经在使用 Claude Code 或 Codex 等 AI 编程代理，它可以用自己的账号登录，驱动同样的编辑工具。该账号的任何信息都不会经过 OpenScreen。

1. **AI 设置** → **MCP 服务器** → 将其开启。它只在你自己的电脑（`127.0.0.1`）上、在显示的端口上监听。
2. 复制那里显示的 **Claude Code** 或 **Codex** 命令，并在终端中运行。Claude Code 命令中带有访问令牌。Codex 则改为从 `OPENSCREEN_MCP_TOKEN` 环境变量读取令牌：请在启动 Codex 的终端中设置它。
3. 让你的 AI 代理进行编辑，对象可以是 OpenScreen 编辑器中打开的项目，也可以是你列表中的任何其他项目。

这些工具就是内置 AI 代理所使用的工具，另外还有录制、导出和查看视频的工具（[见下文](#letting-an-agent-make-the-whole-video)）。此外还有 `transcribe`：它像编辑器打开项目时那样，在本机用 Whisper 处理项目的媒体。客户端用自己的模型翻译字幕，因此字幕翻译无需在 OpenScreen 中配置提供方。除非客户端指定其他项目，这些工具作用于编辑器中打开的项目：客户端可以列出所有项目，并读取或编辑其中任何一个。它还可以创建项目（空项目，或基于一个视频文件），重命名项目，以及向项目的媒体添加或从中移除视频或音频文件。删除项目不在这些工具之列：这仍由你在应用中完成。在你同时开启 MCP 服务器部分中的**MCP 编辑**之前，MCP 客户端只能**读取**，它们尝试的每项编辑、录制、导出或新建项目都会被拒绝。这个开关独立于内置 AI 代理的**智能体编辑**开关，默认处于关闭状态。开启后，每项编辑都会在生效时立即保存：

- **对编辑器中打开的项目**，编辑可用 `Ctrl/Cmd + Z` 撤销。客户端会被要求在进行一系列编辑之前保存一个检查点，因此你可以让它们一步把项目恢复原样，而这一步本身也可以用 `Ctrl/Cmd + Z` 撤销。
- **对其他任何项目**，编辑会保存到它的文件中，`Ctrl/Cmd + Z` 无法撤销。客户端必须在第一次编辑之前保存该项目的检查点，恢复到这个检查点是唯一的撤销方式。

检查点保存在 OpenScreen 的内存中：OpenScreen 退出或服务器重启时就会丢失，而更改端口或重新生成令牌都会让服务器重启。只保留最近的 20 个检查点，因此较早的检查点可能会更早失效。**重新生成**令牌，即可断开所有使用旧令牌配置的客户端。

## 让 AI 代理制作整段视频 {#letting-an-agent-make-the-whole-video}

AI 代理可以从录制到导出独立完成一整段视频。无论以哪种方式添加 OpenScreen，除编辑工具外，AI 代理都能使用 `listSources`、`startRecording`、`stopRecording`、`setPointerTrack`、`exportVideo`、`getFrames` 和 `createProject`。与录制栏一样，录制时也可以录下你的摄像头和系统自带的光标；导出则接受导出对话框的选项：MP4 的画质和帧率，GIF 的帧率、尺寸和循环。

**通过上面的服务器**，录制由 OpenScreen 自己完成，就像按下它的录制按钮一样：编辑器关闭，录制栏倒计时后开始录制，录好的内容作为新项目在编辑器中打开，你可以看到每项编辑实时生效。这需要开启**MCP 编辑**，录制结束后，录制栏会恢复你自己的设置。

**作为 stdio 服务器**，则无需任何设置：AI 代理会用 `mcp` 启动应用自身的可执行文件。

最快的方式是把下面这段内容粘贴到你的AI 代理（Claude Code、Codex、Cursor 等）中：

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -y`, then follow it to make a demo video of this feature.
```

如果缺少 OpenScreen，该技能会在你同意后安装它，并添加它的 MCP 服务器。随后它会请你打开一个新会话，并说出 *continue the OpenScreen demo*：AI 代理只有在新会话中才能获得新工具。若要改为手动设置：

```bash
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

`<executable>` 是应用的可执行文件，各系统上的路径列在[运行 CLI](./cli.md#running-the-cli)中。其他客户端（例如 Cursor）以 stdio 服务器的方式添加：可执行文件作为 `command`，`["mcp"]` 作为 `args`。

该技能也以插件形式提供，来自仓库自身的插件市场。在 Claude Code 中：

```text
/plugin marketplace add getopenscreen/openscreen
/plugin install openscreen@openscreen
```

对于共享插件的 Codex 和 ChatGPT 桌面应用：

```bash
codex plugin marketplace add getopenscreen/openscreen
codex plugin add openscreen@openscreen
```

之后，OpenScreen 会连同该技能一起出现在应用的已安装插件中。

- **无需端口、令牌或设置**。AI 代理以你的权限自行启动进程，就像它运行 `openscreen record` 一样。因此，它无需**MCP 编辑**开关，就能录制你的屏幕并进行编辑。
- **每次录制都会成为一个新项目**，出现在你的项目列表中，并且与在应用中录制的内容一样，在录制下来的点击处添加缩放：时间和位置都相近的点击共用一个缩放，开头几秒和结尾保持全屏。AI 代理的每项编辑都会保存到项目文件中。撤销它们要靠 AI 代理创建的检查点，检查点在代理的会话结束前一直有效。只保留最近的 20 个检查点，因此较早的检查点可能会更早失效。
- **OpenScreen 运行时，AI 代理通过应用进行编辑。** 对编辑器中打开的项目所做的编辑会立即显示在那里，并可用 `Ctrl/Cmd + Z` 撤销。此时 AI 代理的检查点会一直保留到 OpenScreen 退出。如果应用没有响应，对该项目的编辑会被拒绝，因为编辑器会用自己的副本覆盖这些编辑。
- **在 AI 代理请求之前，录制内容没有转录文本。** AI 代理会在删除词语或开启字幕之前调用 `transcribe`。Whisper 在你的电脑上运行，OpenScreen 打开时则在 OpenScreen 中运行。
- **由脚本驱动的录制**（例如 Playwright）永远不会移动屏幕指针。AI 代理通过 `setPointerTrack` 把它自己的操作日志交给 OpenScreen，视频照样会有光标及其缩放。
- **`openscreen-demo` 技能**会教 AI 代理完成整个工作，从分镜脚本到成品视频。之后，它会把视频附加到拉取请求中，让审阅者直接在那里看到改动；或者起草一条 X 帖子，而且只有在你同意之后，它才会发布这条帖子。使用 `npx skills add getopenscreen/openscreen --skill openscreen-demo` 添加它。具体步骤见 [`plugin/skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/plugin/skills/openscreen-demo/SKILL.md)。
