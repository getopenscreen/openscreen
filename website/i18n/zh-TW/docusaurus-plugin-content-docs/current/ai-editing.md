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

OpenScreen 內建一個選用的代理，可以從聊天面板剪輯你的專案。它**在你自行連接提供者之前都是關閉的**，在那之前不會有任何內容送往任何模型。連接之後，代理只會和該提供者通訊，[字幕翻譯](./captions.md#translation)也一樣。應用程式其他的網路使用（轉錄模型下載、更新檢查）列在[常見問題](./faq.md#does-openscreen-work-offline)中。

:::tip
這些都不是必要的。錄影、剪輯、轉錄、字幕與匯出，全都不需要帳號也不需要提供者就能使用，無論你是否開啟過聊天面板。其中只有轉錄需要下載一次：第一次執行時下載[轉錄模型](./captions.md#transcribing)。
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

用一般的語言描述你要的剪輯，例如「剪掉開頭的空檔」、「我打開終端機時放大畫面」。代理會透過真實、可復原的時間軸操作來完成工作，而不是重新算繪：它可以新增與調整剪輯、縮放、速度區域、標註（文字、箭頭，以及遮住畫面上隱私資訊的模糊）、匯入的音軌及其淡入淡出與全螢幕攝影機片段，在你的點擊處加入自動縮放，編輯片段的入點與出點和裁切，放入另一個來源的畫面，複製、重新排序或移除片段，也會讀取逐字稿來找出你指的是哪一段。它也能設定影片的外觀：背景、邊距、圓角、陰影、裝置外框、畫面比例、攝影機版面、游標與整體音量。它也能開啟[字幕](./captions.md)，設定字幕的樣式與位置，並自行將字幕翻譯成另一種語言。它也能寫出設定裡沒有的視覺效果：請參閱[自訂效果](./effects.md)。

它周圍的面板包括：

- **對話**：歷史紀錄、重新命名、刪除，以及開始新對話。每段對話都保有各自的代理狀態。
- **模型選擇器**：從已連接的提供者即時取得模型清單；若提供者支援，還有推理強度控制項。
- **上下文用量**：顯示已使用的預估權杖數與預算的比較，並提供**壓縮**動作，將較早的對話回合摘要起來，而不是直接捨棄。
- **倒轉至此訊息**：復原代理在該時間點之後所做的編輯與所有後續回合，同時還原專案、對話與代理狀態。
- **代理編輯**：**AI 設定**中的一個開關。關閉時，代理嘗試進行的每項編輯都會被拒絕：它仍然可以讀取專案，並描述它會做的變更，但在你重新開啟這個開關之前，它不會套用任何變更。

`Ctrl/Cmd + Z` 可以復原代理的編輯，方式和復原手動編輯完全相同。

時間軸自動加強選單中的**智慧剪輯**項目（標示為「使用 AI」），就是以單次提示執行的同一個代理。（另一個項目**自動縮放**會讀取錄下的點擊，完全不需要提供者。）

## 還有哪些功能會使用你的提供者 {#what-else-uses-your-provider}

[字幕翻譯](./captions.md#translation)是對同一個模型發出的單次文字轉換呼叫：它不會執行代理的循環，也無法更動你的文件。如果你在聊天中提出要求，代理會改為自行翻譯字幕，並放入同一個翻譯層。無論如何，轉錄與字幕算繪都完全在你的裝置上進行。

## 使用 Claude Code、Codex 或其他 MCP 用戶端 {#using-claude-code-codex-or-another-mcp-client}

如果你已經在使用 Claude Code 或 Codex 等 AI 程式設計代理，它可以用自己的帳號登入，驅動相同的剪輯工具。該帳號的任何資訊都不會經過 OpenScreen。

1. **AI 設定** → **MCP 伺服器** → 將它開啟。它只會在你自己的電腦（`127.0.0.1`）上、於顯示的連接埠監聽。
2. 複製那裡顯示的 **Claude Code** 或 **Codex** 指令，並在終端機中執行。Claude Code 指令中帶有存取權杖。Codex 則改為從 `OPENSCREEN_MCP_TOKEN` 環境變數讀取權杖：請在啟動 Codex 的終端機中設定它。
3. 請你的代理進行剪輯，對象可以是 OpenScreen 編輯器中開啟的專案，也可以是清單中的任何其他專案。

這些工具就是內建代理所使用的工具，另外還有錄影、匯出和查看影片的工具（[見下文](#letting-an-agent-make-the-whole-video)）。此外還有 `transcribe`：它會像編輯器開啟專案時那樣，在你的裝置上用 Whisper 處理專案的媒體。用戶端會用自己的模型翻譯字幕，因此字幕翻譯不需要在 OpenScreen 中設定提供者。除非用戶端指定其他專案，否則這些工具作用於編輯器中開啟的專案：用戶端可以列出所有專案，並讀取或編輯其中任何一個。它也可以建立專案（空白專案，或從一個影片檔建立）、重新命名專案，以及在專案的媒體中加入或移除影片或音訊檔。刪除專案不在這些工具之中：這仍由你在應用程式中進行。在你同時開啟 MCP 伺服器區段中的**MCP 編輯**之前，MCP 用戶端只能**讀取**，它們嘗試的每項編輯、錄影、匯出或新建專案都會被拒絕。這個開關與內建代理的**代理編輯**開關各自獨立，預設為關閉。開啟後，每項編輯都會在生效時立即儲存：

- **在編輯器中開啟的專案上**，編輯可用 `Ctrl/Cmd + Z` 復原。用戶端會被告知在進行一系列編輯之前先儲存檢查點，因此你可以請它們一步將專案還原成原本的樣子，而這一步本身也可以用 `Ctrl/Cmd + Z` 復原。
- **在其他任何專案上**，編輯會儲存到它的檔案中，`Ctrl/Cmd + Z` 無法復原。用戶端必須在第一次編輯之前儲存該專案的檢查點，還原到這個檢查點是唯一的復原方式。

檢查點保存在 OpenScreen 的記憶體中：OpenScreen 結束或伺服器重新啟動時就會遺失，而變更連接埠或重新產生權杖都會讓伺服器重新啟動。只會保留最近的 20 個檢查點，因此較早的檢查點可能會提早失效。**重新產生**權杖，即可中斷所有使用舊權杖設定的用戶端。

## 讓代理製作整支影片 {#letting-an-agent-make-the-whole-video}

代理可以從錄影到匯出自行製作一整支影片。無論以哪種方式加入 OpenScreen，除了剪輯工具之外，代理都能使用 `listSources`、`startRecording`、`stopRecording`、`setPointerTrack`、`exportVideo`、`getFrames` 與 `createProject`。與錄影列一樣，錄影時也能錄下你的網路攝影機與系統本身的游標；匯出則接受匯出對話框的選項：MP4 的畫質與影格速率，GIF 的影格速率、尺寸與循環播放。

**透過上述伺服器**，錄影由 OpenScreen 自己完成，就像按下它的錄影按鈕一樣：編輯器會關閉，錄影列倒數後開始錄影，錄好的內容會以新專案在編輯器中開啟，你可以看到每項編輯即時生效。這需要開啟**MCP 編輯**，錄影結束後，錄影列會恢復你自己的設定。

**以 stdio 伺服器的形式加入時**，完全不需要設定：代理會以 `mcp` 啟動應用程式本身的執行檔。

最快的方式是將下面這段內容貼到你的AI 代理（Claude Code、Codex、Cursor 等）中：

```text
Install the OpenScreen demo skill with `npx skills add getopenscreen/openscreen --skill openscreen-demo -y`, then follow it to make a demo video of this feature.
```

如果缺少 OpenScreen，該技能會在你同意後安裝它，並加入它的 MCP 伺服器。接著它會請你開啟一個新的工作階段，並說出 *continue the OpenScreen demo*：代理只有在新的工作階段中才能取得新工具。若要改為手動設定：

```bash
claude mcp add openscreen -- "<executable>" mcp
codex mcp add openscreen -- "<executable>" mcp
```

`<executable>` 是應用程式的執行檔，各系統上的路徑列在[執行 CLI](./cli.md#running-the-cli)中。其他用戶端（例如 Cursor）以 stdio 伺服器的方式加入：執行檔作為 `command`，`["mcp"]` 作為 `args`。

此技能也以外掛形式提供，來自儲存庫本身的外掛市集。在 Claude Code 中：

```text
/plugin install openscreen --marketplace getopenscreen/openscreen
```

對於共用外掛的 Codex 與 ChatGPT 桌面應用程式：

```bash
codex plugin marketplace add getopenscreen/openscreen
codex plugin add openscreen@openscreen
```

之後，OpenScreen 會連同該技能一起出現在應用程式的已安裝外掛中。

- **不需要連接埠、權杖或設定。** 代理會以你的權限自行啟動程序，就像它執行 `openscreen record` 一樣。因此，它不需要**MCP 編輯**開關，就能錄製你的螢幕並進行剪輯。
- **每段錄影都會成為一個新專案**，出現在你的專案清單中，並和在應用程式中錄製的影片一樣，在錄下的點擊處加上縮放：時間與位置都相近的點擊共用一個縮放，開頭幾秒與結尾保持全螢幕。代理的每項編輯都會儲存到專案檔案中。要復原，就靠代理建立的檢查點，檢查點在代理的工作階段結束前都有效。只會保留最近的 20 個檢查點，因此較早的檢查點可能會提早失效。
- **OpenScreen 執行時，代理會透過應用程式進行編輯。** 對編輯器中開啟的專案所做的編輯會立即顯示在那裡，並可用 `Ctrl/Cmd + Z` 復原。此時代理的檢查點會保留到 OpenScreen 結束為止。如果應用程式沒有回應，對該專案的編輯會被拒絕，因為編輯器會用自己的副本覆寫這些編輯。
- **在代理要求之前，錄影沒有逐字稿。** 代理會在刪除字詞或開啟字幕之前呼叫 `transcribe`。Whisper 在你的電腦上執行，OpenScreen 開啟時則在 OpenScreen 中執行。
- **由腳本驅動的錄影**（例如 Playwright）永遠不會移動螢幕上的指標。代理會用 `setPointerTrack` 把它自己的操作記錄交給 OpenScreen，影片照樣會有游標與其縮放。
- **`openscreen-demo` 技能**會教代理完成整個工作，從分鏡腳本到完成的影片。之後，它會把影片附加到拉取請求中，讓審閱者直接在那裡看到變更；或者草擬一則 X 貼文，而且只有在你同意之後，它才會發布這則貼文。使用 `npx skills add getopenscreen/openscreen --skill openscreen-demo` 加入它。完整步驟請見 [`plugin/skills/openscreen-demo/SKILL.md`](https://github.com/getopenscreen/openscreen/blob/main/plugin/skills/openscreen-demo/SKILL.md)。
