// The bundled CC0 library, as a list.
//
// Its own component because the library has two doors — the timeline's audio menu opens
// it as a floating bar, the inspector shows it as a section of the Audio pane — and two
// copies of a list is how the two drift apart. The chrome differs; the list does not.
//
// The licence line rides with the list rather than with either wrapper, for the same
// reason: "do I owe anyone a credit?" is the only question a user has about bundled
// music, and the answer must not depend on which door they came through.

import { ExternalLink, Loader2, Music, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { formatTrackDuration, MORE_MUSIC_URL, type MusicTrack, musicAssetUrl } from "@/lib/music";
import styles from "./EditorShellV4.module.css";

/** The catalogue, or null while it is still coming over IPC. An empty array is a real
 *  answer (no bundled tracks), not a loading state.
 *
 *  Not exported: a module that exports both a hook and a component loses React Fast
 *  Refresh for the whole file, and nothing outside needs it. */
function useMusicCatalogue(enabled: boolean): MusicTrack[] | null {
	const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		void (async () => {
			const result = await window.electronAPI?.listMusicCatalogue?.();
			if (!cancelled) setTracks(result?.success ? result.tracks : []);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled]);
	return tracks;
}

export function MusicLibraryList({
	active,
	onPick,
}: {
	/** False while the surface holding the list is hidden — nothing is fetched, and any
	 *  audition in progress is stopped. A bed left playing under a closed panel, with
	 *  nothing on screen to stop it, is its own bug. */
	active: boolean;
	onPick: (track: MusicTrack) => void;
}) {
	const t = useScopedT("timeline");
	const tracks = useMusicCatalogue(active);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	const stopPreview = useCallback(() => {
		audioRef.current?.pause();
		audioRef.current = null;
		setPreviewId(null);
	}, []);

	useEffect(() => {
		if (!active) stopPreview();
	}, [active, stopPreview]);

	useEffect(() => stopPreview, [stopPreview]);

	const togglePreview = useCallback(
		(track: MusicTrack) => {
			if (previewId === track.id) {
				stopPreview();
				return;
			}
			stopPreview();
			const audio = new Audio(musicAssetUrl(track));
			audio.volume = 0.7;
			audio.addEventListener("ended", () => setPreviewId(null));
			void audio.play().catch(() => setPreviewId(null));
			audioRef.current = audio;
			setPreviewId(track.id);
		},
		[previewId, stopPreview],
	);

	return (
		<>
			{tracks === null ? (
				<div className={styles.musicEmpty}>
					<Loader2 size={14} className="animate-spin" />
					{t("audio.musicLoading")}
				</div>
			) : tracks.length === 0 ? (
				<div className={styles.musicEmpty}>{t("audio.musicEmpty")}</div>
			) : (
				<ul className={styles.musicList}>
					{tracks.map((track) => (
						<li key={track.id}>
							<div className={styles.musicRow}>
								<button
									type="button"
									className={styles.musicPreviewBtn}
									onClick={() => togglePreview(track)}
									aria-label={
										previewId === track.id ? t("audio.musicStopPreview") : t("audio.musicPreview")
									}
								>
									{previewId === track.id ? <Pause size={13} /> : <Play size={13} />}
								</button>
								<span className={styles.musicRowMain}>
									<span className={styles.musicRowTitle}>{track.title}</span>
									<span className={styles.musicRowMeta}>
										{track.author} · {formatTrackDuration(track.durationSec)} ·{" "}
										{track.mood.join(", ")}
									</span>
								</span>
								<button
									type="button"
									className={styles.musicAddBtn}
									onClick={() => {
										stopPreview();
										onPick(track);
									}}
								>
									<Music size={13} />
									{t("audio.musicAdd")}
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			<div className={styles.musicFoot}>
				<span className={styles.musicBadge}>{t("audio.musicLicenceNote")}</span>
				<button
					type="button"
					className={styles.voiceoverBarBtn}
					onClick={() => void window.electronAPI?.openExternalUrl?.(MORE_MUSIC_URL)}
				>
					<ExternalLink size={13} />
					{t("audio.moreMusic")}
				</button>
			</div>
		</>
	);
}
