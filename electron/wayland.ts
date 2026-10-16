type CommandLine = Pick<Electron.CommandLine, "appendSwitch" | "hasSwitch">;
type Env = Readonly<Record<string, string | undefined>>;

export function isWaylandSession(env: Env): boolean {
	return env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY !== undefined;
}

/**
 * Whether Chromium draws this process's windows through its Wayland backend: a Linux Wayland
 * session, unless an explicit `--ozone-platform=x11` sent it to Xwayland, which
 * configureWaylandSupport leaves alone.
 */
export function usesWaylandBackend(
	platform: NodeJS.Platform,
	commandLine: Pick<Electron.CommandLine, "getSwitchValue">,
	env: Env,
): boolean {
	return (
		platform === "linux" &&
		isWaylandSession(env) &&
		commandLine.getSwitchValue("ozone-platform") !== "x11"
	);
}

/** Prefer Wayland in a Wayland session, while respecting an explicit backend. */
export function configureWaylandSupport(commandLine: CommandLine, env: Env): void {
	if (!isWaylandSession(env)) return;
	if (!commandLine.hasSwitch("ozone-platform")) {
		commandLine.appendSwitch("ozone-platform", "wayland");
	}
	// Enable WebRTCPipeWireCapturer for screen capture on Wayland
	commandLine.appendSwitch("enable-features", "WaylandWindowDrag,WebRTCPipeWireCapturer");
	// Chromium's Wayland Ozone backend can't use Vulkan. When it tries, the WebRTC
	// PipeWire capturer fails to import DMA-BUF frames into EGL (EGL_BAD_MATCH), the
	// stream renegotiates, and screen recording yields no usable frames. Force the
	// GL/EGL path so DMA-BUF import works. (Chromium itself logs this suggestion:
	// "'--ozone-platform=wayland' is not compatible with Vulkan ... disabling Vulkan".)
	commandLine.appendSwitch("disable-features", "Vulkan");
}
