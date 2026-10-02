// The active clip's camera file, read for its size. Resolves the ACTIVE clip's asset
// `cameraTrack` (P4 — the camera link lives per-asset, not on the document, since a project
// can hold multiple recordings each with their own camera or none), so the element
// disappears when the playhead moves onto a clip whose asset has no camera, and reappears
// when it moves onto one that does.
//
// The native compositor draws the camera; this element never shows a pixel. What it is for
// is `loadedmetadata`: the camera's real width and height shape the PiP box the scene asks
// the compositor for (`webcamSizeCache`). It is never played, because playing it decoded the
// whole camera recording a second time, alongside the compositor, for pixels CSS hid.

import { useMemo } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { resolveActiveCameraTrack } from "@/lib/ai-edition/timeline/camera";
import { setWebcamNativeSize } from "@/native/webcamSizeCache";
import styles from "./NewEditorShell.module.css";

interface WebcamOverlayProps {
	clips: AxcutClip[];
	currentTimeSec: number;
}

export function WebcamOverlay(props: WebcamOverlayProps) {
	const assets = useProjectStore((s) => s.document?.assets ?? null);

	const cameraTrack = useMemo(
		() => resolveActiveCameraTrack(assets ?? [], props.clips, props.currentTimeSec),
		[assets, props.clips, props.currentTimeSec],
	);

	if (!cameraTrack?.sourcePath || !cameraTrack.visible) {
		return null;
	}

	return (
		<video
			key={cameraTrack.sourcePath}
			src={toFileUrl(cameraTrack.sourcePath)}
			className={styles.webcamVideo}
			muted
			playsInline
			preload="metadata"
			onLoadedMetadata={(event) => {
				const { videoWidth, videoHeight } = event.currentTarget;
				if (videoWidth > 0 && videoHeight > 0) {
					setWebcamNativeSize(cameraTrack.sourcePath, { width: videoWidth, height: videoHeight });
				}
			}}
		/>
	);
}
