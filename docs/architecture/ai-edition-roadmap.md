# AI-Edition Merge — Roadmap (feuille de route)

**Single source of truth for the OpenScreen × Axcut merge.**
Last updated: 2026-07-01 · Branch: `feat/ai-edition`

> This file supersedes `ai-edition-handover.md` and `ai-edition-comprehensive-handover.md`
> (both deleted) and the phasing detail of `ai-edition-merge-plan.md`. For deep reference
> keep: [`ai-edition-collision-analysis.md`](ai-edition-collision-analysis.md) (decision
> rationale), [`openscreen-inventory.md`](openscreen-inventory.md) and
> [`axcut-inventory.md`](axcut-inventory.md) (source catalogs). The canonical UI target is
> [`design/openscreen-editor.html`](../../design/openscreen-editor.html) + `design/DESIGN.md`.

---

## 1. Goal & strategy

Make OpenScreen the host of the Axcut editing engine. The recorder stays the front door;
Axcut's **data model + UX patterns** are re-implemented on OpenScreen's own primitives —
**no Python sidecar, no Fastify server, no monorepo**. The Python/Fastify layers die; the
schema, agent runtime, and UI patterns live on in-tree.

Two layers, different rollout:

| Layer | What | Default? | Gate |
|---|---|---|---|
| **Editing model** | Multi-asset projects, clips + skip/zoom/speed/annotation ranges, transcript editing, virtual preview, document-driven exporter | **Default for everyone** | none |
| **AI features** | LLM providers (BYO key), agent chat, suggestions, session history, checkpoints | **Opt-in** | `AI_FEATURES_ENABLED` |

Local Whisper transcription is bundled and runs in-browser (`@xenova/transformers`) — **not**
gated, privacy-safe by construction.

## 2. Architecture (SSOT)

`AxcutDocument` (v3 Zod schema, `src/lib/ai-edition/schema/`) is the canonical project model:
`project · assets[] · transcripts[] · timeline{clips,gaps,skip/mute/speed/captionRanges} ·
annotations[] · zoomRanges[] · legacyEditor · agent · preview · export · history`. Renderer
holds it in a Zustand store (`store/projectStore.ts`); main process persists to
`userData/projects/<id>.axcut`. Legacy `.openscreen` v2 projects migrate to v3 on first open.

```
src/lib/ai-edition/       schema · document(migrate/timeline/transcribe/ids) · store · timeline · exporter
src/components/ai-edition/ NewEditorShell + Titlebar/Bottombar/LeftPanel/RightPanes/Preview/PreviewCanvas/
                          TimelinePane/VirtualPreview/TranscriptEditor/Modals/ExportDialog/ProviderSettings
electron/ai-edition/       document-service · chat-service · llm-call · llm-config-store · provider-registry
```

## 3. Locked decisions

1. **Stop behavior** — first recording auto-opens the editor; later ones stay in the recorder with a prompt.
2. **Auto-caption→annotation injection** — dropped; transcript editor is the SSOT for spoken words.
3. **React Query** — adopted for the agent layer.
4. **LLM credentials** — Electron `safeStorage` (OS keychain), not plain JSON.
5. **Whisper** — bundle a small model; picker (tiny/base/small/medium) in settings. Not an AI-feature gate.
6. **Proxy MP4** — dropped; rely on WebCodecs `StreamingVideoDecoder`. Known lag >30 min (§6 revival path).
7. **File extension** — keep `.openscreen`.
8. **Packaging** — single package, single repo, in-tree `ai-edition/` namespaces.
9. **`AI_FEATURES_ENABLED`** — gates only the LLM/agent surface; default off. Everything else ships to all.

---

## 4. Current status (2026-07-01)

Build health: **`tsc --noEmit` clean · 402 tests pass (50 files)** · lint clean bar pre-existing locale UTF-8.

| Area | State |
|---|---|
| **Phase 0** schema + v2↔v3 migration + timeline math | ✅ done, tested |
| **Phase 1** multi-asset, clips/skips, Resources panel, new editor is the **only** editor (`App.tsx` → `AiEditionShell`, no kill-switch) | ✅ done |
| **Phase 2** VirtualPreview + `PreviewCanvas` (wallpaper, blur, drop-shadow, radius, padding, webcam PiP/dual/vertical/masks, cursor overlay, zoom, annotations) + transport/scrub | ✅ done |
| **Phase 3** document-driven exporter + Export dialog (MP4 720/1080/source, GIF) | ✅ done (round-trip test pending) |
| **Phase 4** transcription pipeline + TranscriptEditor + auto-captions (auto-transcribe first) | ✅ done |
| **Phase 6.1/6.2** chat-service + IPC + LeftPanel chat + ProviderSettings (8 providers) | ✅ done |
| **Phase 7** provider registry + fetch-based LLM call (OpenAI-compat + Anthropic) | ✅ done (OAuth/PAT stubbed) |
| **Phase 8** multi-session chat history (create/list/select/rename/delete) | ✅ done in-memory (`9203c34`), tested |
| **Phase 9** i18n (`useScopedT` across components, 13 locales), undo/redo (Cmd+Z/⇧Z, works), region clipboard, EmptyState, keyboard shortcuts | ✅ largely done |

**Recently fixed on this branch:** design-token aliases (`--primary/--card/--card-foreground/--muted-foreground/--primary-foreground` were referenced but undefined → broke light theme; now mapped in `design-tokens.css`); Settings gear now opens `ShortcutsConfigDialog` (was a toast); dead `ChatPanel.tsx`/`ProjectPanel.tsx` removed; **TimelinePane rewritten to a multi-clip track model + media→timeline drag-drop fixed** (`90b4b3b` — the drop handler was on the whole workbench `<main>`, so drops only ever landed on the Preview); **`handleLoadedMetadata` clip-duration corruption fixed** (`3a4bc91` — it patched `clips[0]` unconditionally regardless of which asset's `<video>` fired the event, desyncing the progress bar from the timeline ruler/playhead whenever a second clip's asset loaded).

**Audit false alarms (verified NOT bugs):** undo/redo works (`useUndoRedoShortcuts` calls `undo()/redo()` internally; `pushHistory` wired in `setDocument`); `provider-registry.ts` exists.

---

## 5. Remaining work (prioritized)

### P0 — timeline viewport, pan, zoom, reorder (axcut port — granular plan, 2026-07-01)

**Reference sources (read in full this round):**
- **Axcut, local WSL clone** — `\\wsl.localhost\Ubuntu\home\etienne\repos\axcut\apps\web\src\components\TimelinePane.tsx` (1537 lines). **Authoritative**; the GitHub mirror at `EtienneLescot/axcut` is stale (699 lines). Always read from the WSL path until both reconcile.
- **Axcut helper:** `\\wsl.localhost\Ubuntu\home\etienne\repos\axcut\apps\web\src\lib\pointer-drag.ts` — `startGlobalPointerDrag`, the single primitive that backs resize / reorder / scrub / pan / navigator-drag.
- **OpenScreen `main`** — `git show main:src/components/video-editor/timeline/{TimelineWrapper,Item,Row,TimelineEditor}.tsx` for the dnd-timeline region model (already used here).
- **Design:** `design/openscreen-editor.html` — `.tracks-scroll` is `overflow-y: auto, overflow-x: hidden` (vertical-only). Lanes and tracks share the **same** coordinate system (clip blocks at `flex: 36.5`/`flex: 63.5`, pills at `left: 5%`/`left: 27%`/etc.). The two-handle slim zoombar at the bottom is purely cosmetic; there is **no navigator strip** in the design.

**Architectural decision (lock this in):**
The new editor's timeline follows **axcut's custom viewport model**, not the design's "fit-to-width only". A single `.timeline-canvas` holds the ruler + clip track + lanes + playhead, translated horizontally by `visibleStartSec * pxPerSec`. The viewport is `overflow: hidden`; native horizontal scroll is not used. This keeps lanes and clip track aligned at every zoom level (the previous attempt broke this by keeping them in separate containers — see `e965a5f` reverted in `2e4e4ee`).

**Granular task table:**

| # | Task | Axcut ref | Design ref | Status | Commit |
|---|------|-----------|------------|--------|--------|
| T01 | Port `startGlobalPointerDrag` helper | `lib/pointer-drag.ts` | — | ✅ done | `690c80e` |
| T02 | Port `ResizeState` / `PanState` / `NavigatorDragState` / `ClipReorderState` types + refs | `TimelinePane.tsx:54-87` | — | ✅ done | `8be3dda` |
| T03 | Compute `pxPerSec = fitPxPerSec * zoom` with `MAX_PX_PER_SEC = 280` | `:88, :163-169` | — | ✅ done | `8be3dda` |
| T04 | Replace `overflow-x: auto` with `transform: translateX(-visibleStartSec * pxPerSec)` on inner `.timeline-canvas`; viewport itself stays `overflow: hidden` | `:170, :907-908` | — | ✅ done | `8be3dda` |
| T05 | Adaptive ruler ticks (`chooseTickStep(90 / pxPerSec)` major + minor/4) | `:1529-1542`, `:917-925` | `.timeline-ruler` | ✅ done | `8be3dda` |
| T06 | Ctrl+wheel = `zoomAt(zoom * ±1.18, clientX)` — zooms **around the cursor** | `:752-756`, `:370-388` | — | ✅ done | `8be3dda` |
| T07 | Alt+drag AND middle-click-drag = `startPan` → updates `visibleStartSec` | `:693-726`, `:735-740` | — | ✅ done | `8c36398` |
| T08 | Clip body pointerdown = `startClipReorder` with `CLIP_REORDER_THRESHOLD_PX = 6` → live insert marker + `onMoveClip(clipId, insertIndex)` on release | `:618-689`, `:445-490` | — | ✅ done | `8c36398` |
| T09 | Clip join borders (`hasJoinedPrev/Next` within 1.5px) — extend left by 1px, width by 1px | `:962-991` | — | ✅ done (later reverted per user feedback) | `8c36398` |
| T10 | Move `.lanes` into the same `.timeline-canvas` as the clip track | — | `.annotation-track-row`, `.speed-track-row`, `.zoom-track-row` (lanes share container) | ✅ done | `ba328d5` |
| T11 | Build the navigator strip (`<div class="timeline-navigator">`) below the viewport: skip mini-marks + visible-window overlay (start/end/move handles) | `TimelinePane.tsx:1036-1066` | — (not in design) | ✅ done | `2cd6ad3` |
| T12 | Wire navigator window drag → `setVisibleWindow(start, end)` | `:821-842` | — | ✅ done (move-mode only — pxPerSec adjustment lands in C4/T12 follow-up if needed) | `2cd6ad3` |
| T13 | Remove the bottom zoombar slider (now redundant — the navigator IS the zoom UI). Keep the hint row only. | — | `.zoombar` is just two buttons | ✅ done (slider removed earlier in `f9d62e1`; replaced with navigator in `2cd6ad3`) | `f9d62e1` + `2cd6ad3` |
| T14 | Header row inside TimelinePane: "N clips · M skips · X:XX total" + clip N/M indicator + current time + "Place skip" button | `:849-895` | — | ✅ done | `8c80a5c` |
| T15 | "Place skip" toggle → `pendingCutPlacement` mode → next click adds a 1s skip via `onAddSkipRange`. Live `pendingCutPreviewSec` marker while armed. Esc cancels. | `:438-475, :495-518` | — | ✅ done | `8c80a5c` |
| T16 | Add `body.timeline-panning` / `body.timeline-scrubbing` / `body.timeline-placing-cut` / `body.timeline-reordering` cursor classes. Hover cursor = `pointer`, drag-state cursors per mode. | `:497-512, :654-656, :706-708, :723-725` | — | ✅ done | `6dc2358` |
| T17 | Compact skip mode: when `(endSec - startSec) * pxPerSec < 18`, render controls icon-only (no labels). | `:990-993`, `styles.css .timeline-skip-strip.compact` | — | ✅ done (no-op — skip controls are icon-only by default; documented here for tracking) | `6dc2358` |
| T18 | Skip hover-controls viewport-aware positioning (`controlsShiftPx` keeps controls onscreen near viewport edge) | `:1001-1010` | — | ✅ done | `6dc2358` |
| T10 | Move `.lanes` (annotation/speed/zoom pills) **into the same `.timeline-canvas`** as the clip track, scaled by the same `pxPerSec`, transformed by the same `translateX` | — | `.annotation-track-row`, `.speed-track-row`, `.zoom-track-row` (lanes share container) | ❌ (lanes in separate `.lanes` container, desyncs at zoom > 1×) | — |
| T11 | Build the navigator strip (`<div class="timeline-navigator">`) below the viewport: full-width row with `.timeline-navigator-skip` mini-marks at percentage positions + `.timeline-navigator-window` overlay (start/end handles + move handle) | `:1036-1066` | — (not in design) | ❌ | — |
| T12 | Wire navigator window drag → `setVisibleWindow(start, end)`; navigator handles → zoom on either side | `:821-842` | — | ❌ | — |
| T13 | Remove the bottom zoombar slider (now redundant — the navigator IS the zoom UI). Keep the hint row only. | — | `.zoombar` is just two buttons, no slider | ❌ | — |
| T14 | Header row inside TimelinePane: "N clips · M skips · X:XX total" + clip N/M indicator + current time + "Place skip" button | `:849-895` | — | ❌ | — |
| T15 | "Place skip" toggle → `pendingCutPlacement` mode → next click adds a 1s skip via `onAddSkipRange`. Live `pendingCutPreviewSec` marker while armed. Esc cancels. | `:438-475, :495-518` | — | ❌ | — |
| T16 | Add `body.timeline-panning` / `body.timeline-scrubbing` / `body.timeline-placing-cut` / `body.timeline-reordering` cursor classes. Hover cursor = `pointer`, drag-state cursors per mode. | `:497-512, :654-656, :706-708, :723-725` | — | ❌ | — |
| T17 | Compact skip mode: when `(endSec - startSec) * pxPerSec < 18`, render controls icon-only (no labels). | `:990-993`, `styles.css .timeline-skip-strip.compact` | — | ❌ | — |
| T18 | Skip hover-controls viewport-aware positioning (`controlsShiftPx` keeps controls onscreen near viewport edge) | `:1001-1010` | — | ❌ | — |
| T19 | Wire `onPreviewSource` during pointer drag so the preview scrubs to the cut/skip edge being dragged | `:540-543` | — | ❌ | — |
| T20 | Clip projection during reorder: `cursorSec` resequencing so non-dragged clips reflow when the dragged clip is held out of order | `:439-490` | — | ❌ | — |
| T21 | Wire `onDuplicateClip` parity — confirm Ctrl+C/V uses `selectedClipId` not `copiedClipId` fallback (axcut's flow) | `:480-505` | — | ⚠ (works but uses fallback path) | — |
| T22 | Design parity: `.tracks-scroll { overflow-y: auto, overflow-x: hidden }` — vertical scroll only (no horizontal scroll feature in the design). Axcut's translateX-pan replaces it. | — | `.tracks-scroll` | ❌ | — |
| T23 | Design parity: clip blocks at `flex: 36.5` (proportional), not absolute pixels — multi-clip blocks share the row | — | `.track-block.block-1 { flex: 36.5 }` | ❌ (currently absolute px) | — |
| T24 | Snap-guide line during region drag — visualizes the dnd-timeline collision-clamp | — | — | ❌ | — |
| T25 | Floating drag tooltip showing time + range during resize/move (axcut has none; design shows `0:00.0 – 0:02.5` in pill labels; visual polish on top of T01–T23) | — | `.pill-value` already shows label | ❌ | — |

**Already shipped (kept):**
- Multi-clip track + working media drag-drop → `90b4b3b`
- Skip (trim) resize + delete inside clip block → `7edfe49`
- Real Edit Clip dialog with embedded preview + draggable range → `96787e1`
- Ctrl+C/V clip duplicate → `2f53b2f`
- Region drag/resize for zoom/speed/annotation via dnd-timeline → `f70b7c4`
- Placeholder duration unification (60s) → `9837481`

**Sequencing for the spine PR (T01–T09):** T01 helper → T02 types → T03 pxPerSec → T04 viewport translateX → T05 adaptive ruler → T06 Ctrl+wheel-zoom-at-cursor → T07 Alt+drag-pan → T08 pointer-reorder → T09 join borders. Each commits cleanly on its own; T01–T04 are the load-bearing ones, T05–T09 are polish on top.

**Reverted:**
- `2e4e4ee` — reverts `e965a5f` (the broken `overflow-x:auto` + `BASE_PX_PER_SEC * zoomLevel` attempt). Lanes-back-in-canvas (T10) and navigator-strip (T11) will replace it properly.

### P1 — functional plumbing still to plug
- **Agent runtime (Phase 6.3/6.4)** — no real tool-calling agent yet. Chat calls the LLM directly (`llm-call.ts`) but the model can't apply timeline ops. Port Axcut's DeepAgentJS tool set → `electron/ai-edition/agent-runtime.ts`, expose `replace_timeline` / cut ops, save a checkpoint before/after. *Files:* `electron/ai-edition/`, `chat-service.ts`.
- **Chat persistence (Phase 8 remainder)** — sessions are in-memory (`Map`), lost on app restart. Move to `better-sqlite3` (sessions + messages + checkpoints). *Files:* `electron/ai-edition/chat-service.ts` + new `database.ts`.
- **OAuth device-flow + PAT auth (Phase 7 remainder)** — `llm-call.ts:68-78` returns "not implemented"; `ProviderSettings.tsx:372/512` shows "connect flow coming soon". Blocks Google / GitHub Copilot / ChatGPT-OAuth providers. *Files:* `llm-call.ts`, `ProviderSettings.tsx`.

### P2 — feature completeness vs old editor / design
- **Auto-zoom "wand" suggestions** — old editor generated zoom regions automatically; wand not ported. *File:* `RightPanes.tsx` (effects), new suggestion helper.
- **Region inspector advanced options** — arrow direction, figure/blur color, mosaic size, annotation font-family/animation not in inspector. *File:* `RightPanelStack.tsx`.
- **Advanced export options** — MP4 fps/codec not exposed (only quality presets). *File:* `ExportDialog.tsx`.
- **Round-trip export test** — render 3-clip + 1-skip project → ffprobe duration/frames. Needs Electron/CI harness.

### P3 — polish / fake-data displays
- **Asset file size** always "—" (`LeftPanel.tsx:41`) — `AxcutAsset` has no `sizeBytes`; add to schema + populate on import.
- **Camera-sidecar failure is silent** (`projectStore.ts:154`, `NewEditorShell.tsx:145`) — add a "camera linked / not found" toast.
- **RightPanes header Help buttons** are no-ops (`RightPanes.tsx:48-54`).
- **Pixel nits:** annotation color default `#ffffff` → `var(--annotation)` (`RightPanelStack.tsx:296`); `.transport .rec[aria-pressed]` hardcoded `#ffffff`; modal backdrop hardcoded `rgba(22,23,29,.55)` → `var(--overlay-dark)`.
- **i18n:** finish replacing any remaining hardcoded English in `ai-edition/*` with locale keys.
- **Region drag visual polish:** snap-guide line + floating time tooltip during drag/resize (visual companion to the clamp logic already in `RegionTimeline.tsx`).

### Deferred / known limitations
- **Long-recording scrub lag (>30 min)** — proxy MP4 dropped by decision 6; revival = per-asset "Generate proxy" button.
- **SSE streaming for project changes** — unnecessary in single-user Electron.

---

## 6. Verification protocol
- **Per change:** `npx tsc --noEmit` clean · `npm run test` green · new tests for new logic (vitest/jsdom).
- **Dev loop:** `npm run dev` → `http://localhost:5173/?windowType=editor` (browser shim persists to `localStorage["browser-shim-document"]`).
- **Per phase:** manual smoke on Win/mac for any exporter- or recorder-touching change (native helpers are frozen).
