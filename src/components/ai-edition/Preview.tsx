import { Maximize2, Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useState } from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import styles from "./NewEditorShell.module.css";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

interface PreviewProps {
	hasProject: boolean;
	hasAsset: boolean;
	videoSources: VideoSource[];
	clips: AxcutClip[];
	seekTarget: { timeSec: number; requestId: number } | null;
	onTimeChange: (sec: number) => void;
	onSeek: (sec: number) => void;
	onLoadedMetadata: (sec: number) => void;
	onVideoElement: (el: HTMLVideoElement | null) => void;
	currentTimeSec: number;
}

function formatTC(sec: number): string {
	if (!sec || !Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

export function Preview({
	hasProject,
	hasAsset,
	videoSources,
	clips,
	seekTarget,
	onTimeChange,
	onSeek,
	onLoadedMetadata,
	onVideoElement,
	currentTimeSec,
}: PreviewProps) {
	const [playing, setPlaying] = useState(false);
	const [loop, setLoop] = useState(false);
	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

	const handleVideoElement = useCallback(
		(el: HTMLVideoElement | null) => {
			setVideoEl(el);
			onVideoElement(el);
		},
		[onVideoElement],
	);

	const togglePlay = useCallback(() => {
		if (!videoEl) return;
		if (videoEl.paused) {
			void videoEl.play();
			setPlaying(true);
		} else {
			videoEl.pause();
			setPlaying(false);
		}
	}, [videoEl]);

	const handlePrevClip = useCallback(() => {
		if (!videoEl || clips.length === 0) return;
		const now = videoEl.currentTime;
		let prevEnd = 0;
		for (let i = clips.length - 1; i >= 0; i--) {
			const c = clips[i];
			if (c.timelineEndSec <= now - 0.1) {
				prevEnd = c.timelineStartSec;
				break;
			}
		}
		videoEl.currentTime = prevEnd;
		onTimeChange(prevEnd);
	}, [videoEl, clips, onTimeChange]);

	const handleNextClip = useCallback(() => {
		if (!videoEl || clips.length === 0) return;
		const now = videoEl.currentTime;
		for (const c of clips) {
			if (c.timelineStartSec > now + 0.1) {
				videoEl.currentTime = c.timelineStartSec;
				onTimeChange(c.timelineStartSec);
				return;
			}
		}
	}, [videoEl, clips, onTimeChange]);

	const handleLoop = useCallback(() => {
		setLoop((v) => {
			const next = !v;
			if (videoEl) videoEl.loop = next;
			return next;
		});
	}, [videoEl]);

	const restart = useCallback(() => {
		if (!videoEl) return;
		videoEl.currentTime = 0;
		onTimeChange(0);
	}, [videoEl, onTimeChange]);
	void restart;

	const expand = useCallback(() => {
		const el = videoEl?.parentElement;
		if (!el) return;
		if (document.fullscreenElement) {
			void document.exitFullscreen();
		} else {
			void el.requestFullscreen?.();
		}
	}, [videoEl]);

	const rec = useCallback(() => {
		// ponytail: REC button toggles play (placeholder until the recorder is wired)
		togglePlay();
	}, [togglePlay]);

	return (
		<section className={styles.previewWrap} aria-label="Video preview">
			<div className={styles.previewCanvas}>
				{hasProject && hasAsset ? (
					<>
						<div className={styles.previewFrame}>
							<VirtualPreview
								videoSources={videoSources}
								clips={clips}
								seekTarget={seekTarget}
								onTimeChange={onTimeChange}
								onLoadedMetadata={onLoadedMetadata}
								onVideoElement={handleVideoElement}
							/>
							<span className={styles.previewTimecode}>{formatTC(currentTimeSec)}</span>
							<span className={styles.previewBadge}>1920 × 1080 · 60 fps</span>
							<div className={styles.previewPip} aria-label="Webcam">
								<span style={{ font: "500 9px/1 var(--font-mono)", letterSpacing: "0.06em" }}>
									Webcam
								</span>
							</div>
						</div>
					</>
				) : hasProject ? (
					<div className={styles.previewEmpty}>
						<strong>Add a video to get started</strong>
						<p>Use the Media panel on the left to import one.</p>
					</div>
				) : (
					<div className={styles.previewEmpty}>
						<strong>No project open</strong>
						<p>Open or create a project from the title bar to start editing.</p>
					</div>
				)}
			</div>
			<div className={styles.transport} role="toolbar" aria-label="Playback controls">
				<button
					type="button"
					className={`${styles.tbtn} ${styles.play}`}
					title="Play / Pause (Space)"
					aria-label="Play / Pause"
					data-playing={playing}
					onClick={togglePlay}
				>
					{playing ? (
						<Pause size={14} fill="currentColor" />
					) : (
						<Play size={14} fill="currentColor" />
					)}
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Previous clip"
					aria-label="Previous clip"
					onClick={handlePrevClip}
				>
					<SkipBack size={14} />
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Next clip"
					aria-label="Next clip"
					onClick={handleNextClip}
				>
					<SkipForward size={14} />
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Loop"
					aria-label="Loop"
					aria-pressed={loop}
					onClick={handleLoop}
				>
					<Repeat size={14} />
				</button>
				<button
					type="button"
					className={styles.tbtn}
					title="Fullscreen"
					aria-label="Fullscreen"
					onClick={expand}
				>
					<Maximize2 size={14} />
				</button>
				{(() => {
					const virtualDurationSec = clips.reduce(
						(acc, c) => acc + (c.timelineEndSec - c.timelineStartSec),
						0,
					);
					const progress = virtualDurationSec ? (currentTimeSec / virtualDurationSec) * 100 : 0;
					return (
						<>
							<span className={styles.time}>
								<span>{formatTC(currentTimeSec)}</span>
								<span className={styles.sep}>/</span>
								<span className={styles.total}>{formatTC(virtualDurationSec)}</span>
							</span>
							<div className={styles.scrubBar}>
								<div className={styles.scrubTrack}>
									<div className={styles.scrubProgress} style={{ width: `${progress}%` }} />
								</div>
								<input
									type="range"
									min={0}
									max={virtualDurationSec || 1}
									step={0.01}
									value={Math.min(currentTimeSec, virtualDurationSec || 1)}
									onChange={(e) => {
										onSeek(Number(e.target.value));
									}}
									className={styles.scrubInput}
									aria-label="Seek video"
								/>
								<div
									className={styles.scrubThumb}
									style={{
										left: `${progress}%`,
									}}
								/>
							</div>
						</>
					);
				})()}
				<span className={styles.spacer} />
				<button
					type="button"
					className={styles.tbtn}
					title="Record"
					aria-label="Record"
					aria-pressed={playing}
					style={{
						border: "1px solid var(--border)",
						color: playing ? "#fff" : "var(--muted)",
						background: playing ? "var(--danger)" : "transparent",
						padding: "0 10px",
						width: "auto",
						gap: 6,
						font: "500 11px/1 var(--font-mono)",
						letterSpacing: "0.02em",
					}}
					onClick={rec}
				>
					<span
						style={{
							width: 7,
							height: 7,
							borderRadius: "50%",
							background: playing ? "#fff" : "var(--danger)",
						}}
					/>
					{playing ? "STOP" : "REC"}
				</button>
			</div>
		</section>
	);
}
