import { Pause, Play } from "lucide-react";
import { memo } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { formatSec } from "@/lib/ai-edition/timeline/format";
import styles from "./NewEditorShell.module.css";

interface TransportBarProps {
	playing: boolean;
	/** Live scrub position while a timeline drag is in flight; null = follow the store. */
	overrideTimeSec: number | null;
	clips: AxcutClip[];
	onTogglePlay: () => void;
}

// ponytail: lives in the timeline header now (not under the preview canvas)
// so the header row covers both timeline tools and playback in one line.
// No seek bar of its own: the ruler right below seeks, and ←/→ step a frame.
export const TransportBar = memo(function TransportBar({
	playing,
	overrideTimeSec,
	clips,
	onTogglePlay,
}: TransportBarProps) {
	const te = useScopedT("editor");
	// Same reason as PlayheadOverlay (see V4Timeline.tsx): the timecode is animated
	// during playback, so it subscribes to the playhead directly instead of forcing
	// V4Timeline — and the whole editor shell above it — to re-render once per frame
	// to hand it down as a prop.
	const storeTimeSec = useProjectStore((s) => s.currentTimeSec);
	const currentTimeSec = overrideTimeSec ?? storeTimeSec;
	const virtualDurationSec = clips.reduce(
		(acc, c) => acc + (c.timelineEndSec - c.timelineStartSec),
		0,
	);

	return (
		<div className={styles.transport} role="toolbar" aria-label={te("transport.playbackControls")}>
			<button
				type="button"
				className={`${styles.tbtn} ${styles.play}`}
				title={te("transport.playPauseTitle")}
				aria-label={te("transport.playPause")}
				data-playing={playing}
				onClick={onTogglePlay}
			>
				{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
			</button>
			<span className={styles.time}>
				<span>{formatSec(currentTimeSec)}</span>
				<span className={styles.sep}>/</span>
				<span className={styles.total}>{formatSec(virtualDurationSec)}</span>
			</span>
		</div>
	);
});
