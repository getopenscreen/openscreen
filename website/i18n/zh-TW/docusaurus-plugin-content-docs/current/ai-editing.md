---
id: ai-editing
title: AI 剪輯
sidebar_position: 8
description: "連接你自己的 LLM 金鑰，就能在聊天面板中剪輯 OpenScreen 專案。此功能為選用且預設關閉：在你連接提供者之前，不會有任何內容送往模型。"
keywords:
  - AI 影片剪輯
  - LLM 影片編輯器
  - 聊天剪輯
  - 自備金鑰
  - 隱私
---

# AI 剪輯

OpenScreen 內建一個選用的代理，可以從聊天面板剪輯你的專案。它**在你自行連接提供者之前都是關閉的**，在那之前不會有任何內容送往任何模型。連接之後，代理只會和該提供者通訊，[字幕翻譯](./captions.md#translation)也一樣。應用程式其他的網路使用（Whisper 模型下載、標註字體、更新檢查）列在[簡介](./intro.md)中。

:::tip
這些都不是必要的。錄影、剪輯、轉錄、字幕與匯出，全都不需要帳號也不需要提供者就能使用，無論你是否開啟過聊天面板。其中只有轉錄需要下載一次：第一次執行時下載 [Whisper 模型](./captions.md#transcribing)。
:::

## 連接提供者 {#connecting-a-provider}

開啟聊天欄（在**編輯**模式下，位於頂端列最左側的開關），接著進入 **AI 設定**，選擇提供者並貼上 API 金鑰：

| 提供者 | 備註 |
|---|---|
| **Claude API**（Anthropic） | |
| **OpenAI API** | |
| **Gemini API**（Google） | |
| **Mistral API** | |
| **OpenRouter API** | 一個金鑰，多種模型。 |
| **MiniMax API**／**MiniMax Token Plan** | |
| **OpenAI Compatible** | 任何 OpenAI 格式的端點，由你提供基礎 URL。 |

你的金鑰會透過作業系統的憑證保護機制（Electron `safeStorage`）加密儲存；如果無法加密，寫入就會失敗，而不會退回以明文儲存。OpenScreen 的伺服器永遠看不到你的金鑰，因為根本沒有伺服器：請求會直接從你的電腦送到你選擇的提供者。如果你完全不想儲存金鑰，也可以使用各提供者專屬的環境變數。

:::note
ChatGPT 與 GitHub Copilot 的登入選項已**在 1.8.0 中移除**。它們的運作方式，是隨應用程式附上這些廠商自己的第一方用戶端憑證，而我們無權重新散布這些憑證。請改用以 API 金鑰連接的提供者。
:::

## 使用代理 {#using-the-agent}

用一般的語言描述你要的剪輯，例如「剪掉開頭的空檔」、「我打開終端機時放大畫面」。代理會透過真實、可復原的時間軸操作來完成工作，而不是重新算繪：它可以新增與調整剪輯、縮放、速度區域、標註與全螢幕攝影機片段，編輯片段的入點與出點，重新排序或移除片段，也會讀取逐字稿來找出你指的是哪一段。

它周圍的面板包括：

- **對話**：歷史紀錄、重新命名、刪除，以及開始新對話。每段對話都保有各自的代理狀態。
- **模型選擇器**：從已連接的提供者即時取得模型清單；若提供者支援，還有推理強度控制項。
- **上下文用量**：顯示已使用的預估權杖數與預算的比較，並提供**壓縮**動作，將較早的對話回合摘要起來，而不是直接捨棄。
- **倒轉至此訊息**：復原代理在該時間點之後所做的編輯與所有後續回合，同時還原專案、對話與代理狀態。
- **專案編輯**：**AI 設定**中的一個開關。關閉時，代理嘗試進行的每項編輯都會被拒絕：它仍然可以讀取專案，並描述它會做的變更，但在你重新開啟這個開關之前，它不會套用任何變更。

`Ctrl/Cmd + Z` 可以復原代理的編輯，方式和復原手動編輯完全相同。

時間軸自動加強選單中的**智慧剪輯**項目（標示為「使用 AI」），就是以單次提示執行的同一個代理。（另一個項目**自動縮放**會讀取錄下的點擊，完全不需要提供者。）

## 還有哪些功能會使用你的提供者 {#what-else-uses-your-provider}

[字幕翻譯](./captions.md#translation)是對同一個模型發出的單次文字轉換呼叫：它不會執行代理的循環，也無法更動你的文件。無論如何，轉錄與字幕算繪都完全在你的裝置上進行。

## 使用 Claude Code、Codex 或其他 MCP 用戶端 {#using-claude-code-codex-or-another-mcp-client}

如果你已經在使用 Claude Code 或 Codex 等 AI 程式設計代理，它可以用自己的帳號登入，驅動相同的剪輯工具。該帳號的任何資訊都不會經過 OpenScreen。

1. **AI 設定** → **MCP 伺服器** → 將它開啟。它只會在你自己的電腦（`127.0.0.1`）上、於顯示的連接埠監聽。
2. 複製那裡顯示的 **Claude Code** 或 **Codex** 指令，並在終端機中執行。Claude Code 指令中帶有存取權杖。Codex 則改為從 `OPENSCREEN_MCP_TOKEN` 環境變數讀取權杖：請在啟動 Codex 的終端機中設定它。
3. 讓專案在 OpenScreen 編輯器中保持開啟，然後請你的代理進行剪輯。

這些工具就是內建代理所使用的工具，作用於編輯器中開啟的專案。在你同時開啟 MCP 伺服器區段中的**專案編輯**之前，MCP 用戶端只能**讀取**專案；這個開關與內建代理的開關各自獨立，預設為關閉。開啟後，每項編輯都會在生效時立即儲存，並可用 `Ctrl/Cmd + Z` 復原。用戶端會被告知在進行一系列編輯之前先儲存檢查點，因此你可以請它們一步將專案還原成原本的樣子，而這一步本身也可以用 `Ctrl/Cmd + Z` 復原。**重新產生**權杖，即可中斷所有使用舊權杖設定的用戶端。

## 讓代理製作整支影片 {#letting-an-agent-make-the-whole-video}

上述伺服器用於剪輯專案。若要讓代理從錄影到匯出自行製作一整支影片，請改為將 OpenScreen 以 stdio 伺服器的形式加入代理：代理會以 `mcp` 啟動應用程式本身的執行檔。它能使用相同的剪輯工具，另外還有 `listSources`、`startRecording`、`stopRecording`、`setPointerTrack`、`exportVideo` 與 `getFrames`。

最快的方式是將下面這段內容貼到 Claude Code 中：

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -a claude-code`, then follow it to make a demo video of this feature.
```

如果缺少 OpenScreen，該技能會在你同意後安裝它，並加入它的 MCP 伺服器。接著它會請你開啟一個新的工作階段，並說出 *continue the OpenScreen demo*：代理只有在新的工作階段中才能取得新工具。若要改為手動設定：

```bash
claude mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
codex mcp add openscreen -- "/Applications/Openscreen.app/Contents/MacOS/Openscreen" mcp
```

各系統上的執行檔列在[執行 CLI](./cli.md#running-the-cli)中。

- **不需要連接埠、權杖或設定。** 代理會以你的權限自行啟動程序，就像它執行 `openscreen record` 一樣。因此，它不需要**專案編輯**開關，就能錄製你的螢幕並進行剪輯。
- **每段錄影都會成為一個新專案**，出現在你的專案清單中，並和在應用程式中錄製的影片一樣，在錄下的點擊處加上縮放：相近的點擊共用一個縮放，開頭幾秒與結尾保持全螢幕。代理仍在處理時，請不要在編輯器中剪輯它：編輯器會保留自己的副本。
- **由腳本驅動的錄影**（例如 Playwright）永遠不會移動螢幕上的指標。代理會用 `setPointerTrack` 把它自己的操作記錄交給 OpenScreen，影片照樣會有游標與其縮放。
- **`openscreen-demo` 技能**會教代理完成整個工作，從分鏡腳本到完成的影片。之後，它會把影片附加到拉取請求中，讓審閱者直接在那裡看到變更；或者草擬一則 X 貼文，而且只有在你同意之後，它才會發布這則貼文。使用 `npx skills add getopenscreen/openscreen --skill openscreen-demo` 加入它。完整步驟請見 [`skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/skills/openscreen-demo/SKILL.md)。
