import { toast } from "sonner";
import { requestCameraAccess } from "./requestCameraAccess";

/**
 * Whether the OS lists any camera at all. A Mac with no camera still grants
 * camera access, so the permission check alone lets the toggle report success
 * for a camera that can never open (#967). A failed enumeration answers `true`:
 * not knowing is not "none", and the acquire reports the real failure.
 */
async function hasCameraDevice(): Promise<boolean> {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.some((device) => device.kind === "videoinput");
	} catch {
		return true;
	}
}

/**
 * Whether the camera may be switched on, with a toast saying why not.
 *
 * The one check for every surface that turns the camera on (the HUD toggle, and the editor's
 * Record mode), so neither stores `camEnabled: true` for a camera the other refuses (#998).
 *
 * @param t The `editor` namespace translator.
 */
export async function canTurnCameraOn(t: (key: string) => string): Promise<boolean> {
	const accessResult = await requestCameraAccess();
	if (!accessResult.success) {
		toast.error(t("recording.failedCameraAccess"));
		return false;
	}

	if (!accessResult.granted) {
		toast.error(t("recording.cameraBlocked"));
		return false;
	}

	if (!(await hasCameraDevice())) {
		toast.error(t("recording.cameraNotFound"));
		// The toggles store nothing on failure, so clear an "on" left behind by a
		// camera that was unplugged while it was in use.
		void window.electronAPI?.setRecordingPrefs?.({ camEnabled: false }).catch((error) => {
			console.warn("Failed to persist the camera preference:", error);
		});
		return false;
	}

	return true;
}
