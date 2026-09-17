// The bundled CC0 music catalogue, as the main process sees it.
//
// The renderer could read the manifest on its own, but the NATIVE compositor opens every
// audio track by absolute filesystem path (`SceneAudioTrack.path`), and the bundled files
// live under `resourcesPath` — outside the recordings dir that every other media read is
// confined to. So resolution happens here, where the read allow-list lives, and the
// renderer only ever receives a path that has already been approved.
//
// Metadata and path resolution are deliberately two calls: listing the library must not
// approve reads for tracks the user never picks.

import fs from "node:fs/promises";
import path from "node:path";
import { assetBaseDir } from "../assetBaseDir";

/** What the renderer needs to draw the library. Provenance fields (digest, archived
 *  licence snapshot) stay out: they exist to be audited in the repo and in
 *  THIRD-PARTY-NOTICES.md, not to be rendered. */
export type MusicCatalogueTrack = {
	id: string;
	/** Bare filename under the catalogue dir. The renderer turns it into an asset URL to
	 *  audition the track — the same trick the wallpaper picker uses — which needs no path
	 *  approval because it never leaves the renderer. */
	file: string;
	title: string;
	author: string;
	durationSec: number;
	mood: string[];
	license: string;
	licenseUrl: string;
	sourceUrl: string;
};

type ManifestTrack = MusicCatalogueTrack;

export function musicDir(): string {
	return path.join(assetBaseDir(), "music");
}

let cache: ManifestTrack[] | null = null;

/** Parsed defensively: a malformed manifest must degrade to an empty library rather
 *  than take the editor down. `npm run music:check` is what actually enforces the
 *  shape, in CI, before anything ships. */
async function readManifest(): Promise<ManifestTrack[]> {
	if (cache) return cache;
	try {
		const raw = await fs.readFile(path.join(musicDir(), "catalogue.json"), "utf-8");
		const parsed = JSON.parse(raw) as { tracks?: unknown };
		const tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
		cache = tracks.filter((track): track is ManifestTrack => {
			const t = track as Partial<ManifestTrack>;
			return (
				typeof t?.id === "string" && typeof t?.file === "string" && typeof t?.title === "string"
			);
		});
	} catch (error) {
		console.warn("[music] catalogue unavailable:", error);
		cache = [];
	}
	return cache;
}

export async function listMusicCatalogue(): Promise<MusicCatalogueTrack[]> {
	return readManifest();
}

/**
 * The absolute path of one bundled track, or null.
 *
 * Confined to the catalogue directory on purpose: `id` arrives from the renderer, and
 * resolving it to a path that escaped `musicDir()` would turn the library into an
 * arbitrary-file approver.
 */
export async function resolveMusicTrackPath(id: string): Promise<string | null> {
	const track = (await readManifest()).find((candidate) => candidate.id === id);
	if (!track) return null;
	const dir = musicDir();
	const resolved = path.resolve(dir, track.file);
	if (path.dirname(resolved) !== path.resolve(dir)) return null;
	try {
		const stats = await fs.stat(resolved);
		if (!stats.isFile()) return null;
	} catch {
		return null;
	}
	return resolved;
}

/**
 * Repoint a stored path at the copy of the same bundled track in THIS install.
 *
 * A catalogue track is the one asset whose replacement needs no guessing. Every other
 * missing file sends the relinker to the media-links registry to match by size, because
 * one `recording.mp4` looks like any other; a bundled track is identified by the manifest
 * the install ships with, so the answer is computed rather than inferred.
 *
 * It matters because the stored path is an INSTALL path. Move the app, open the project on
 * another machine, or switch between a dev run and a packaged one, and the bed goes silent
 * with nothing on screen explaining why.
 *
 * Deliberately narrow: the stored path must sit directly in a `music/` directory and name a
 * file the manifest knows. A bare basename match would relink any file that happened to
 * share a name with a track.
 *
 * The stored path is parsed with `path.win32`, never the host's `path`, because it was
 * written by whichever machine authored the project. The posix parser treats a backslash
 * as an ordinary filename character, so a project saved on Windows
 * (`C:\...\resources\music\x.ogg`) would read as one long filename on macOS or Linux and
 * never relink. The win32 parser splits on both separators, so it reads a posix path just
 * as well. That cannot widen what resolves: the last segment must still equal a manifest
 * `file` exactly, and `resolveMusicTrackPath` confines the result to the catalogue dir.
 */
export async function resolveBundledMusicPath(storedPath: string): Promise<string | null> {
	if (path.win32.basename(path.win32.dirname(storedPath)) !== "music") return null;
	const file = path.win32.basename(storedPath);
	const track = (await readManifest()).find((candidate) => candidate.file === file);
	return track ? resolveMusicTrackPath(track.id) : null;
}
