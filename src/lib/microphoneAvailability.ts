import { toast } from "sonner";

/**
 * Whether the OS lists any audio input. A Mac with no microphone still records a take
 * that asks for one, then fails the next take in the same picker session (#995). A failed
 * enumeration answers `true`: not knowing is not "none".
 */
async function hasMicrophoneDevice(): Promise<boolean> {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.some((device) => device.kind === "audioinput");
	} catch {
		return true;
	}
}

/** The toggles store nothing on failure, so this clears an "on" left by an input now gone. */
function forgetMicrophone() {
	void window.electronAPI?.setRecordingPrefs?.({ micEnabled: false }).catch((error) => {
		console.warn("Failed to persist the microphone preference:", error);
	});
}

let pendingCheck: Promise<boolean> | null = null;

/**
 * Whether the microphone may be switched on, with a toast saying why not: the camera's
 * `canTurnCameraOn`, for the HUD toggle and the editor's Record mode alike. A call made
 * while one is pending, a double click, shares its answer and its one toast.
 *
 * @param t The `editor` namespace translator.
 */
export function canTurnMicrophoneOn(t: (key: string) => string): Promise<boolean> {
	pendingCheck ??= hasMicrophoneDevice()
		.then((found) => {
			if (!found) {
				toast.error(t("rec.noMicrophoneFound"));
				forgetMicrophone();
			}
			return found;
		})
		.finally(() => {
			pendingCheck = null;
		});
	return pendingCheck;
}

/**
 * Whether a take records the microphone: switched on, and an input listed. A stored "on"
 * the toggle never checked (an older build, another Mac, an input unplugged since) must
 * not reach the capture helper (#995), and is cleared so the toggles show it off.
 */
export async function shouldRecordMicrophone(enabled: boolean): Promise<boolean> {
	if (!enabled) return false;
	if (await hasMicrophoneDevice()) return true;
	console.warn("No microphone is listed; recording without it.");
	forgetMicrophone();
	return false;
}
