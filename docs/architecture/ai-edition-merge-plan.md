# AI Edition Merge Plan — OpenScreen × Axcut

> **Goal.** Make OpenScreen the host of the Axcut engine. The recorder stays the front door; the new project model (multi-asset → clips → skips) becomes the canonical timeline; AI features (transcript, agent, providers) sit on top as an opt-in layer.
>
> **Outcome.** The recording you make today becomes a resource in a multi-clip project. Transcript, clips, skips, agent chat, and BYO-LLM providers integrate cleanly with OpenScreen's recorder, exporter, and UX — without forking the codebase.

---

## 1. Why this is bigger than "merge two repos"

Axcut was built as a separate TypeScript-control / Python-worker web app with its own Fastify server, SQLite, and sidecar Python process. OpenScreen is an Electron + React app with an in-browser exporter (mediabunny) and an in-browser Whisper (`@xenova/transformers`). Forcing axcut's process model into OpenScreen would mean:

- Two transcription pipelines (browser Whisper + Python faster-whisper) → inconsistent UX, double downloads
- A sidecar Python process inside an Electron app → fragile on macOS/Windows, huge native footprint
- A separate Fastify server inside Electron → wasted cycle
- Two exporters (mediabunny + Python ffmpeg pipeline) → divergent output, double maintenance

So the merge strategy is **not "port axcut's files in"**. It's **"adopt axcut's data model and UX patterns, re-implement them on OpenScreen's existing primitives"**. The Python + Fastify layers in axcut die; the schema, the agent runtime, and the UI patterns live.

---

## 2. Architecture — the SSOT

### 2.1 The new project document (SSOT)

`AxcutDocument` from `packages/axcut-schema/src/index.ts` becomes OpenScreen's canonical project model. It already has:

- `project` (id, title, timestamps, primaryAssetId)
- `assets[]` (video sources with metadata)
- `transcripts[]` (per-asset)
- `timeline { clips, gaps, skipRanges, muteRanges, speedRanges, captionRanges }`
- `agent { baseIntent, pendingQuestions, suggestions, lastAppliedOperations }`
- `preview { strategy, revision }`
- `export { preset, lastJobId }`
- `history { revisions[] }`

This is the SSOT. Timeline, transcript, agent, history — all read and write through this document. Renderer, main process, and exporter all consume the same shape.

**Migration:** existing `EditorProjectData` projects (v2) get a one-shot migration on first open in AI Edition:

| Legacy field | Maps to |
|---|---|
| `media.screenVideoPath` / `media.cameraVideoPath` | a single `asset` + a single clip spanning its full duration |
| `editor.trimRegions[]` | the inverse — gaps in the timeline, expressed as `skipRanges` on the asset |
| `editor.speedRegions[]` | timeline.speedRanges |
| `editor.zoomRegions[]` | timeline (modeled as `captionRanges` annotation + a new `zoomRanges[]` field added to the schema — see §2.4) |
| `editor.annotationRegions[]` | a new `annotations[]` field on the schema |
| `editor.{wallpaper, aspectRatio, cursor, padding, crop, webcam*, motionBlur, borderRadius}` | `editor.*` stays; rename legacy `editor` to `legacyEditor` on migration and apply those fields through the export pipeline the same way as today |

**Single source of truth, two views.** The renderer keeps a local store of `AxcutDocument` (via Zustand or plain context, TBD in Phase 1); the main process persists it to `app.getPath('userData')/projects/<id>.axcut` and SQLite for sessions/messages/checkpoints/jobs.

### 2.2 Renderer layout (post-merge)

```
src/
  lib/
    ai-edition/                ← new namespace; everything AI-Edition is here
      schema/                  ← Zod schemas copied/adapted from @axcut/schema
      document/                ← mutations, history, ids, validate
      timeline/                ← normalizeIntervals, buildTimelineFromIntervals, virtual-preview
      transcript/              ← editable-transcript (LCS deletion)
      agent/                   ← deepagentjs tool factories (renderer-side helpers only)
      providers/               ← provider list & capability map (mirrors axcut's)
    exporter/                  ← existing, refactored to consume AxcutDocument
    captioning/                ← existing; expose as a reusable service for AI-Edition
  components/
    ai-edition/                ← mirrors apps/web/src/components in axcut
      VirtualPreview.tsx
      TimelinePane.tsx
      TranscriptEditor.tsx
      CurrentTranscriptView.tsx
      SuggestionList.tsx
      ProviderSettingsDialog.tsx
      LlmSetupPanel.tsx
      SessionHistoryDialog.tsx
      InsertAssetDialog.tsx
      TranscriptDialog.tsx
    video-editor/              ← existing; rewritten to consume AxcutDocument
      VideoEditor.tsx          ← becomes the AI-Edition shell
      VideoPlayback.tsx        ← deprecated in favor of ai-edition/VirtualPreview
      timeline/                ← existing single-track TimelineEditor deprecated; TimelineWrapper + Row + Subrow stay as low-level primitives if useful
electron/
  ai-edition/                  ← main-process counterparts
    document-service.ts        ← port of axcut's DocumentService
    agent-session-service.ts   ← port; SQLite-backed checkpoints
    agent-runtime.ts           ← port; creates DeepAgentJS from provider config
    chat-service.ts            ← port; persists messages, runs runtime, emits events
    llm-config-service.ts      ← port; provider credentials, models, base URLs
    database.ts                ← better-sqlite3 schema (projects, messages, jobs, sessions, checkpoints)
    event-bus.ts               ← per-project pub/sub for renderer sync
    ipc.ts                     ← IPC channel map (typed)
    python/                    ← DELETED. Everything in axcut's py/ dies.
  ipc/handlers.ts              ← extended with ai-edition channel handlers
```

Why a new `ai-edition/` namespace inside `src/` and `electron/` instead of a separate package? OpenScreen is a single-package app (`package.json` has no `workspaces`). A monorepo refactor is a 10x cost with no payoff. We adopt `axcut-schema`'s *schema and semantics*, but the schema lives in `src/lib/ai-edition/schema/` as part of the OpenScreen package.

### 2.3 Schema delta

Two additions to `AxcutDocument` to keep OpenScreen's existing UX (zoom, annotations, appearance):

```ts
// added to documentSchema in src/lib/ai-edition/schema/index.ts
annotations: z.array(annotationRegionSchema).default([]),     // mirrors editor.annotationRegions
zoomRanges:   z.array(zoomRegionSchema).default([]),          // mirrors editor.zoomRegions
legacyEditor: legacyEditorSchema.nullable().default(null),    // migration target for old projects
```

Legacy fields (`wallpaper`, `aspectRatio`, `cursor`, `webcam*`, `motionBlur`, `borderRadius`, `cropRegion`, `padding`) live under `legacyEditor` and are applied at export time exactly as today. Renderer reads them; main process reads them at export.

Schema version bumps to **3**.

### 2.4 Process model — kill the sidecar

| Axcut layer | Replaced by |
|---|---|
| `apps/server` (Fastify + SQLite + jobs) | `electron/ai-edition/` (main-process modules + better-sqlite3) |
| `py/axcut-core` (ffprobe, faster-whisper, render) | DELETED. Use OpenScreen's `src/lib/exporter` (mediabunny) and `src/lib/captioning` (transformers.js Whisper). |
| `py/axcut-worker` (CLI subprocess) | DELETED. No Python in OpenScreen. |
| `apps/web` (React app served by Fastify) | OpenScreen's renderer. Same React, different mount point — the AI Edition opens inside `VideoEditor` (or a sibling route), not as a standalone window. |
| Docker Compose | DELETED. OpenScreen is an Electron app, no container. |

**Trade-off:** axcut's ffmpeg-Python exporter has more flexibility (precise control over filters, complex cut/join). mediabunny covers our needs for clips+skips with `seek()` on multiple source videos and an in-browser MP4 mux. If a clip needs cross-clip transitions or fades that mediabunny can't do, we use WebCodecs + a frame queue — already in `src/lib/exporter/`. So we lose nothing in practice.

---

## 3. UX integration — OpenScreen feel stays

### 3.1 Recording flow → multi-asset project

Today: `Record → Trim on single-track timeline → Export`. The recording is the project.

After merge: `Record` produces an `asset` and a `clip`. Pressing **Stop** does not auto-trim — it appends to the project. The user can record more takes. The project grows.

- A new **Resources** panel lists assets (recordings + imported files).
- The timeline shows clips + skips. New recordings default to `append at end`; users drag-reorder.
- Pressing **Stop** doesn't close the editor — that's the new behavior for AI-edition projects (locked decision §5.1: first recording still auto-opens; subsequent ones stay in the recorder with a prompt).

### 3.2 Trim visualization

Replace OpenScreen's single-video `<VideoPlayback>` with axcut's `VirtualPreview` (two-layer, crossfade-at-clip-end) for AI-Edition projects. Native-recording scrubbing preview stays for the recorder side (it already lives there).

Visually: identical to axcut's current preview, with OpenScreen's design tokens (rounded corners, neutral dark, typography from the launch window). Re-skin, don't rewrite.

### 3.3 Clips management on the timeline

axcut's `TimelinePane` is the new timeline. It already supports:

- Drag a source from the **Resources** panel → drops at a position → opens `InsertAssetDialog` (before / after / split).
- Drag a clip's body → reorder (with ghost + insert marker).
- Pencil button → enters clip-edit mode (handles on left/right).
- Skip handles at left/right (always-visible).
- Ctrl+C / Ctrl+V → duplicate clip.
- Zoom + pan via the existing OpenScreen `TimelineWrapper` zoom/pan logic.

We re-skin it to match OpenScreen's design tokens. The **Timeline component rewrite** is the most visible Phase 1 work — but most of the logic ports directly from axcut.

### 3.4 Agent chat panel

A collapsible right-side panel inside the editor (mirror of axcut's App layout: project panel left, transcript center, chat right, timeline bottom). Mounted only when the AI Edition flag is on. Provider settings open in a modal, same flow as axcut's `ProviderSettingsDialog`.

When the AI Edition flag is off, the editor looks like today's OpenScreen: single asset, single track, trim, export.

---

## 4. Phasing — ten phases, each ships as 1–3 PRs

Each phase ends in a usable, tested state. **Do not** start a phase until the previous one is on `main`.

### Phase 0 — Foundation (≈ 1 PR)

- Vendor `packages/axcut-schema/src/index.ts` into `src/lib/ai-edition/schema/`. Rename types from `Axcut*` → keep as `Axcut*` (already the right namespace, no churn for readers of axcut docs).
- Bump schema version to 3, add the `annotations`, `zoomRanges`, `legacyEditor` fields (§2.3).
- Add `featureFlags.aiEdition` (defaults off) to `src/components/video-editor/featureFlags.ts`.
- Migrate `EditorProjectData` persistence: when `aiEdition` flag is on, save `AxcutDocument` instead. When off, keep current `EditorProjectData` save. Single codebase, two save formats, one source of truth.
- Add migration: existing v2 `EditorProjectData` → v3 `AxcutDocument` (single asset + clip + skipRanges from inverse of trimRegions). Function in `src/lib/ai-edition/document/migrate.ts`.
- New unit tests for the schema + migration.

**Acceptance:** `npm run test` green. Loading an old `.openscreen` project under the AI Edition flag produces a valid v3 document; legacy users see no change.

### Phase 1 — Core merge: clips, skips, multi-asset (≈ 3 PRs)

Three PRs because the change is large and benefits from reviewable chunks.

**PR 1.1 — Resources panel + asset model**

- `electron/ai-edition/document-service.ts` (port of axcut's DocumentService, slimmed: no separate `paths.ts`, lives in `app.getPath('userData')`).
- Renderer store: `useProjectStore` (Zustand) holding `AxcutDocument` + revision counter.
- `src/components/ai-edition/ProjectPanel.tsx` — left sidebar, lists assets + compositions.
- IPC: `ai-edition:document:get` / `set` / `listProjects` / `createProject` / `updateProject` / `addAsset` / `removeAsset`.

**PR 1.2 — Timeline rewrite (clips + skips)**

- Port `apps/web/src/components/TimelinePane.tsx` → `src/components/ai-edition/TimelinePane.tsx`.
- Drop source from Resources → drop on timeline → `InsertAssetDialog`.
- Clip drag-reorder, duplicate (Ctrl+C/V), move.
- Skip range handles (always-on; pencil button toggles clip-handle mode).
- IPC + reducer ops: `addClip` / `updateClipRange` / `moveClip` / `duplicateClip` / `addSkipRange` / `updateSkipRange` / `removeSkipRange`.
- Re-skin to OpenScreen design tokens.

**PR 1.3 — Recording → resource**

- Change post-Stop behavior: append new recording to current project's `assets`, create a clip spanning the full duration, insert at end of timeline. Don't auto-open editor (per locked decision §5.1: first recording still auto-opens; subsequent ones stay in the recorder with an "Open editor / Record another" prompt).
- OpenScreen's `recordingSession.ts` stays as-is; new code in `electron/recording/postRecord.ts` adds the asset + clip to the active `AxcutDocument`.

**Acceptance:** record two takes → both appear as clips in a project → reorder → trim handles work → export produces a cut video of the timeline.

### Phase 2 — VirtualPreview (≈ 1 PR)

- Port `apps/web/src/components/VirtualPreview.tsx` → `src/components/ai-edition/VirtualPreview.tsx`.
- Two `<video>` layers with crossfade at clip boundary; virtual time → source time mapping via `locateVirtualPosition`.
- Keep OpenScreen's existing recorder-side playback untouched.
- The new `VirtualPreview` becomes the preview inside `VideoEditor` when `aiEdition` is on.

**Acceptance:** playback is seamless across clips; seeking to a time jumps the right clip; preview matches export.

### Phase 3 — Exporter rewrite (≈ 2 PRs)

**PR 3.1 — Document-driven exporter**

- `src/lib/exporter/videoExporter.ts` accepts `AxcutDocument` instead of single clip.
- For each kept segment (after `applySkipRangesToClips`), open the source video via mediabunny, seek + decode + draw frames through the existing `frameRenderer` pipeline (annotations, zoom, blur, webcam composite all stay).
- Output: single MP4 through the existing muxer.

**PR 3.2 — Test coverage**

- Round-trip: render a 3-clip project with one skip region → output MP4 → ffprobe → assert duration + presence of expected frames.

**Acceptance:** exports match preview; tests pass on Linux CI; manual smoke on macOS + Windows.

### Phase 4 — Transcription + transcript editor (≈ 2 PRs)

**PR 4.1 — Transcription pipeline**

- Reuse OpenScreen's existing `src/lib/captioning/transcribe.ts` (transformers.js Whisper). Wrap it as `transcribeAsset(asset, language)` → returns `AxcutTranscript`.
- In the renderer: run on demand from `TranscriptDialog` (re-skin of axcut's).
- Persist into `AxcutDocument.transcripts[]`.

**PR 4.2 — Transcript editor**

- Port `TranscriptEditor.tsx` + `CurrentTranscriptView.tsx` → `src/components/ai-edition/`.
- Click-word, shift-click-word → range → "Cut" → `dropWordRange` op.
- `editable-transcript.ts` (LCS-based deletion) ports as-is.
- Kept / skipped styling: OpenScreen's existing token for `danger` / `muted`.

**Acceptance:** transcript appears within minutes (cached model); deleting a word from the transcript re-derives the timeline intervals and updates the preview.

### Phase 5 — Recorder-side feature preservation

Make sure recorder continues to work as a one-shot: stop → trim → export, with no AI Edition project required. This is the OpenScreen we ship today; the AI Edition is opt-in.

- `VideoEditor` reads `featureFlags.aiEdition`. When off, render the existing single-track timeline + `VideoPlayback`. When on, render the new components.

---

### Phase 6 — Agent runtime (≈ 2 PRs)

**PR 6.1 — Main process**

- Port `agent-session-service.ts` (sessions, checkpoints, SQLite-backed `PersistentFileCheckpointSaver`).
- Port `axcut-deep-agent.ts` → `electron/ai-edition/agent-runtime.ts`; builds DeepAgentJS tool set from `AxcutDocument` ops.
- Port `chat-service.ts` → `electron/ai-edition/chat-service.ts`; uses the existing EventBus for renderer sync.
- IPC: `ai-edition:chat:run`, `ai-edition:sessions:list` / `create` / `rename` / `delete` / `select`.

**PR 6.2 — Renderer**

- Port `apps/web/src/components/CurrentTranscriptView.tsx` (chat panel) and `SuggestionList.tsx` (pending cut suggestions).
- Wire to IPC + React Query (already used in OpenScreen? verify; if not, plain `useEffect` + IPC events).

**Acceptance:** "Remove silences" prompt produces a real `replace_timeline` op applied to the document, with a checkpoint saved before/after.

### Phase 7 — LLM providers + BYO config (≈ 1 PR)

- Port `provider-registry.ts`, `llm-config-store.ts`, `llm-config-service.ts`, `create-chat-model.ts`, `openai-account.ts`, `copilot-account.ts`, `chat-codex-oauth.ts` → `electron/ai-edition/`.
- Port `ProviderSettingsDialog.tsx` (the modal with providers/models/reasoning/device-challenge for OAuth) → `src/components/ai-edition/`.
- Credentials stored in `app.getPath('userData')/llm-credentials.json`, same shape as axcut.

**Acceptance:** all axcut-supported providers (OpenAI, Anthropic, Google, Mistral, OpenRouter, OpenAI-compatible, GitHub Copilot, OpenAI OAuth) work; reasoning effort selectable.

### Phase 8 — Conversation history, checkpoints, context compaction

- Renderer's `SessionHistoryDialog.tsx` (port from axcut).
- Per-session checkpoint restore: clicking "Restore" rewinds `AxcutDocument` to that point + rebuilds the agent's langgraph state.
- Context compaction: keep the existing `before-compaction` / `after-compaction` checkpoint reasons from axcut's `AgentSessionService`. The compaction algorithm (long-context summarization) ports as-is.

**Acceptance:** users can branch off any past checkpoint; the agent's memory survives a project reload.

### Phase 9 — Polish

- 13-locale i18n pass on every new string (`npm run i18n:check`).
- Settings sync (`userPreferences.ts`): AI Edition on/off, default provider, default model, default reasoning effort.
- ROADMAP update: the "AI Edition" section turns from "direction" into "shipped phases X-Y; remaining Z".
- Empty states, error toasts (sonner already in deps), keyboard shortcuts help.
- Permission pass on native-bridge changes (record → asset adds a path to the document, which gets rendered back via `file://` — must use the same `assetBaseUrl` pattern already in `transcribe.ts`).

### Phase 10 — Cut-over

- Flip the default in `featureFlags.aiEdition` to **on** for new projects only. Existing v2 projects stay on legacy until the user opts in.
- After one minor release of opt-in feedback, flip the default universally and deprecate the legacy timeline.

---

## 5. Locked decisions (resolved before Phase 0)

These were the open questions going into the merge. They're now decided — see `ai-edition-collision-analysis.md §9` for the reasoning behind each.

1. **Stop behavior.** First recording always auto-opens the editor (current behavior). Second-and-later recordings in an active AI-edition project stay in the recorder with an "Open editor / Record another" prompt. Locked: 2026-06-25.
2. **Auto-caption annotation injection (`annotationsFromCaptions.ts`).** Drop entirely. AI-edition's transcript is the source of truth; users add overlay annotations manually if needed. Locked: 2026-06-25.
3. **React Query.** Add `@tanstack/react-query` as a dependency. Phase 6 (agent runtime) leans on it heavily. Locked: 2026-06-25.
4. **LLM credential storage.** Use Electron's `safeStorage` (OS keychain). Plain JSON storage (axcut's choice) is a security regression. Locked: 2026-06-25.
5. **Whisper model default.** Bundle OpenScreen's existing smaller model. Add a clear "Transcription model" picker in settings: `tiny / base / small / medium` with download size + speed hints, opt-in to larger. Locked: 2026-06-25.
6. **Proxy MP4 generation.** Drop. Rely on `StreamingVideoDecoder` (WebCodecs) for editor scrubbing. **Known limitation:** users have reported scrubbing lag on long recordings (>30 min). See §8 for the documented concern and the revival path. Locked: 2026-06-25.
7. **File extension.** Keep `.openscreen`. No rename. Existing users have files with that extension; internal users get a one-time migration only if desired. Locked: 2026-06-25.
8. **Repository / packaging model.** AI-edition lives **in-tree** as `src/lib/ai-edition/`, `electron/ai-edition/`, `src/components/ai-edition/`, `src/i18n/locales/<locale>/ai-edition.*` — **single package, single repo, single `package.json`, single CI, single release.** No separate npm package, no monorepo tooling. Gated behind `featureFlags.aiEdition` (default off in Phase 0; cut-over plan in §4 — Phase 10). Locked: 2026-06-25.

---

## 6. Files that change, files that don't

**Don't touch** (avoid scope creep):
- `electron/native/` (ScreenCaptureKit + WGC helpers)
- `src/lib/cursor/` (cursor capture + smoothing)
- `src/lib/wallpaper.ts`, `src/lib/recordingSession.ts`, `src/lib/shortcuts.ts`
- `src/components/launch/`
- `tests/e2e/` for recorder flow

**Rewrite** (in order):
- `src/components/video-editor/VideoEditor.tsx` — becomes the AI Edition shell
- `src/components/video-editor/VideoPlayback.tsx` — deprecated
- `src/components/video-editor/timeline/*` — kept as low-level primitives; `TimelineEditor.tsx` deprecated
- `src/lib/exporter/*` — accepts `AxcutDocument`
- `src/components/video-editor/projectPersistence.ts` — extended with v3 save format

**Add**:
- `src/lib/ai-edition/` (schema, document, timeline, transcript, agent, providers)
- `src/components/ai-edition/` (UI)
- `electron/ai-edition/` (services + runtime)

**Delete** (in the merge commit):
- axcut's `py/` entirely
- axcut's `apps/server/` and `apps/web/` (the implementations; the *patterns* live on in OpenScreen)

---

## 7. Verification

- **Per-PR:** `npx tsc --noEmit` clean, `npm run lint` clean (or pre-existing warnings), `npm run test` green, new tests for new code (vitest, jsdom).
- **Per-phase:** manual smoke test on Linux (CI), macOS, Windows. macOS+Windows specifically for any exporter or recorder-touching change. The native helpers stay frozen so this is a renderer + main-process job.
- **Endgame:** end-to-end script — record → transcript → "remove silences" prompt → review → export → ffprobe the output. Runs in CI via Playwright e2e on Linux. Headless on Windows/macOS is best-effort.

---

## 8. Known limitations & future work

Things we knowingly trade away in this merge, with a documented path back if they bite us.

### 8.1 Long-recording scrubbing (>30 min) — proxy MP4

**Decision:** drop proxy MP4 generation. Rely on `StreamingVideoDecoder` (WebCodecs) to seek the source on demand.

**Why we accept the tradeoff:** OpenScreen users typically record 2–15 min screen captures. `StreamingVideoDecoder` hardware-decodes those in real time with no proxy file.

**Why we know it bites:** the team has reports of scrubbing lag on long recordings (>30 min). With proxy dropped, every seek in the editor triggers a new WebCodecs keyframe search + decode ramp-up on the original file. On lower-end machines this stutters.

**Revival path (if needed):** add a per-asset "Generate proxy" button in the asset panel (Phase 1+ scope). When clicked, the main process transcodes a low-res keyframe-dense MP4 alongside the asset (`<assetId>.proxy.mp4` in `app.getPath('userData')/projects/<id>/assets/`). The exporter + VirtualPreview fall back to the proxy only when scrubbing (export still uses the original). Threshold: enable proxy generation automatically when `assetDurationMs > 30 * 60 * 1000`. See `ai-edition-collision-analysis.md §4.2` for the original decision record.

### 8.2 macOS native helper code-signing for proxy ffmpeg

Not applicable yet (no proxy). If we revive §8.1, the ffmpeg binary used for proxy transcoding needs to ship with the app and be codesigned on macOS. Plan for that alongside the revival PR.

### 8.3 Auto-caption annotation flow (removed)

OpenScreen's old `annotationsFromCaptions.ts` automatically created lower-third caption annotations from Whisper output. **Removed in this merge.** Reason: same words now live in `transcripts[]` (the transcript editor) — two writers for the same source is a collision. Users can still add overlay annotations manually via the existing annotation tools.

**Revival path:** if users ask for "captions burned into the video" as an export preset (separate from the transcript editor), add it as an export-pipeline option in a future phase. It would be a one-shot burn-in at export time, not a live annotation.

### 8.4 `EditorProjectData` v2 schema (frozen, not deleted)

The legacy v2 schema stays readable and writable throughout the merge. v2 → v3 migration happens lazily (on first AI-edition save), with a v2 backup kept next to the v3 file. Existing users with v2-only workflows keep working until Phase 10 cut-over.

---

## 9. Next step

If this plan looks right, I'll start with **Phase 0 PR** — vendor `axcut-schema`, add the v3 schema fields, write the migration from `EditorProjectData` → `AxcutDocument`, add the feature flag. One PR, ~600 LOC including tests, foundation for everything else.

The order matters: Phase 0 first, then Phase 1 in three PRs as outlined, then the rest in dependency order.