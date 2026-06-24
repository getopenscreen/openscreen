# OpenScreen Roadmap
The recorder you love, with an optional AI sidekick. Same sleek, low-friction recorder UX. An opt-in AI editing layer is on the way for users who want it — never required, never snuck in.

This roadmap is the source of truth for what we're shipping next in OpenScreen. It is a living document — items move between tiers as work lands. Have an idea, a vote, or a dissenting opinion? Drop into the 🗺️・roadmap channel on our Discord or open a GitHub issue with the `roadmap` label.

## 🧭 North Star
**Record → Edit → Export.** (with an optional AI shortcut for users who want one)

OpenScreen is, first and foremost, a polished screen recorder. Record, trim on the timeline, export. Most users will keep using exactly this workflow.

We're also exploring an optional AI editing layer — for users who want to edit by talking or by editing a transcript. It's opt-in, off by default, and never required. If you don't enable it, the AI layer doesn't exist for your install: nothing downloads, nothing leaves your machine, no LLM is contacted.

Three axes guide every decision on this roadmap:

- **Stability first** — the recorder must work reliably on macOS, Windows, and Linux. Bugs found by real users ship before new features.
- **Sleek UX stays** — every AI feature must keep the OpenScreen feel: minimal clicks, instant feedback, no clutter.
- **100% free, forever** — no paywalls, no premium tier, no usage caps. Every feature on this page ships under MIT.

## 🤖 Direction — the optional AI Edition
A Screen Studio + Descript clone, open-source and free forever. The recorder-first UX stays intact, and the AI layer sits beside it, off by default.

Capabilities we're exploring (each one opt-in, each one toggleable independently):

- **Local Whisper transcription (opt-in, on-device)** — OpenScreen already ships on-device Whisper transcription for automatic captions. This extends that foundation: the same local transcript powers the editing features below, with no upload, no cloud, no extra setup required.
- **Transcript-driven editing (opt-in, local)** — edit video like a doc (Descript-style: delete a word, cut the span). Works with the local transcript; no cloud needed.
- **One-click cleanup (opt-in, local)** — filler-word removal, silence trimming, Studio Sound voice enhancement. All on-device.
- **Edit by chat (opt-in, requires BYO LLM key)** — say "cut the part where I repeat myself between 0:42 and 1:10" and the agent applies a structured timeline operation. Off until you connect a provider.
- **Non-destructive project document (always on)** — every edit, AI or manual, is undoable; the timeline is always recoverable.
- **Bring-your-own LLM (opt-in)** — OpenAI, Anthropic, Google, Mistral, OpenRouter, GitHub Copilot, OpenAI-compatible endpoints, ChatGPT account auth. You choose; we never see your keys or your data.

This section is a direction, not a sprint plan. Concrete items land here as RFCs once the recorder is stable enough to build on top of.

## 🛠️ Stability & quality (what we're actually shipping)
Pulled from real user bug reports on getopenscreen/openscreen. This is the queue for the next release window.

- [ ] **Fix:** video disappears from editor after export — [#8](../../issues/8) (Linux, Manjaro). Renderer regression after export.
- [ ] **Fix:** crash after stopping macOS recording — [#21](../../issues/21) (macOS 26.4.1, Apple Silicon). Crash is in the Electron / Node async fs shutdown path; recording artifacts are written correctly.
- [ ] **Fix:** macOS cursor offset in single-window capture — [#22](../../issues/22).
- [ ] **Fix:** recover preview from WebGL context loss on Linux / Wayland — [#19](../../issues/19).
- [ ] **Feature:** software H.264 fallback when no GPU encoder MFT is available — [#18](../../issues/18). Critical for VMs, broken-driver machines, and headless environments.
- [ ] **Feature:** copy / paste attributes & effects in the timeline — [#24](../../issues/24). Right-click menu + standard Ctrl/Cmd+C / Ctrl/Cmd+V shortcuts.

## 📬 How to influence this roadmap
- **Discord** — join the OpenScreen Discord and post in [#🗺️・roadmap](https://discord.com/channels/1489517664467681310/1493586210675884265). The fastest way to get a thumbs-up or thumbs-down on a feature.
- **GitHub** — open an issue with the `enhancement` label, or react with 👍 / 👎 on existing items.
- **PRs** — if you want to ship one of these, open a PR and link the relevant issue. We review fast and help with native-bridge / i18n questions.

Anything not on this list yet? Open an issue and tag it `roadmap` — we'll triage it into a tier within a week.

---

## Changelog
- **2026-06-24** — initial draft. Stability items pulled from open issues / PRs on getopenscreen/openscreen. AI section presented as opt-in / off by default. Whisper entry updated to reflect existing caption feature.
- **2026-06-24** — roadmap sync smoke test: discord-pinned-message mechanism goes live.
- **2026-06-24** — second smoke test after fixing embed truncation math.
- **2026-06-24** — third smoke test: verify PATCH path (not POST) now that the message id is tracked.
- **2026-06-24** — fourth smoke test: pin-as-state refactor (variable no longer required).
- **2026-06-24** — fifth smoke test: pin permission granted, verify self-healing pin works.
- **2026-06-24** — sixth smoke test: DISCORD_ROADMAP_MESSAGE_ID variable removed; verify the bot finds the message via pin lookup alone.
- **2026-06-24** — seventh smoke test: PR-merge trigger (validate the `pull_request_target` `closed`+`merged` path).