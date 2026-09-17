// Placing a bundled track on the timeline.
//
// Shared by the library's two doors — the timeline's floating panel and the inspector's
// Audio pane — because the defaults ARE the feature. A bed dropped at unity gain with no
// fades is not "the same result with extra clicks", it is a track that buries the
// narration, and a user who picks a second one gets the same surprise.
//
// Unlike the voiceover flow there is no file to create: the track already exists inside
// the install, so the only thing the main process has to hand back is a READ-APPROVED
// absolute path. The compositor opens audio by path, and `resources/` sits outside the
// recordings dir every other media read is confined to.

import { useCallback } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { MUSIC_BED_DEFAULTS, type MusicTrack } from "@/lib/music";
import { findExistingAsset } from "./findExistingAsset";

type TimelineApi = ReturnType<typeof useTimeline>;

export function useAddMusicTrack(tl: TimelineApi): (track: MusicTrack) => Promise<void> {
	const t = useScopedT("timeline");
	return useCallback(
		async (track: MusicTrack) => {
			try {
				const resolved = await window.electronAPI?.resolveMusicTrack?.(track.id);
				if (!resolved?.success || !resolved.path) {
					toast.error(t("audio.musicAddFailed"), { description: resolved?.message });
					return;
				}
				// The same bed picked twice is one asset under two tracks, as it is for a
				// voiceover take: a second import of the path would leave the probe patching
				// the wrong asset.
				const asset =
					findExistingAsset(resolved.path) ??
					(await useProjectStore.getState().addAudioAsset(resolved.path, track.title));
				if (!asset) {
					toast.error(t("audio.musicAddFailed"));
					return;
				}

				const doc = useProjectStore.getState().document;
				const total =
					doc?.timeline.clips.reduce((max, c) => Math.max(max, c.timelineEndSec), 0) ?? 0;
				const playhead = useProjectStore.getState().currentTimeSec;
				const remainingSec = Math.max(0, total - playhead);
				// Cover what is left of the programme, but never claim more of the ruler than
				// the file actually has — looping is what fills the rest, below.
				const spanSec =
					remainingSec > 0 ? Math.min(track.durationSec, remainingSec) : track.durationSec;
				// A bed sits UNDER the narration: quiet, eased in and out, and looped only when it
				// is genuinely too short for what it has to cover (looping a bed that already
				// reaches the end would change nothing). All of it lands in the SAME write as the
				// placement: one undo step, and no half-configured bed at unity gain left behind
				// if a later save failed.
				const trackId = await tl.addAudioTrack(asset.id, playhead, {
					kind: "music",
					durationSec: track.durationSec,
					spanSec,
					initial: {
						gainDb: MUSIC_BED_DEFAULTS.gainDb,
						fadeInMs: MUSIC_BED_DEFAULTS.fadeInMs,
						fadeOutMs: MUSIC_BED_DEFAULTS.fadeOutMs,
						loop: track.durationSec < remainingSec - MUSIC_BED_DEFAULTS.loopSlackSec,
					},
				});
				// Null covers a failed save too; `saveDocument` has already said why, but not
				// that the track the user picked is not on the timeline.
				if (!trackId) toast.error(t("audio.musicAddFailed"));
			} catch (err) {
				toast.error(t("audio.musicAddFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[tl, t],
	);
}
