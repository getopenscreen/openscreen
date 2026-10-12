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

OpenScreen 提供一个可选的 AI 代理，可以在聊天面板中编辑你的项目。**在你亲自连接提供方之前，它一直处于关闭状态**，在此之前不会向任何模型发送任何内容。连接之后，AI 代理只与该提供方通信，[字幕翻译](./captions.md#translation)也是如此。应用的其他网络用途（下载 Whisper 模型、标注字体、检查更新）列在[简介](./intro.md)中。

:::tip
以上这些都不是必需的。无论你是否打开过聊天面板，录制、编辑、转录、字幕和导出都无需账号、无需提供方即可使用。其中只有转录需要下载一次：首次运行时下载的 [Whisper 模型](./captions.md#transcribing)。
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

用日常语言描述你想要的编辑，例如“剪掉开头的空白”“我打开终端时放大画面”。AI 代理通过真实、可撤销的时间轴操作来完成编辑，而不是重新渲染：它可以添加和调整删减区间、缩放、速度区间、标注和全屏摄像头区间，编辑片段的入点/出点，重新排序或移除片段，还会读取转录文本，找到你所指的内容。

它周围的面板包括：

- **对话**：历史记录、重命名、删除以及新建对话。每个对话都保留各自的 AI 代理状态。
- **模型选择器**：来自已连接提供方的实时模型列表；如果提供方支持，还可以调节推理强度。
- **上下文用量表**：已用 token 数相对于预算的估算值，并提供**压缩上下文**操作，它会总结较早的对话轮次，而不是直接丢弃。
- **回退到此消息**：撤回 AI 代理在该时间点之后所做的编辑以及之后的每一轮对话，同时恢复项目、对话和 AI 代理状态。
- **项目编辑**：**AI 设置**中的一个开关。关闭时，AI 代理尝试的每项编辑都会被拒绝：它仍然可以读取项目，并描述它会做出的修改，但在你重新打开这个开关之前，不会应用任何修改。

`Ctrl/Cmd + Z` 撤销 AI 代理的编辑，与撤销手动编辑完全一样。

时间轴自动增强菜单中的**智能剪切**（标有“*使用 AI*”）就是这个 AI 代理，只是执行一次性的提示词。（另一项**自动缩放**读取录制下来的点击，完全不需要提供方。）

## 还有哪些功能会用到你的提供方 {#what-else-uses-your-provider}

[字幕翻译](./captions.md#translation)是对同一模型发起的单次文本转换调用：它不运行 AI 代理循环，也无法改动你的文档。无论哪种情况，转录和字幕渲染都完全在本机进行。

## 使用 Claude Code、Codex 或其他 MCP 客户端 {#using-claude-code-codex-or-another-mcp-client}

如果你已经在使用 Claude Code 或 Codex 等 AI 编程代理，它可以用自己的账号登录，驱动同样的编辑工具。该账号的任何信息都不会经过 OpenScreen。

1. **AI 设置** → **MCP 服务器** → 将其开启。它只在你自己的电脑（`127.0.0.1`）上、在显示的端口上监听。
2. 复制那里显示的 **Claude Code** 或 **Codex** 命令，并在终端中运行。Claude Code 命令中带有访问令牌。Codex 则改为从 `OPENSCREEN_MCP_TOKEN` 环境变量读取令牌：请在启动 Codex 的终端中设置它。
3. 在 OpenScreen 编辑器中保持一个项目处于打开状态，然后让你的 AI 代理进行编辑。

这些工具就是内置 AI 代理所使用的工具，它们作用于编辑器中打开的项目。在你同时开启 MCP 服务器部分中的**项目编辑**之前，MCP 客户端只能**读取**项目；这个开关独立于内置 AI 代理的开关，默认处于关闭状态。开启后，每项编辑都会在生效时立即保存，并可用 `Ctrl/Cmd + Z` 撤销。客户端会被要求在进行一系列编辑之前保存一个检查点，因此你可以让它们一步把项目恢复原样，而这一步本身也可以用 `Ctrl/Cmd + Z` 撤销。**重新生成**令牌，即可断开所有使用旧令牌配置的客户端。

## 让 AI 代理制作整段视频 {#letting-an-agent-make-the-whole-video}

上面的服务器用于编辑项目。若要让 AI 代理从录制到导出独立完成一整段视频，请改为把 OpenScreen 作为 stdio 服务器添加到 AI 代理中：AI 代理会用 `mcp` 启动应用自身的可执行文件。它能使用同样的编辑工具，另外还有 `listSources`、`startRecording`、`stopRecording`、`setPointerTrack`、`exportVideo` 和 `getFrames`。

最快的方式是把下面这段内容粘贴到 Claude Code 中：

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -a claude-code`, then follow it to make a demo video of this feature.
```

如果缺少 OpenScreen，该技能会在你同意后安装它，并添加它的 MCP 服务器。随后它会请你打开一个新会话，并说出 *continue the OpenScreen demo*：AI 代理只有在新会话中才能获得新工具。若要改为手动设置：

```bash
claude mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
codex mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
```

各系统上的可执行文件列在[运行 CLI](./cli.md#running-the-cli)中。

- **无需端口、令牌或设置**。AI 代理以你的权限自行启动进程，就像它运行 `openscreen record` 一样。因此，它无需**项目编辑**开关，就能录制你的屏幕并进行编辑。
- **每次录制都会成为一个新项目**，出现在你的项目列表中，并且与在应用中录制的内容一样，在每次录制下来的点击处添加缩放。在 AI 代理仍在处理它时，不要在编辑器中编辑它：编辑器会保留自己的副本。
- **由脚本驱动的录制**（例如 Playwright）永远不会移动屏幕指针。AI 代理通过 `setPointerTrack` 把它自己的操作日志交给 OpenScreen，视频照样会有光标及其缩放。
- **`openscreen-demo` 技能**会教 AI 代理完成整个工作，从分镜脚本到成品视频。之后，它会把视频附加到拉取请求中，让审阅者直接在那里看到改动；或者起草一条 X 帖子，而且只有在你同意之后，它才会发布这条帖子。使用 `npx skills add getopenscreen/openscreen --skill openscreen-demo` 添加它。具体步骤见 [`skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/skills/openscreen-demo/SKILL.md)。
