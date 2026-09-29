import { useEffect, useRef, useState } from "react";
import { webcamVideoConstraints } from "./webcamCaptureTarget";

export interface CameraPreviewStreamOptions {
	enabled: boolean;
	deviceId?: string;
}

/**
 * Opens a live getUserMedia video stream for a webcam preview — separate
 * from the recorder's own capture stream (useScreenRecorder keeps that in a
 * private ref), so this is safe to mount anywhere that just wants to *show*
 * the camera is working, not record it.
 */
export function useCameraPreviewStream({ enabled, deviceId }: CameraPreviewStreamOptions) {
	const [stream, setStream] = useState<MediaStream | null>(null);
	const [error, setError] = useState<string | null>(null);
	const streamRef = useRef<MediaStream | null>(null);

	useEffect(() => {
		if (!enabled) {
			streamRef.current?.getTracks().forEach((track) => track.stop());
			streamRef.current = null;
			setStream(null);
			setError(null);
			return;
		}

		let cancelled = false;
		navigator.mediaDevices
			.getUserMedia({
				// Pinned to the smallest preset, not to whatever the recording is set
				// to. Left unconstrained this opened at 640x480 and made the camera
				// look as soft in the HUD as it did in the take; driving it at the
				// user's 4K choice would be the opposite mistake, since this renders
				// into a thumbnail a couple of hundred pixels wide and the recorder
				// opens its own stream anyway.
				video: webcamVideoConstraints(deviceId, "1080p"),
				audio: false,
			})
			.then((s) => {
				if (cancelled) {
					s.getTracks().forEach((track) => track.stop());
					return;
				}
				streamRef.current = s;
				setStream(s);
				setError(null);
			})
			.catch((err) => {
				if (cancelled) return;
				setStream(null);
				setError(err instanceof Error ? err.message : String(err));
			});

		return () => {
			cancelled = true;
			streamRef.current?.getTracks().forEach((track) => track.stop());
			streamRef.current = null;
		};
	}, [enabled, deviceId]);

	return { stream, error };
}
