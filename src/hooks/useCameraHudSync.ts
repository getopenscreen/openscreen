import { useEffect } from "react";
import { useCameraDevices } from "./useCameraDevices";

/**
 * HUD camera list plus write-back into recorder prefs.
 *
 * Enumeration often finishes before persisted prefs arrive. Writing the
 * first enumerated camera back immediately would overwrite a late cam2
 * preference with cam1. Write-back waits until prefs are loaded and the
 * hook is ready, and is a no-op when the ids already match.
 */
export function useCameraHudSync(options: {
	webcamDeviceId: string | undefined;
	webcamDeviceName: string | undefined;
	recordingPrefsLoaded: boolean;
	setWebcamDeviceId: (deviceId: string | undefined) => void;
	setWebcamDeviceName: (deviceName: string | undefined) => void;
}) {
	const camera = useCameraDevices(true, options.webcamDeviceId, options.webcamDeviceName);
	const selectedCameraLabel = camera.selectedDevice?.label;
	const selectedCameraId = camera.selectedDeviceId;

	useEffect(() => {
		if (!options.recordingPrefsLoaded || !camera.isReady) return;
		if (selectedCameraId === (options.webcamDeviceId ?? "")) return;
		if (selectedCameraId) {
			options.setWebcamDeviceId(selectedCameraId);
			options.setWebcamDeviceName(selectedCameraLabel);
			return;
		}
		options.setWebcamDeviceId(undefined);
		options.setWebcamDeviceName(undefined);
	}, [
		options.recordingPrefsLoaded,
		camera.isReady,
		selectedCameraId,
		selectedCameraLabel,
		options.webcamDeviceId,
		options.setWebcamDeviceId,
		options.setWebcamDeviceName,
	]);

	return camera;
}
