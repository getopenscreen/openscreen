# Bundled music

OpenScreen ships six background-music tracks inside its installers. This page is the
contract for how they get there, why the licence is narrower than it looks, and what
breaks if that narrowness is relaxed.

The *feature* is almost nothing: music tracks already existed end to end (schema, timeline
lane, inspector, preview, native mix — see [document-model.md](../architecture/document-model.md)
and `crates/compositor/src/audio.rs`). The library adds a catalogue, a resolver, a picker
and a guard. Nothing in the export path changed.

**One surface, two doors.** The library is a SECTION of the inspector's audio facet
(`AudioPane`), not a facet or a panel of its own — the same fold-back that put the
background under effects and the caption settings under the transcript, and for the same
reason: a second audio icon in the rail is a second entry point to one concern. The
timeline toolbar's "Music library" entry therefore selects that facet
(`setFacet("audio")`) rather than opening anything, exactly as `handleTranscribe` reveals
the transcript facet. `MusicLibraryList` holds the list so a future second door cannot
drift from this one, and `useAddMusicTrack` holds the placement defaults, which ARE the
feature: a bed dropped at unity gain with no fades buries the narration.

## Why CC0 and only CC0

Bundling redistributes the file. That single fact rules out most of what the web calls
royalty-free:

| Licence family | Use in a video | Redistribute in an installer | Verdict |
|---|---|---|---|
| CC0 1.0 | yes | yes | **the only one we bundle** |
| Pixabay / Mixkit / Bensound / Uppbeat | yes | **no** — standalone redistribution is forbidden | excluded |
| CC-BY, CC-BY-SA | yes, with credit | yes | excluded: the obligation follows the *user's* video |
| CC-BY-NC | non-commercial only | yes | excluded |
| Public domain by expiry | depends | depends | excluded: the *recording* carries its own right, and terms vary by country |

The last row is the one that catches people. A pre-1931 composition being public domain
says nothing about the 2019 recording of it. We accept an explicit CC0 dedication *of the
recording*, never a chain of reasoning about expiry.

## The manifest is the evidence

`public/music/catalogue.json` holds one entry per track. Two fields are load-bearing:

- **`licenseSnapshotUrl`** — a web-archive capture of the page stating the licence. The
  live page is not evidence; it can be edited or deleted, and the claim has to survive the
  site it came from.
- **`sha256`** — matched against the file on disk. Tracks are bundled **byte-for-byte as
  published upstream**, never re-encoded, so the digest also ties our copy to the source
  file. Re-encoding to save a megabyte would sever that link, which is why the files ship
  as `.ogg` and `.mp3` rather than a uniform Opus.

`scripts/check-music-licences.mjs` (`npm run music:check`, plus its own CI job) enforces
all of it: allow-list, canonical deed URL, archive host, digest, no stray files, and an
entry in `THIRD-PARTY-NOTICES.md` for every track. It is the audio counterpart of the
`assertLgpl` guard in `scripts/fetch-ffmpeg.mjs` — a build that cannot prove its licensing
does not ship. `--update-digests` refills `sha256`/`bytes` after a file changes.

`THIRD-PARTY-NOTICES.md` carries the per-track credits even though CC0 requires none,
because `"!*.md"` in `electron-builder.json5` strips every README from the package: that
file is the only provenance document a user receives.

## Packaging and path resolution

`public/music` ships through `extraResources` (→ `resources/music/`), **not** through
`dist`, for the same reason as `public/mediapipe`: the native compositor opens every audio
track by absolute filesystem path (`SceneAudioTrack.path`), and a path inside `app.asar` is
not one.

Vite copies all of `public/` into `dist/` regardless, so `files` excludes `dist/music`;
without that the audio ships twice, the asar copy never read. Nothing loads `/music/...` out
of `dist/`: a packaged renderer is a `file://` load and `getAssetPath` resolves to
`resources/`, and in dev the Vite server serves `public/` itself.

Two IPC handlers, deliberately separate:

- `music:list` → `listMusicCatalogue()`. Metadata only. Listing the library must not grant
  read approval for tracks the user never picks.
- `music:resolve` → `resolveMusicTrackPath(id)`, then the same `approveReadableAudioPath`
  the file picker uses. The id is confined to the catalogue directory, so it cannot be
  walked into an arbitrary-file approver.

The renderer auditions a track from `getAssetPath("music/<file>")` — a plain renderer-side
asset read, like a wallpaper thumbnail, needing no approval at all.

## Why a stale path relinks by computation

`addAsset` stores `originalPath` and does not copy media, so a project that uses a bundled
track records an **install** path. Move the app, open the project on another machine, or
cross between a dev run and a packaged one, and the bed goes silent.

`resolveBundledMusicPath` (called first in `electron/media/projectMediaRelinker.ts`) fixes
that without the registry's size-fingerprint guesswork: the file ships with the app, so the
local answer is computed from the manifest rather than inferred. It is narrow on purpose —
the stored path must sit directly in a `music/` directory and name a file the manifest
knows, because a bare basename match would relink anything that shared a name.

## Content ID

Worth knowing, and stated in the user docs and the notices file: Content ID matches audio
fingerprints, not licences, so a public-domain track can still draw an automated claim.
That is a user-experience problem, not a licensing one, and the dedication is the ground to
dispute it on. Prefer tracks unlikely to already sit in those databases.

## Adding a track

See the checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md). Short version: file
unmodified under `public/music/`, complete manifest entry including the archive capture, a
line in `THIRD-PARTY-NOTICES.md`, then `--update-digests` and `npm run music:check`.
