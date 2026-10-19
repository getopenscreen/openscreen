import { useEffect, useState } from "react";
import { getPlatform } from "../utils/platformUtils";

/** A small self-view from the recorder's stream; never acquires or stops the camera. */
export function useFloatingCameraPreview(stream: MediaStream | null, enabled: boolean) {
	const supported = getPlatform() === "darwin";
	const [visible, setVisible] = useState(true);

	useEffect(() => window.electronAPI?.onCameraPreviewHidden?.(() => setVisible(false)), []);

	useEffect(() => {
		if (!supported) return;
		void window.electronAPI
			?.configureCameraPreview?.(enabled, enabled && visible && !!stream)
			.catch((error: unknown) => console.warn("Could not configure camera preview:", error));
	}, [enabled, visible, stream, supported]);

	useEffect(() => {
		if (!supported || !enabled || !visible || !stream) return;
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;
		void video.play().catch(() => undefined);
		const canvas = document.createElement("canvas");
		canvas.width = 320;
		canvas.height = 180;
		const context = canvas.getContext("2d");
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const draw = async () => {
			try {
				if (context && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
					canvas.height = Math.max(1, Math.round((320 * video.videoHeight) / video.videoWidth));
					context.drawImage(video, 0, 0, canvas.width, canvas.height);
					// Await delivery: a slow renderer must not build a queue of stale frames.
					await window.electronAPI?.sendCameraPreviewFrame?.(
						canvas.toDataURL("image/jpeg", 0.7),
						video.videoWidth / video.videoHeight,
					);
				}
			} catch (error) {
				console.warn("Could not update camera preview:", error);
			} finally {
				if (!cancelled) timer = setTimeout(() => void draw(), 100);
			}
		};
		void draw();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			video.pause();
			video.srcObject = null;
		};
	}, [enabled, visible, stream, supported]);

	useEffect(
		() => () => {
			if (supported)
				void window.electronAPI?.configureCameraPreview?.(false, false).catch(() => undefined);
		},
		[supported],
	);

	return { supported, visible, toggle: () => setVisible((value) => !value) };
}
