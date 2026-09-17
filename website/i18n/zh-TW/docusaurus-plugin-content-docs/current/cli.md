---
id: cli
title: 供腳本與代理使用的螢幕錄影 CLI
sidebar_label: CLI
description: "OpenScreen 的螢幕錄影命令列工具（CLI），可讓腳本、CI 工作與程式設計代理錄影、加上字幕並匯出 .openscreen 專案，並以 NDJSON 格式輸出結果。"
keywords:
  - 螢幕錄影 CLI
  - 命令列錄製螢幕
  - 無頭螢幕錄影
  - 自動產生產品示範影片
  - NDJSON
  - openscreen export
---

# 螢幕錄影 CLI

OpenScreen 的命令列介面內建在桌面應用程式本身的執行檔中。`openscreen record`、`captions`、`export`、`pack`、`info` 與 `sources` 可以在終端機中執行，不會開啟任何視窗，而 `--json` 會把它們的輸出轉為 stdout 上的 NDJSON。腳本、CI 工作或程式設計代理可以錄製一段影片、將 `.openscreen` 專案當作一般 JSON 編輯，再用與編輯器**匯出**按鈕相同的原生合成器算繪出 MP4 或 GIF。

它不是伺服器工具。每個指令都會啟動 Electron，即使不會出現任何視窗，Electron 仍然需要顯示伺服器，而錄影則需要真正的桌面工作階段。請參閱[什麼情況下不適合使用 CLI](#when-the-cli-is-not-the-right-tool)。

:::caution
CLI 與 `.openscreen` 專案格式在不同版本之間仍可能出現不相容的變更。每次更新後，請檢查你的腳本。
:::

## 執行 CLI {#running-the-cli}

請先[安裝 OpenScreen](/download/)（[安裝說明](./installation.md)）。每個指令都是應用程式執行檔的子指令：

| 安裝方式 | 執行檔 |
|---|---|
| macOS | `/Applications/Openscreen.app/Contents/MacOS/Openscreen` |
| Windows 安裝程式 | 安裝時所選資料夾中的 `Openscreen.exe`：僅為目前使用者安裝時是 `%LOCALAPPDATA%\Programs\Openscreen\`，為所有使用者安裝時是 `C:\Program Files\Openscreen\` |
| Linux `.deb`、`.rpm`、`.pacman` | `openscreen` |
| Linux AppImage | `./Openscreen-Linux-1.11.0.AppImage` |
| Nix | `openscreen` |

本頁的範例都寫成 `openscreen`。在 macOS 與 Windows 上，請使用完整路徑或別名：

```bash
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
```

- `openscreen help`、`--help` 或 `-h` 會印出用法說明。
- 放在子指令之前的 Chromium 參數會被略過。如果 Chromium 的沙箱無法在主機上啟動，請執行 `./Openscreen-Linux-1.11.0.AppImage --no-sandbox export demo.openscreen`。
- CLI 執行時不會取得應用程式的單一執行個體鎖定，所以桌面應用程式開著時也能使用。
- 若從原始碼的 checkout 執行，請依照[建置與打包（英文）](https://github.com/getopenscreen/openscreen/blob/main/technical-documentation/engineering/build-and-packaging.md)的說明建置應用程式與其原生輔助程式，然後執行 `npm run cli -- <command> [options]`。

## 指令 {#commands}

### `openscreen record` {#openscreen-record}

若要從命令列錄製螢幕，請執行 `record`。它驅動的是與桌面應用程式相同的錄影機制，檔案會存放在應用程式的錄影目錄中，與在圖形介面中錄製的檔案放在一起：包括螢幕影片，以及在擷取到指標資料時產生的 `<video>.cursor.json` 游標遙測檔，可編輯游標與 `--auto-zoom` 都會讀取這個檔案。

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| 選項 | 說明 |
|---|---|
| `--display <n>` | 螢幕索引，即 `openscreen sources` 列出的編號（預設為 0） |
| `--window <title>` | 錄製標題包含 `<title>` 的第一個視窗，不分大小寫。優先於 `--display` |
| `--mic` | 錄製預設麥克風 |
| `--mic-device <name>` | 錄製名稱包含 `<name>` 的麥克風，不分大小寫。隱含 `--mic` |
| `--system-audio` | 錄製系統音訊 |
| `--cursor <editable-overlay\|system>` | `editable-overlay`（預設）會隱藏系統指標，並將它記錄為資料，讓編輯器可以重新設定樣式。`system` 會將指標直接繪入影片 |
| `--duration <seconds>` | 經過這段時間後自動停止 |
| `--project <out.openscreen>` | 完成後寫出一個參照這段錄影的專案檔，可直接用於 `export` 或編輯器。副檔名必須是 `.openscreen` |
| `--json` | 在 stdout 上輸出 NDJSON 事件 |

沒有網路攝影機選項：CLI 錄影只包含螢幕畫面與音訊。

**停止錄影。** 沒有指定 `--duration` 時，可以用 Ctrl+C（SIGINT）、SIGTERM，或在 stdin 輸入 `stop`、`q` 或 `quit` 再按 Enter 來停止錄影。關閉 stdin 並不會停止錄影。強制終止會跳過正常的收尾流程，因此不會寫出 `done` 事件，也不會寫出專案檔。

**各平台說明**

- **macOS：** 擷取透過 ScreenCaptureKit 輔助程式進行，沒有備援。必須具備「螢幕錄製」權限；若是從終端機啟動的開發版本，請將權限授予該終端機。使用 `--mic` 時，如果尚未授予麥克風權限，CLI 會提出要求。只有在具備「輔助使用」權限時，才會記錄指標的點擊與形狀。
- **Windows：** 擷取透過 Windows Graphics Capture 輔助程式進行，需要 Windows 10 組建 19041 以上。在較舊的組建上，或缺少輔助程式時，OpenScreen 會改用瀏覽器擷取。Windows 永遠不會送出 SIGTERM：請使用 Ctrl+C、stdin 的 `stop` 或 `--duration`。
- **Linux：** 擷取透過 PipeWire 輔助程式與桌面環境的 ScreenCast portal 進行。錄製的內容由 portal 本身的選擇器決定，它每次執行都會開啟並等待回應，所以 `--display` 與 `--window` 無法選擇來源，Linux 上的錄影也無法在無人操作的情況下開始。它需要具備 `xdg-desktop-portal` 的桌面工作階段：沒有顯示環境的 SSH 工作階段無法錄影。只有缺少輔助程式的組建，才會改用 Chromium 的擷取功能。

### `openscreen sources` {#openscreen-sources}

列出應用程式能看到的顯示器、視窗與麥克風，讓腳本可以選擇 `--display`、`--window` 與 `--mic-device` 的值。在 Linux 上，`record` 錄製的內容仍由 portal 選擇器決定。

```bash
openscreen sources                   # human-readable
openscreen sources --json            # NDJSON on stdout
openscreen sources -o sources.json   # payload written to a file
```

使用 `--json` 時，資料會包含在最後的 `done` 事件中：

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

當裝置名稱需要尚未授予的權限，或是無法在幾秒內讀取裝置清單時，`microphoneLabelsUnavailable` 會是 `true`。

**為什麼要有 `-o`？** CLI 只會把自己的輸出寫到 stdout；Chromium 的診斷訊息則會寫到 stderr。但包在程序外面的包裝程式就另當別論了。Ubuntu 的 `xvfb-run` 是在沒有螢幕的機器上執行圖形介面程式的常見方式，它會把 stderr 合併到 stdout，於是 Chromium 的啟動警告會出現在 JSON 之前，導致 `openscreen sources --json | jq` 失敗。`-o <file>` 會寫到任何包裝程式都無法重新導向的位置，也能避開 shell 引號與編碼上的差異。

這兩個管道承載的資料形式不同。stdout 會把資料包在 `done` 事件中，因為它是串流中的一個事件。檔案則只包含資料本身：

```bash
openscreen sources --json | jq 'select(.event == "done") | .sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json                             # file: the payload itself
```

檔案只會在成功時寫入，而且是以原子方式寫入：執行失敗時，先前的檔案會保持不變。請檢查結束代碼，而不是檢查檔案是否存在。

### `openscreen export` {#openscreen-export}

使用編輯器預覽與匯出時所用的原生合成器，將專案算繪為 MP4 或 GIF。縮放、剪輯、速度區域、標註與字幕、游標與背景，全都取自專案。

```bash
openscreen export demo.openscreen                          # format and quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen -o out.mp4 --auto-zoom --json
```

| 選項 | 說明 |
|---|---|
| `-o, --out <path>` | 輸出檔案。副檔名（`.mp4` 或 `.gif`）決定格式。預設：專案的路徑，副檔名改為 `.mp4` 或 `.gif` |
| `--format <mp4\|gif>` | 覆寫專案中儲存的格式。必須與 `--out` 一致 |
| `--quality <medium\|good\|source>` | 輸出尺寸：`medium` 為 720p，`good` 為 1080p，`source` 依裁切後最小的片段而定，所以絕不會放大。GIF 也以這個尺寸為起點 |
| `--gif-fps <15\|20\|25\|30>` | GIF 影格率 |
| `--gif-size <medium\|large\|original>` | 套用在上述尺寸上的 GIF 高度上限：720、1080，或不設上限 |
| `--auto-zoom` | 算繪之前，在錄下的指標停頓處加入縮放，使用的引擎與編輯器的[自動縮放](/features/auto-zoom/)相同。既有的縮放會保留，新的縮放絕不會與它們重疊 |
| `--audio <file>` | 將旁白檔（mp3、wav 或 m4a）混入 MP4。僅限 MP4 |
| `--audio-mode <mix\|replace>` | `mix`（預設）會保留錄影的音訊，以 40% 增益墊在旁白底下；`replace` 則捨棄錄影的音訊 |
| `--audio-offset <seconds>` | 旁白開始前的延遲（預設為 0） |
| `--json` | 在 stdout 上輸出 NDJSON 格式的進度與結果 |

CLI 匯出的 MP4 一律是 **H.264、60 fps**。沒有編碼格式或影格率選項。桌面應用程式的[匯出](./export.md)對話框另外提供 H.265 與 24 或 30 fps。

`--audio` 會在算繪之後才作用：視訊串流會原封不動地複製，再混入一條新的 AAC 音軌，並寫回同一個輸出檔案。

**媒體可以放在哪裡。** 載入專案時，應用程式只會自動核准位於其錄影目錄中，或專案檔所在資料夾中的參照媒體。請將手動撰寫的專案與其媒體放在一起，或是用 CLI 錄影，因為 CLI 會使用錄影目錄。

**無法取消。** 只有 `record` 會接收停止要求。要放棄一次匯出，唯一的方法就是結束該程序；它在輸出路徑留下的任何檔案，都應視為無法使用。

### `openscreen captions` {#openscreen-captions}

用 Whisper 在你的電腦上轉錄專案的音訊，然後將字幕標註寫入專案檔。不會上傳任何內容，語言也會自動偵測。與桌面應用程式一樣，第一次執行時會下載一次 Whisper 模型，大小約 264 MB。

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # captions are burned into the video
```

- `--min-words` 與 `--max-words` 設定每則字幕的字數。預設值：2 與 7。
- 再次執行會取代它先前加入的字幕。你自己加入的標註會保留。
- 專案的螢幕影片必須有音軌，例如用 `record --mic` 錄製的影片。
- 字幕會燒錄進匯出的影片，不會輸出字幕檔。請參閱[字幕](./captions.md)。

### `openscreen pack` {#openscreen-pack}

將專案及其參照的所有內容（螢幕影片、網路攝影機影片、游標遙測資料）複製到同一個資料夾，並改寫複製後專案中的媒體路徑。

```bash
openscreen pack demo.openscreen --out bundle/
```

`--out` 為必要選項，也可以用簡寫 `-o`。這個資料夾可以搬移，也可以保留為 CI 產出物：當儲存的絕對路徑已不存在時，應用程式會改用專案檔旁邊同名的檔案。

### `openscreen info` {#openscreen-info}

印出專案參照了哪些內容、它的螢幕影片是否仍然存在，以及它的匯出設定，和其中包含多少縮放、剪輯、速度區域與標註。

```bash
openscreen info demo.openscreen --json
```

當參照的螢幕影片遺失時，它會以結束代碼 1 結束。

## 機器可讀的輸出 {#machine-readable-output}

使用 `--json` 時，stdout 每一行都是一個 JSON 物件。stderr 只包含診斷訊息，包括應用程式本身的記錄行。

```json
{"event":"started","command":"export"}
{"event":"progress","percentage":50,"currentFrame":60,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

| 事件 | 送出時機 | 欄位 |
|---|---|---|
| `started` | `record`、`sources`、`export` 或 `captions` 開始執行時 | `command` |
| `log` | 輸出狀態訊息時，例如 `Recording started` | `message` |
| `progress` | 匯出的影格完成編碼時 | `percentage`、`currentFrame`、`totalFrames`、`estimatedTimeRemaining`（以秒為單位）。混入 `--audio` 期間：`percentage` 與 `phase: "mixing-voiceover"` |
| `stopping` | `record` 收到停止要求時 | `reason`：`SIGINT`、`SIGTERM` 或 `stdin` |
| `warning` | 執行成功但有需要注意的事項時 | `message` |
| `error` | 回報失敗時 | `message` |
| `done` | 執行結束時，無論成功與否 | `success`，接著是結果或 `error` |

`done` 包含的內容：

- **export：** `outputPath`、`format`、`width`、`height`。
- **record：** `screenVideoPath`、`cursorDataPath`（遙測檔的存放位置；該檔案可能不存在）、`durationMs`；使用 `--project` 時，還有 `projectPath` 與 `projectData`，也就是它寫出的專案。
- **sources：** `sources`。
- **captions：** `projectPath`、`captionCount`。
- **pack：** `projectPath`、`files`、`cursorData`。`pack` 不會送出 `started` 事件。

`info --json` 會印出單一摘要物件，其中沒有 `event` 欄位。

`pack` 或 `info` 失敗時，會以 `error` 事件結束，沒有 `done`。當機時可能以 `error` 事件結束，也可能在 stdout 上什麼都不再輸出。請以結束代碼為準。

**結束代碼**

| 代碼 | 意義 |
|---|---|
| `0` | 成功 |
| `1` | 失敗，包括對螢幕影片已遺失的專案執行 `info` |
| `2` | 參數錯誤。即使指定了 `--json`，錯誤訊息與用法說明仍會以純文字輸出到 stderr |

## 範例：自動產生產品示範影片 {#example-an-automated-product-demo}

腳本或程式設計代理可以在不開啟編輯器的情況下，產生一支附字幕、帶縮放的示範影片：

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

在步驟 3 中，`depth` 的範圍是 1 到 6（1.25× 到 5×；3 代表 1.8×），`cx` 與 `cy` 則以畫面的比例值指定縮放中心的位置。

若要改用文字轉語音引擎來配旁白，請在錄影時不要加上 `--mic`，並在匯出時混入旁白。任何能輸出 mp3、wav 或 m4a 的引擎都可以；以下以 macOS 的 `say` 為例：

```bash
say -o voice.m4a --file-format=m4af "Welcome to MyProduct. Here is a quick tour."
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace
```

`captions` 讀取的是錄影本身的音軌，而不是匯出時才混入的旁白，所以用這種方式加入的文字轉語音旁白不會有字幕。

**匯出其他工具產生的影片。** `export` 不一定需要 OpenScreen 的錄影。它能接受的最小專案，只包含一個媒體路徑和一個空的編輯器設定，這會成為一個套用預設設定、長度完整的片段：

```json
{
  "version": 2,
  "media": { "screenVideoPath": "/path/to/clip.mp4" },
  "editor": {}
}
```

請將它存放在與該片段相同的資料夾中。沒有游標遙測資料時，`--auto-zoom` 就沒有任何依據可以運作。

## 顯示環境、CI 與伺服器 {#displays-ci-and-servers}

- 每個指令都會啟動 Electron，而 Electron 會啟動 Chromium，所以即使不會開啟任何視窗，仍然必須有顯示伺服器。在沒有螢幕的 Linux 機器上，可以用 `xvfb-run` 啟動的虛擬 X 伺服器來提供。
- `export` 不擷取任何內容，所以在有 Vulkan 驅動程式的前提下，可以用這種方式執行：Linux 的合成器透過 Vulkan 算繪，沒有 GPU 的機器則需要軟體驅動程式，例如 Mesa 的 lavapipe。專案的 Nix 建置工作流程就是用這種方式，在沒有螢幕的 Linux runner 上，以 `xvfb-run` 搭配 lavapipe，從產生的片段算繪出 MP4；如果沒有產出 MP4，工作流程就會失敗。
- `record` 則不行。在同樣的 runner 上，Chromium 找不到可以擷取的顯示器；而且在 Linux 上，portal 選擇器本來就需要有人操作。

## 什麼情況下不適合使用 CLI {#when-the-cli-is-not-the-right-tool}

- **你需要在伺服器上錄影**，而且沒有顯示環境或桌面工作階段。錄影需要真正的桌面，而在 Linux 上，每次執行都必須有人回應 portal 選擇器。
- **你需要穩定且有版本管理的 API。** CLI 與專案格式在不同版本之間仍可能改變。
- **你需要從命令列控制編碼格式、影格率或位元率。** CLI 匯出的 MP4 是 H.264、60 fps，而且 MP4 的位元率在應用程式中也無法調整。
- **你需要在腳本化的錄影中加入網路攝影機。** `record` 沒有攝影機選項。
- **你需要字幕檔。** 字幕只會燒錄進影片。

若要在編輯器中實際走一遍相同的步驟，請參閱[如何製作產品示範影片](./guides/product-demo-video.md)。關於授權與網路使用的問題，請參閱[常見問題](./faq.md)。

## 原始碼 {#source-code}

CLI 是 [OpenScreen 儲存庫](https://github.com/getopenscreen/openscreen)的一部分：

- `electron/cli/args.ts`：參數解析器與用法說明文字，單元測試位於 `args.test.ts`。
- `electron/cli/cliMain.ts`：無視窗啟動、stdio 通訊協定、停止訊號與結束代碼。
- `electron/cli/projectCommands.ts`：`pack` 與 `info`。
- `src/cli/`：`record`、`sources`、`export` 與 `captions` 的隱藏視窗執行器。
- `src/lib/cliContracts.ts`：兩端共用的請求與結果型別。
