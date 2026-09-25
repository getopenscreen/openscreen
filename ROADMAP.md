# OpenScreen Roadmap
The recorder you love, with an optional AI sidekick.

This page tracks what we are fixing, what comes next and what shipped recently. **Last reviewed on 2026-09-25, at v1.13.0.** Ideas and votes are welcome in [#🗺️・roadmap](https://discord.com/channels/1489517664467681310/1493586210675884265) on our Discord or in a GitHub issue.

## 🧭 North Star
**Record → Edit → Export.** OpenScreen is a polished screen recorder first. Most people record, trim and export, and never need more.

- **Stability first.** Recording must work on macOS, Windows and Linux. Bugs from real users ship before new features.
- **Sleek UX stays.** Every feature keeps the OpenScreen feel: few clicks, instant feedback, no clutter.
- **100% free, forever.** No paywall, no premium tier, no usage caps. Everything on this page ships under MIT.
- **Your data stays on your machine.** Transcription, captions and webcam background removal run on-device. The speech model, about 260 MB, downloads once, the first time you open a clip with speech. Nothing reaches an LLM until you connect a provider with your own key, and requests then go straight from your machine to that provider.

## 🛠️ Stability queue
Open bugs, most severe first.

- **Windows:** a recording can hang on stop and leave an empty file ([#252](../../issues/252)). A fix shipped in v1.11.0; we are waiting for confirmation on the affected machines.
- **macOS:** a long take can end up truncated while the timer keeps running ([#621](../../issues/621)). Fixed in v1.12.0, awaiting confirmation.
- **Linux on niri (Wayland):** nothing records even though screen sharing is granted ([#324](../../issues/324)). Fixes in v1.12.0 and v1.13.0, awaiting confirmation.
- **Linux AppImage:** PipeWire capture fails with "error alloc buffers" ([#646](../../issues/646)).
- **Linux on GNOME with older AMD GPUs:** some recordings come out with invalid H.264 ([#615](../../issues/615)).
- **Windows:** game recordings stutter on some machines ([#510](../../issues/510)).
- **WinGet:** versions since v1.12.0 have not reached WinGet ([#757](../../issues/757)).

## 🚀 In the next release
Merged on `main`.

- **macOS:** a first-run window for permissions ([#735](../../issues/735)), and choosing what to record in Apple's system picker on macOS 15.2+ ([#737](../../issues/737)).
- **Auto-zoom:** suggestions placed on your recorded clicks ([#706](../../issues/706)), and transitions paced by zoom depth ([#765](../../issues/765)).
- **Transcription:** silent stretches are skipped before transcribing ([#639](../../issues/639)).

## 🚧 In progress
Open pull requests.

- **Editor redesign,** in review as a stack of PRs starting at [#767](../../issues/767).
- **Auto-zoom controls:** zoom level buttons ([#694](../../issues/694)), and fewer unwanted zooms while dragging ([#731](../../issues/731), fixes [#725](../../issues/725)). Fixed zoom levels and a way to turn auto-zoom off are requested in [#683](../../issues/683), [#670](../../issues/670) and [#723](../../issues/723).
- **macOS system audio** through a Core Audio tap ([#740](../../issues/740)).
- **Timeline:** trim a clip by dragging its edge ([#668](../../issues/668)), split at the playhead ([#669](../../issues/669)).
- **Custom recordings folder** ([#650](../../issues/650), requested in [#727](../../issues/727)).

## 🗓️ Next up
Planned, no PR yet.

- **More 3D camera moves:** a dolly, a camera that swings toward clicks, and motion blur while the camera moves.
- **AI agent:** chat history that survives a restart, approving an agent turn before it applies, and undoing a whole turn in one step.
- **One-click cleanup:** remove filler words, enhance the voice.
- **ChatGPT and GitHub Copilot sign-in,** through the vendors' sanctioned routes: GitHub's Copilot SDK and `codex app-server`.
- **Transcription:** more precise word timing and speaker labels ([#626](../../issues/626), [#729](../../issues/729), help wanted).
- **Linux:** no screen-sharing prompt at every recording.
- **Performance:** export benchmarks on discrete GPUs and Intel Quick Sync.

## 💡 Under consideration
Requested by users, not scheduled. PRs welcome.

- **Package managers:** Homebrew ([#732](../../issues/732)), AppImage delta updates and no libfuse2 dependency ([#734](../../issues/734), [#736](../../issues/736)). Flathub is on hold ([#341](../../issues/341)).
- **Live annotation** while recording ([#277](../../issues/277)).
- **iPhone and iPad** as a recording source ([#117](../../issues/117)).
- **Audio options:** raw audio and higher quality ([#677](../../issues/677)).
- **Floating webcam self-view** while recording ([#500](../../issues/500)).

## ✅ Shipped since the last review
v1.8.0 to v1.13.0. Full notes on the [Releases](../../releases) page; everything that shipped earlier, including the AI editing layer, is in the [docs](https://getopenscreen.com/docs/intro/).

- **3D effects:** a camera that follows the cursor, a modelled 3D cursor, tilt with click impact, depth of field, and 3D device frames (laptop, phone, browser, monitor).
- **Webcam background:** remove, blur or replace it, on-device.
- **Audio lanes:** imported music, and voice-over recorded on the timeline.
- **Transcript corrections:** fix or delete words.
- **Auto-zoom** after every recording, and a cursor that hides when idle.
- **Style presets** saved as shareable files.
- **Auto-updates** on all three platforms.
- **Crash-safe recordings,** with recovery after a failed stop.
- **Headless CLI:** `record`, `export` and `info`.
- **Teleprompter** mode in Notes.
- **Faster exports:** GPU export with VA-API hardware encoding on Linux, and a faster macOS pipeline.
- **Distribution:** Microsoft Store, notarized macOS builds, a Fedora RPM, and no Visual C++ Redistributable needed on Windows.
- **Czech and German,** for 15 UI languages.
- **Website** at [getopenscreen.com](https://getopenscreen.com), in 8 languages, with docs, a blog and a CLI reference.

## 📬 How to influence this roadmap
- **Discord:** post in [#🗺️・roadmap](https://discord.com/channels/1489517664467681310/1493586210675884265). The fastest way to get a thumbs-up or thumbs-down on a feature.
- **GitHub:** open an issue, or react with 👍 / 👎 on an existing one.
- **PRs:** want to ship one of these? Open a PR and link the issue. We review fast and help with native-bridge and i18n questions.

Anything missing? Open an issue; we triage new issues within a week.

---

## Changelog
- **2026-06-24** — initial draft. Stability items pulled from open issues / PRs on getopenscreen/openscreen. AI section presented as opt-in / off by default. Whisper entry updated to reflect existing caption feature.
- **2026-06-25** — added "Site & documentation" tier: Docusaurus + GitHub Pages. Cleaned smoke-test noise from the changelog (internal CI sync validation, not user-facing).
- **2026-07-06** — added blur regions to the stability & quality tier. Confirmed upstream deprecated the feature in v1.5.0 without an explicit reason; the renderer code carried over to the fork, so the work is unblocking the export guard + adding coverage. Tracked via #76.
- **2026-07-27** — reconciled the roadmap with the code. The AI Edition tier moved from "a direction, not a sprint plan" to shipped: on-device transcription, transcript-driven editing, captions as a derived layer with translation, the chat agent, and `.openscreen` projects are all in. Provider list corrected — ChatGPT and GitHub Copilot were removed in 1.8.0 and are now blocked on the vendors' sanctioned surfaces, and MiniMax was missing. New "Rendering & platform parity" tier: preview and MP4 export share one native D3D11 compositor, and porting it off Windows is now the biggest open item; #18 moved there since it's an encoder concern. Blur (#76) marked shipped — as an annotation type, not a region kind, so the old note pointing at `src/lib/exporter/videoExporter.ts` was doubly stale (that file was deleted with the web export pipeline). Copy/paste (#24) split: the shortcuts shipped, the right-click menu didn't. Docusaurus site marked shipped.
- **2026-08-01** — the platform-parity tier was the stalest thing on this page: it still described the compositor as Direct3D 11 and listed MP4 export on macOS and Linux as unstarted, while v1.8.0-rc.5 was already publishing DMGs and Linux packages built on the Metal and WGSL backends. #18 (software encoder fallback) shipped with them, as an automatically-selected CPU backend rather than an encoder flag. Two real gaps replace them: Linux export is software-encoded, and every performance number on record still comes from one passive-iGPU laptop. Also corrected the framing that produced this drift — the tier was written as "porting it off Windows is the biggest open item", which stayed true in the text long after it stopped being true in the tree.
- **2026-09-25:** full review at v1.13.0, six releases after the last one. Reorganized by horizon, with a "last reviewed" line at the top. Closed out: #8, #19, #21 and #22 (fixed or merged), Linux hardware encode (VA-API since v1.11.0), the custom domain. Dropped the right-click timeline menu, which is not planned (#105). Corrected the AI promise: transcription has run automatically since v1.8.0 and downloads its model on first use, so "nothing downloads until you opt in" no longer held. Removed the `roadmap` label from the instructions: it never existed.
