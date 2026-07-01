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

**Recently fixed on this branch:** design-token aliases (`--primary/--card/--card-foreground/--muted-foreground/--primary-foreground` were referenced but undefined → broke light theme; now mapped in `design-tokens.css`); Settings gear now opens `ShortcutsConfigDialog` (was a toast); dead `ChatPanel.tsx`/`ProjectPanel.tsx` removed.

**Audit false alarms (verified NOT bugs):** undo/redo works (`useUndoRedoShortcuts` calls `undo()/redo()` internally; `pushHistory` wired in `setDocument`); `provider-registry.ts` exists.

---

## 5. Remaining work (prioritized)

### P1 — functional plumbing still to plug
- **Agent runtime (Phase 6.3/6.4)** — no real tool-calling agent yet. Chat calls the LLM directly (`llm-call.ts`) but the model can't apply timeline ops. Port Axcut's DeepAgentJS tool set → `electron/ai-edition/agent-runtime.ts`, expose `replace_timeline` / cut ops, save a checkpoint before/after. *Files:* `electron/ai-edition/`, `chat-service.ts`.
- **Chat persistence (Phase 8 remainder)** — sessions are in-memory (`Map`), lost on app restart. Move to `better-sqlite3` (sessions + messages + checkpoints). *Files:* `electron/ai-edition/chat-service.ts` + new `database.ts`.
- **OAuth device-flow + PAT auth (Phase 7 remainder)** — `llm-call.ts:68-78` returns "not implemented"; `ProviderSettings.tsx:372/512` shows "connect flow coming soon". Blocks Google / GitHub Copilot / ChatGPT-OAuth providers. *Files:* `llm-call.ts`, `ProviderSettings.tsx`.

### P2 — feature completeness vs old editor / design
- **Auto-zoom "wand" suggestions** — old editor generated zoom regions automatically; wand not ported. *File:* `RightPanes.tsx` (effects), new suggestion helper.
- **Region inspector advanced options** — arrow direction, figure/blur color, mosaic size, annotation font-family/animation not in inspector. *File:* `RightPanelStack.tsx`.
- **Edit Clip modal** — `useTimeline.editClip` exists (added `9203c34`) but no modal drives it; TimelinePane pencil handle → modal for `sourceStart/EndSec`. *Files:* `Modals.tsx`, `TimelinePane.tsx`.
- **Advanced export options** — MP4 fps/codec not exposed (only quality presets). *File:* `ExportDialog.tsx`.
- **Round-trip export test** — render 3-clip + 1-skip project → ffprobe duration/frames. Needs Electron/CI harness.

### P3 — polish / fake-data displays
- **Asset file size** always "—" (`LeftPanel.tsx:41`) — `AxcutAsset` has no `sizeBytes`; add to schema + populate on import.
- **Camera-sidecar failure is silent** (`projectStore.ts:154`, `NewEditorShell.tsx:145`) — add a "camera linked / not found" toast.
- **RightPanes header Help buttons** are no-ops (`RightPanes.tsx:48-54`).
- **Pixel nits:** annotation color default `#ffffff` → `var(--annotation)` (`RightPanelStack.tsx:296`); `.transport .rec[aria-pressed]` hardcoded `#ffffff`; modal backdrop hardcoded `rgba(22,23,29,.55)` → `var(--overlay-dark)`.
- **i18n:** finish replacing any remaining hardcoded English in `ai-edition/*` with locale keys.

### Deferred / known limitations
- **Long-recording scrub lag (>30 min)** — proxy MP4 dropped by decision 6; revival = per-asset "Generate proxy" button.
- **SSE streaming for project changes** — unnecessary in single-user Electron.

---

## 6. Verification protocol
- **Per change:** `npx tsc --noEmit` clean · `npm run test` green · new tests for new logic (vitest/jsdom).
- **Dev loop:** `npm run dev` → `http://localhost:5173/?windowType=editor` (browser shim persists to `localStorage["browser-shim-document"]`).
- **Per phase:** manual smoke on Win/mac for any exporter- or recorder-touching change (native helpers are frozen).
