// The bundled CC0 music library, renderer side.
//
// The catalogue itself comes over IPC (`electron/music/catalogue.ts`), because the main
// process is where a track id turns into a read-approved absolute path. What lives here
// is the shape, the defaults a music bed wants, and the asset URL used to audition one.

import { getAssetPath } from "@/lib/assetPath";

export type MusicTrack = {
	id: string;
	file: string;
	title: string;
	author: string;
	durationSec: number;
	mood: string[];
	license: string;
	licenseUrl: string;
	sourceUrl: string;
};

/**
 * Where "More music" goes: OpenGameArt's advanced search, pre-filtered to Art Type
 * "Music" and licence "CC0" — the exact query the bundled catalogue was sourced from.
 *
 * Pre-filtered is the whole point. Sending people to a "free music" site's front page
 * hands them a catalogue where several licences look alike and are not: some forbid
 * redistributing the file, some want credit in the user's video. This URL narrows that
 * to the one family that asks nothing.
 *
 * It is still a third-party page and it does not print the licence on the results list,
 * only on each item's page — so the docs page (website/docs/music.md, linked from the
 * notices and the sidebar) remains where the caveats live: verify per track, and know
 * that Content ID matches fingerprints rather than licences.
 */
export const MORE_MUSIC_URL =
	"https://opengameart.org/art-search-advanced?field_art_type_tid%5B%5D=12&field_art_licenses_tid%5B%5D=4";

/** A bed sits UNDER narration: quiet by default, eased in and out, and looped when it is
 *  shorter than the programme it has to cover. These are the values the library applies
 *  on import; the inspector can change every one of them afterwards. */
export const MUSIC_BED_DEFAULTS = {
	gainDb: -18,
	fadeInMs: 500,
	fadeOutMs: 500,
} as const;

/** The file:// (packaged) or /music/… (dev) URL that plays a catalogue track in an
 *  `<audio>` element. Auditioning never needs the main process: this is a renderer-side
 *  read of a bundled asset, exactly like a wallpaper thumbnail. */
export function musicAssetUrl(track: Pick<MusicTrack, "file">): string {
	return getAssetPath(`music/${track.file}`);
}

/** "2:31" — durations are the one number that tells a user whether a bed will cover their
 *  recording without looping. */
export function formatTrackDuration(durationSec: number): string {
	const total = Math.max(0, Math.round(durationSec));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
