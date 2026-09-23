/**
 * The macOS privacy permissions OpenScreen uses, read and requested in one place.
 *
 * Four permissions, and only one of them is required:
 *
 * - `screen`: Screen & System Audio Recording. Required. It also covers system audio,
 *   because that is captured through ScreenCaptureKit rather than a Core Audio tap.
 * - `accessibility`: recommended. The cursor helper needs it to tell pointer and text
 *   cursors apart; without it recording still works, with plainer cursor telemetry.
 * - `microphone` and `camera`: optional, and still requested at the moment of use when
 *   the user skipped them here.
 *
 * Screen Recording is the awkward one, for two reasons macOS gives no API around:
 *
 * 1. `CGPreflightScreenCaptureAccess()` caches its answer for the life of the calling
 *    process, and Electron's `getMediaAccessStatus("screen")` is that same call. A grant
 *    made while the app runs is invisible to the app's own read, so the live status is
 *    read from a helper spawned fresh for every read (`macScreenAccess.ts`).
 * 2. That read is a bool: "never asked" and "refused" are the same `false`. macOS shows
 *    its prompt once per decision and ignores every later request, so the app keeps its
 *    own note of having asked -- the only way to know whether a request can still raise
 *    a prompt or has to send the user to System Settings instead.
 *
 * Accessibility has the same bool-only read, and the same note is kept for it.
 */

export type PermissionKind = "screen" | "accessibility" | "microphone" | "camera";

/**
 * - `not-requested`: nothing has been asked yet, so a request can raise macOS' prompt.
 * - `denied`: asked and not granted. Only System Settings can change it now.
 * - `restricted`: forbidden by policy (MDM, Screen Time). Nothing the user can do here.
 */
export type PermissionStatus = "granted" | "not-requested" | "denied" | "restricted";

export interface PermissionsSnapshot {
	/** False off macOS, where none of this applies and every permission reads granted. */
	supported: boolean;
	/** macOS major version (13, 14, 15, 26...), 0 when unknown or off macOS. */
	macosMajor: number;
	screen: PermissionStatus;
	/**
	 * Screen Recording is granted, but this process still reads its cached refusal, so the
	 * parts of the app that go through Chromium (the source picker) cannot use it until the
	 * app is relaunched.
	 */
	screenRequiresRelaunch: boolean;
	accessibility: PermissionStatus;
	microphone: PermissionStatus;
	camera: PermissionStatus;
}

/** What a fresh-process read of the Screen Recording grant answered. */
export type ScreenProbe = { answered: true; granted: boolean } | { answered: false };

export type NotedKind = "screen" | "accessibility";

export interface PermissionsStore {
	hasRequested(kind: NotedKind): boolean;
	markRequested(kind: NotedKind): void;
}

export interface MacPermissionsDeps {
	platform: NodeJS.Platform;
	macosMajor: number;
	probeScreen(): Promise<ScreenProbe>;
	/** The app's own, per-process cached Screen Recording read. */
	appScreenGranted(): boolean;
	/** `isTrustedAccessibilityClient`: `prompt` raises macOS' prompt as a side effect. */
	accessibilityTrusted(prompt: boolean): boolean;
	/** `getMediaAccessStatus` for the microphone or camera. */
	mediaStatus(kind: "microphone" | "camera"): string;
	askForMedia(kind: "microphone" | "camera"): Promise<boolean>;
	/** Raises macOS' Screen Recording prompt from the app's own process. */
	raiseScreenPrompt(): void;
	openExternal(url: string): Promise<void>;
	store: PermissionsStore;
}

/**
 * The legacy `com.apple.preference.security` form opens the right pane on every version
 * from 13 to 26. The `com.apple.settings.PrivacySecurity.extension` form that macOS 26
 * uses itself is unconfirmed on 13.
 */
const SETTINGS_ANCHOR: Record<PermissionKind, string> = {
	screen: "Privacy_ScreenCapture",
	accessibility: "Privacy_Accessibility",
	microphone: "Privacy_Microphone",
	camera: "Privacy_Camera",
};

export function permissionSettingsUrl(kind: PermissionKind): string {
	return `x-apple.systempreferences:com.apple.preference.security?${SETTINGS_ANCHOR[kind]}`;
}

function mediaPermissionStatus(status: string): PermissionStatus {
	switch (status) {
		case "granted":
			return "granted";
		case "not-determined":
			return "not-requested";
		case "restricted":
			return "restricted";
		default:
			return "denied";
	}
}

const OFF_MACOS: PermissionsSnapshot = {
	supported: false,
	macosMajor: 0,
	screen: "granted",
	screenRequiresRelaunch: false,
	accessibility: "granted",
	microphone: "granted",
	camera: "granted",
};

export function createMacPermissions(deps: MacPermissionsDeps) {
	const notedStatus = (kind: NotedKind): PermissionStatus =>
		deps.store.hasRequested(kind) ? "denied" : "not-requested";

	async function readScreen(): Promise<{ status: PermissionStatus; requiresRelaunch: boolean }> {
		const appGranted = deps.appScreenGranted();
		const probe = await deps.probeScreen();
		// A helper that could not answer (absent from the build, crashed, hung) says nothing
		// about the permission, so this falls back to the app's own read: stale at worst,
		// which is all any build had before the helper.
		const granted = probe.answered ? probe.granted : appGranted;
		if (!granted) {
			return { status: notedStatus("screen"), requiresRelaunch: false };
		}
		return { status: "granted", requiresRelaunch: !appGranted };
	}

	async function read(): Promise<PermissionsSnapshot> {
		if (deps.platform !== "darwin") {
			return OFF_MACOS;
		}

		const screen = await readScreen();
		return {
			supported: true,
			macosMajor: deps.macosMajor,
			screen: screen.status,
			screenRequiresRelaunch: screen.requiresRelaunch,
			accessibility: deps.accessibilityTrusted(false) ? "granted" : notedStatus("accessibility"),
			microphone: mediaPermissionStatus(deps.mediaStatus("microphone")),
			camera: mediaPermissionStatus(deps.mediaStatus("camera")),
		};
	}

	function openSettings(kind: PermissionKind): Promise<void> {
		return deps.openExternal(permissionSettingsUrl(kind));
	}

	/**
	 * Does whatever can move `kind` towards granted: raises macOS' prompt the first time,
	 * and opens the matching System Settings pane once a prompt can no longer appear.
	 */
	async function request(kind: PermissionKind): Promise<void> {
		if (deps.platform !== "darwin") {
			return;
		}
		const status = (await read())[kind];

		if (status === "granted" || status === "restricted") {
			return;
		}
		if (status === "denied") {
			await openSettings(kind);
			return;
		}

		switch (kind) {
			case "screen":
				// Noted before raising: if the app quits with the prompt still up, the next
				// launch must offer System Settings, not a prompt macOS will not show again.
				deps.store.markRequested("screen");
				deps.raiseScreenPrompt();
				return;
			case "accessibility":
				deps.store.markRequested("accessibility");
				deps.accessibilityTrusted(true);
				return;
			case "microphone":
			case "camera":
				await deps.askForMedia(kind);
				return;
		}
	}

	/** For a prompt raised elsewhere -- the cursor helper raises Accessibility's itself. */
	function noteRequested(kind: NotedKind): void {
		deps.store.markRequested(kind);
	}

	return { read, request, openSettings, noteRequested };
}

export type MacPermissions = ReturnType<typeof createMacPermissions>;
