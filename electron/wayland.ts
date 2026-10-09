type CommandLine = Pick<Electron.CommandLine, "appendSwitch" | "hasSwitch">;

/** Prefer Wayland in a Wayland session, while respecting an explicit backend. */
export function configureWaylandSupport(
	commandLine: CommandLine,
	env: Readonly<Record<string, string | undefined>>,
): void {
	const isWayland = env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY !== undefined;
	if (!isWayland) return;
	if (!commandLine.hasSwitch("ozone-platform")) {
		commandLine.appendSwitch("ozone-platform", "wayland");
	}
	commandLine.appendSwitch("enable-features", "WaylandWindowDrag,WebRTCPipeWireCapturer");
	// Chromium's Wayland backend cannot import PipeWire DMA-BUF frames through
	// Vulkan. Keep the existing GL/EGL capture path for Wayland sessions.
	commandLine.appendSwitch("disable-features", "Vulkan");
}
