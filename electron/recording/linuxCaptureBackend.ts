import { execFile } from "node:child_process";
import type { NativeLinuxCaptureSource } from "../../src/lib/nativeLinuxRecording";

type SessionEnvironment = Readonly<Record<string, string | undefined>>;
type Backend = "x11" | "pipewire";

/** A Wayland session's XWayland DISPLAY never authorizes direct X11 capture. */
export function isX11Session(environment: SessionEnvironment): boolean {
	if (environment.XDG_SESSION_TYPE === "wayland" || environment.WAYLAND_DISPLAY) return false;
	return Boolean(
		environment.DISPLAY &&
			(!environment.XDG_SESSION_TYPE || environment.XDG_SESSION_TYPE === "x11"),
	);
}

/** The backend the helper's `ready` names; a helper that predates the field is the portal. */
export function backendFromProbe(stdout: string): Backend {
	for (const line of stdout.split("\n")) {
		try {
			const event = JSON.parse(line) as { event?: string; backend?: string };
			if (event.event === "ready") return event.backend === "x11" ? "x11" : "pipewire";
		} catch {
			// Not an event line: the helper also prints logs.
		}
	}
	return "pipewire";
}

function probeHelper(helperPath: string): Promise<Backend> {
	return new Promise((resolve) => {
		execFile(helperPath, [JSON.stringify({ probeOnly: true })], { timeout: 10_000 }, (_, stdout) =>
			resolve(backendFromProbe(String(stdout ?? ""))),
		);
	});
}

let probed: Promise<Backend> | null = null;

/**
 * The portal first: it keeps dmabuf and GPU encoding, so an X11 session with a working
 * ScreenCast portal stays on it. Only the helper can tell whether the portal answers, so
 * it is asked once and asked again after a failed take; Wayland never spawns the probe.
 * The helper follows this choice: a take given an X11 source records X11.
 */
export function linuxCaptureBackend(
	helperPath: string,
	environment: SessionEnvironment,
	probe: (helperPath: string) => Promise<Backend> = probeHelper,
): Promise<Backend> {
	if (!isX11Session(environment)) return Promise.resolve("pipewire");
	probed ??= probe(helperPath);
	return probed;
}

export async function linuxPortalOwnsSources(
	platform: string,
	helperPath: string | null,
	environment: SessionEnvironment,
): Promise<boolean> {
	if (platform !== "linux" || !helperPath) return false;
	return (await linuxCaptureBackend(helperPath, environment)) === "pipewire";
}

/** Forget the cached probe, so the next take asks the helper again. */
export function resetLinuxCaptureBackendProbe(): void {
	probed = null;
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
