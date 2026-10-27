/**
 * The HUD's floating surfaces, rendered in a window of their own on Linux.
 *
 * Elsewhere the device settings, the language menu, the notices and the toasts float
 * above the bar inside one large transparent window, and only the bar takes clicks: the
 * rest is click-through, re-enabled from the OS cursor position (see the
 * "hud-overlay-cursor" poll in electron/windows.ts). Wayland gives a client none of the
 * three things that design rests on. There is no global cursor position to poll; the
 * input region cannot be narrowed (BrowserWindow.setShape sends no
 * wl_surface.set_input_region on Wayland); and a client can neither place its window nor
 * choose which edge a resize grows from — Hyprland keeps a floating window centred,
 * mutter keeps its top-left corner. The reserve therefore showed as a large framed,
 * blurred box on Hyprland and swallowed every click inside it on any Wayland desktop.
 *
 * So on Linux the HUD window is the bar and nothing else, and everything that floats goes
 * to this panel window instead. The HUD keeps owning all of the state and every handler:
 * it sends a plain-data snapshot of what is open ({@link HudPanelState}), and the panel
 * sends back what the user did ({@link HudPanelAction}). Nothing but data crosses.
 */
import type { ToastT } from "sonner";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import type { MicrophoneDevice } from "../../hooks/useMicrophoneDevices";
import type { WebcamQualityId } from "../../hooks/webcamCaptureTarget";
import type { HudDeviceSettingsLabels } from "./HudDeviceSettings";

export interface HudPanelDeviceSettings {
	showMicrophone: boolean;
	micDevices: MicrophoneDevice[];
	cameraDevices: CameraDevice[];
	activeMicId: string | undefined;
	activeCameraId: string | undefined;
	cameraLoading: boolean;
	cameraError: string | null;
	labels: HudDeviceSettingsLabels;
	versionLabel: string | null;
	canCheckForUpdates: boolean;
	checkingForUpdates: boolean;
	cameraQuality: WebcamQualityId;
}

export interface HudPanelLanguageMenu {
	locales: readonly string[];
	activeLocale: string;
	/** Display name per locale, resolved in the HUD where the i18n context lives. */
	names: Record<string, string>;
}

export type HudPanelNoticeId = "system-locale" | "software-encoder-fallback";

export interface HudPanelNotice {
	id: HudPanelNoticeId;
	title: string;
	description: string;
	dismissLabel: string;
	confirmLabel: string;
}

export interface HudPanelToast {
	id: string | number;
	type: "default" | "success" | "error" | "warning" | "info" | "loading";
	title: string;
	description?: string;
	actionLabel?: string;
	duration?: number;
}

export interface HudPanelState {
	deviceSettings: HudPanelDeviceSettings | null;
	languageMenu: HudPanelLanguageMenu | null;
	notices: HudPanelNotice[];
	toasts: HudPanelToast[];
}

export type HudPanelAction =
	| { kind: "select-mic"; device: MicrophoneDevice }
	| { kind: "select-camera"; device: CameraDevice }
	| { kind: "select-camera-quality"; quality: WebcamQualityId }
	| { kind: "check-for-updates" }
	| { kind: "close-device-settings" }
	| { kind: "select-locale"; locale: string }
	| { kind: "close-popovers" }
	| { kind: "notice"; id: HudPanelNoticeId; choice: "dismiss" | "confirm" }
	| { kind: "toast-action"; id: string | number }
	| { kind: "toast-dismiss"; id: string | number };

export const EMPTY_HUD_PANEL_STATE: HudPanelState = {
	deviceSettings: null,
	languageMenu: null,
	notices: [],
	toasts: [],
};

/** Whether there is anything for the panel to show; when not, the window is hidden. */
export function hudPanelHasContent(state: HudPanelState): boolean {
	return (
		state.deviceSettings !== null ||
		state.languageMenu !== null ||
		state.notices.length > 0 ||
		state.toasts.length > 0
	);
}

/** A toast's title or description as text. Only strings survive the trip between windows. */
function toastText(value: ToastT["title"]): string | undefined {
	const resolved = typeof value === "function" ? value() : value;
	if (resolved === null || resolved === undefined || resolved === false) return undefined;
	return typeof resolved === "string" || typeof resolved === "number"
		? String(resolved)
		: undefined;
}

/**
 * The HUD's live toasts (sonner's `useSonner`) as plain data. Dismissed ones are left out;
 * an action is carried as its label, and the click comes back as a `toast-action`.
 */
export function toHudPanelToasts(toasts: readonly ToastT[]): HudPanelToast[] {
	return toasts
		.filter((toast) => !toast.delete)
		.map((toast) => {
			const action =
				toast.action && typeof toast.action === "object" && "label" in toast.action
					? toastText(toast.action.label as ToastT["title"])
					: undefined;
			const type =
				toast.type && toast.type !== "normal" && toast.type !== "action" ? toast.type : "default";
			return {
				id: toast.id,
				type,
				title: toastText(toast.title) ?? "",
				...(toastText(toast.description) ? { description: toastText(toast.description) } : {}),
				...(action ? { actionLabel: action } : {}),
				...(toast.duration !== undefined ? { duration: toast.duration } : {}),
			};
		});
}
