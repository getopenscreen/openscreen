# SRT Import Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement this plan task by task, with spec and quality reviews.

**Goal:** Import external SRT into one asset's transcript without changing media edits.

**Architecture:** A pure parser validates every cue and builds the existing transcript shape. A focused dialog in the Transcript pane selects an asset and file, confirms replacement and commits through the existing document save/history path. Add optional SRT provenance to retain the approximate-word-timing disclosure after reload.

**Tech Stack:** TypeScript, React, Zustand, Zod, Vitest, existing i18n.

## Task 1: Parse source-time SRT

Files: create `src/lib/ai-edition/transcription/fromSrt.ts` and adjacent `fromSrt.test.ts`; extend `src/lib/ai-edition/schema/index.ts` only for additive import provenance.

- [ ] Write failing parser cases first: BOM/CRLF, multiline text, Unicode, numbered cues, hour/minute/second validation, zero/reversed duration, malformed index or arrow, empty file/cue, unsupported markup, out-of-duration timestamp, overlapping or out-of-order cues. Define supported behavior explicitly in tests; do not silently drop invalid cues.
- [ ] Run `fnm exec --using 22.22.1 npx vitest --run src/lib/ai-edition/transcription/fromSrt.test.ts` and confirm failures correspond to missing behavior.
- [ ] Implement a complete-file parser with cue and line information in typed errors. Use `transcriptFromSegments` for the document's word/segment structure; prefix fresh IDs so replacing imported text cannot accidentally inherit translations keyed to old segment IDs. Preserve SRT cue boundaries. Reject unsafe markup or convert supported formatting to plain text explicitly; React renders text, never HTML.
- [ ] Mark imported transcript provenance and disclose estimated word timing. Use `withTranscript` for both the per-asset array and primary mirror. Clear only stale caption translations for the replaced asset where IDs would otherwise carry them; retain unrelated assets/edits.
- [ ] Verify parse and document operations, including JSON/schema round-trip and unchanged timeline/audio assets.

## Task 2: Import dialog and save

Files: create `src/components/ai-edition/ImportSrtDialog.tsx` and adjacent component tests; modify `RightPanes.tsx` and the smallest existing store/shell integration required.

- [ ] Write failing user scenarios for selecting a specific recording/voiceover asset, cancel, replacement confirmation, invalid file preserving old transcript, busy target disabled, save failure and successful import.
- [ ] Offer Import SRT in both empty and populated Transcript pane states. Use the existing dialog primitives and a native HTML `.srt` file input; no new broad filesystem IPC is needed for a user-selected text file.
- [ ] Select an eligible asset explicitly; default only if there is exactly one. Explain source timestamps and estimated word timing. Do not prevent silent-media subtitle imports merely because automatic transcription cannot run.
- [ ] Before writing, re-read the current project/document and busy state. If the project switched, the asset vanished, or its transcript changed during file reading/confirmation, refuse stale replacement or require renewed confirmation. Save with `{ history: true }` once. Clear pending local state on close; do not overwrite edits made while the dialog was open.
- [ ] Verify undo/redo and persistence through the existing store/bridge test pattern, not just an invoked mock callback.

## Task 3: Caption/timeline integration and translations

Files: existing caption cue/timeline tests; `src/i18n/locales/*/settings.json`.

- [ ] Test imported text appears on the target's clips only, including repeated clips and source trims/speed mapping. Pin imported cue boundaries so nearby SRT cues are not silently merged by the automatic caption grouping path.
- [ ] Add translated strings in all 15 locales, including replacement warning, timestamp semantics, approximate timing, validation failures and accessible field labels.
- [ ] Run targeted suites, both TypeScript configs, `npm run lint`, `npm run i18n:check` and `npm run docs:check`. Run the full unit suite once at completion.
- [ ] Inspect the running UI if supported. Record exactly what runtime verification was possible; unavailable native desktop tools are an explicit verification gap, not a pass.

## Acceptance

Only the selected asset's transcript is replaced, after complete validation and confirmation. Source timing, caption mapping, history and saved documents remain consistent. No engine invocation, timeline rewrite, invented measured word alignment, unrelated abstraction or dependency addition.
