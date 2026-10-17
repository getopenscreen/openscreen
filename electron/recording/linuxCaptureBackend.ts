import type { NativeLinuxCaptureSource } from "../../src/lib/nativeLinuxRecording";

type SessionEnvironment = Readonly<Record<string, string | undefined>>;

/** A Wayland session's XWayland DISPLAY never authorizes direct X11 capture. */
export function linuxCaptureBackend(environment: SessionEnvironment): "x11" | "pipewire" {
	if (environment.XDG_SESSION_TYPE === "wayland" || environment.WAYLAND_DISPLAY) {
		return "pipewire";
	}
	return environment.DISPLAY &&
		(!environment.XDG_SESSION_TYPE || environment.XDG_SESSION_TYPE === "x11")
		? "x11"
		: "pipewire";
}

export function linuxPortalOwnsSources(
	platform: string,
	helperAvailable: boolean,
	environment: SessionEnvironment,
): boolean {
	return platform === "linux" && helperAvailable && linuxCaptureBackend(environment) === "pipewire";
}

type Display = {
	id: number;
	bounds: { x: number; y: number; width: number; height: number };
	scaleFactor: number;
};

/** Resolve only the explicitly selected source; never substitute the whole desktop. */
export function resolveX11CaptureSource(
	source: { id?: string; display_id?: string } | null,
	displays: readonly Display[],
): NativeLinuxCaptureSource {
	if (!source?.id) throw new Error("Select an X11 display or window before recording.");
	const window = /^window:(\d+):/.exec(source.id);
	if (window) {
		const windowId = Number(window[1]);
		if (!Number.isSafeInteger(windowId) || windowId <= 0 || windowId > 0xffffffff) {
			throw new Error("The selected X11 window id is invalid.");
		}
		return { kind: "window", windowId };
	}
	if (!source.id.startsWith("screen:")) throw new Error("Unsupported X11 recording source.");
	const display = displays.find((candidate) => String(candidate.id) === source.display_id);
	if (!display) throw new Error("The selected X11 display is no longer available.");
	const { bounds, scaleFactor } = display;
	if (displays.some((candidate) => candidate.scaleFactor !== scaleFactor)) {
		throw new Error(
			"X11 display capture requires matching display scale factors; select a window instead.",
		);
	}
	// Electron places the primary display at (0, 0); the X11 root starts at
	// the top-left of the complete desktop, including displays to its left.
	const rootX = Math.min(
		...displays.map((candidate) => candidate.bounds.x * candidate.scaleFactor),
	);
	const rootY = Math.min(
		...displays.map((candidate) => candidate.bounds.y * candidate.scaleFactor),
	);
	return {
		kind: "display",
		x: Math.round(bounds.x * scaleFactor - rootX),
		y: Math.round(bounds.y * scaleFactor - rootY),
		width: Math.round(bounds.width * scaleFactor),
		height: Math.round(bounds.height * scaleFactor),
	};
}
