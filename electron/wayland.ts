type CommandLine = Pick<Electron.CommandLine, "appendSwitch" | "hasSwitch" | "getSwitchValue">;
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
	// Chromium folds the desktop's text-scaling factor (GNOME's `text-scaling-factor`) into
	// its device scale, on top of the output scale the compositor applies, and gets it wrong
	// for a window that sizes ITSELF: given a size through setSize/setBounds, the window lays
	// its page out in that many CSS px but paints them at the scaled ratio. With a factor of
	// 0.818 on a scale-2 output (devicePixelRatio 1.625), every frameless window the app
	// sizes to its content (the HUD, its panel, the countdown) showed its page in the
	// top-left 81% and left the rest empty, which Hyprland framed and blurred like content.
	// Measured with a fixed 400x200 window: 81% filled by default, 100% with the factor
	// forced to 1. Forcing it replaces only the text-scaling part; the compositor's
	// per-output scale still applies. Not under Xwayland, where this factor is the whole
	// HiDPI scale, and never over an explicit factor.
	if (
		commandLine.getSwitchValue("ozone-platform") !== "x11" &&
		!commandLine.hasSwitch("force-device-scale-factor")
	) {
		commandLine.appendSwitch("force-device-scale-factor", "1");
	}
}
