import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import {
	clampVirtualTime,
	locateSourcePosition,
	locateVirtualPosition,
	totalVirtualDuration,
} from "@/lib/ai-edition/timeline/virtual-preview";
import styles from "./VirtualPreview.module.css";

export interface VideoSource {
	src: string;
	label: string;
}

interface VirtualPreviewProps {
	videoSources: VideoSource[];
	clips: AxcutClip[];
	seekTarget?: { timeSec: number; isSource?: boolean; requestId: number } | null;
	onTimeChange?: (timeSec: number) => void;
	onLoadedMetadata?: (durationSec: number) => void;
	onVideoElement?: (element: HTMLVideoElement | null) => void;
}

export function VirtualPreview({
	videoSources,
	clips,
	seekTarget,
	onTimeChange,
	onLoadedMetadata,
	onVideoElement,
}: VirtualPreviewProps) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	// ponytail: report the video element up so the parent can read videoWidth/
	// videoHeight for export sizing. Re-fires on every render — the callback
	// in the parent is stable (useState setter), so this is a no-op cost.
	if (onVideoElement) {
		onVideoElement(videoRef.current);
	}
	const isProgrammaticSeekRef = useRef(false);
	const [virtualTimeSec, setVirtualTimeSec] = useState(0);
	const [, setIsPlaying] = useState(false);
	const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [sourceIndex, setSourceIndex] = useState(0);

	const virtualDurationSec = useMemo(() => totalVirtualDuration(clips), [clips]);
	const activeSource = videoSources[sourceIndex] ?? null;

	const updateVirtualTime = useCallback(
		(nextTimeSec: number) => {
			setVirtualTimeSec(nextTimeSec);
			onTimeChange?.(nextTimeSec);
		},
		[onTimeChange],
	);

	const seekToVirtualTime = useCallback(
		(nextVirtualTimeSec: number, preservePlayback = false) => {
			const video = videoRef.current;
			const position = locateVirtualPosition(clips, nextVirtualTimeSec);
			if (!video || !position) {
				updateVirtualTime(0);
				setIsPlaying(false);
				return;
			}
			const shouldContinuePlayback = preservePlayback && !video.paused;
			isProgrammaticSeekRef.current = true;
			updateVirtualTime(position.virtualTimeSec);
			if (Math.abs(video.currentTime - position.sourceTimeSec) > 0.01) {
				video.currentTime = position.sourceTimeSec;
			}
			if (shouldContinuePlayback) {
				void video.play().catch(() => setIsPlaying(false));
			}
		},
		[clips, updateVirtualTime],
	);

	const seekToSourceTime = useCallback((sourceTimeSec: number) => {
		const video = videoRef.current;
		if (!video) return;
		isProgrammaticSeekRef.current = true;
		if (Math.abs(video.currentTime - sourceTimeSec) > 0.01) {
			video.currentTime = sourceTimeSec;
		}
	}, []);

	const handleTimeUpdate = useCallback(() => {
		const video = videoRef.current;
		if (!video || clips.length === 0) return;
		if (isProgrammaticSeekRef.current) {
			isProgrammaticSeekRef.current = false;
			const position = locateSourcePosition(clips, video.currentTime);
			if (position) {
				updateVirtualTime(clampVirtualTime(clips, position.virtualTimeSec));
			}
			return;
		}
		const position = locateSourcePosition(clips, video.currentTime);
		if (!position) {
			const nextClip = clips.find((clip) => clip.sourceStartSec > video.currentTime);
			if (nextClip) seekToVirtualTime(nextClip.timelineStartSec, true);
			return;
		}
		const currentClip = position.clip;
		const reachedClipEnd = video.currentTime >= (currentClip.sourceEndSec ?? Infinity) - 0.04;
		if (reachedClipEnd) {
			const nextClip = clips[position.clipIndex + 1];
			if (!nextClip) {
				video.pause();
				updateVirtualTime(virtualDurationSec);
				setIsPlaying(false);
				return;
			}
			seekToVirtualTime(nextClip.timelineStartSec, true);
			return;
		}
		updateVirtualTime(clampVirtualTime(clips, position.virtualTimeSec));
	}, [clips, seekToVirtualTime, updateVirtualTime, virtualDurationSec]);

	useEffect(() => {
		const video = videoRef.current;
		setIsPlaying(false);
		updateVirtualTime(0);
		setSourceIndex(0);
		setLoadState(videoSources.length > 0 ? "loading" : "idle");
		if (!video) return;
		video.pause();
		if (clips.length > 0) {
			const start = locateVirtualPosition(clips, 0);
			if (start) video.currentTime = start.sourceTimeSec;
		}
	}, [updateVirtualTime, videoSources, clips.length, clips]);

	useEffect(() => {
		if (!seekTarget) return;
		if (seekTarget.isSource) {
			seekToSourceTime(seekTarget.timeSec);
		} else {
			seekToVirtualTime(seekTarget.timeSec);
		}
	}, [seekTarget, seekToVirtualTime, seekToSourceTime]);

	return (
		<div className={styles.container}>
			{activeSource ? (
				<div className={styles.videoFrame}>
					<video
						key={activeSource.src}
						ref={videoRef}
						src={activeSource.src}
						className={styles.video}
						preload="metadata"
						playsInline
						onLoadedMetadata={(e) => {
							setLoadState("ready");
							const duration = e.currentTarget.duration;
							if (Number.isFinite(duration) && duration > 0) {
								onLoadedMetadata?.(duration);
							}
							if (clips.length > 0) seekToVirtualTime(virtualTimeSec);
						}}
						onWaiting={() => setLoadState("loading")}
						onCanPlay={() => setLoadState("ready")}
						onError={() => {
							if (sourceIndex + 1 < videoSources.length) {
								setSourceIndex((c) => c + 1);
								setLoadState("loading");
								return;
							}
							setLoadState("error");
							setIsPlaying(false);
						}}
						onPause={() => setIsPlaying(false)}
						onPlay={() => setIsPlaying(true)}
						onEnded={() => setIsPlaying(false)}
						onTimeUpdate={handleTimeUpdate}
					/>
					{loadState !== "ready" && (
						<div className={styles.overlay}>
							{loadState === "error" ? "Video preview could not be loaded." : "Loading preview…"}
						</div>
					)}
				</div>
			) : (
				<div className={styles.placeholder}>Attach a video to start previewing.</div>
			)}
		</div>
	);
}
