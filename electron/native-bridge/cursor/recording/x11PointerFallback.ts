/**
 * Whether Linux recordings should sample the pointer via X11 when the ScreenCast
 * portal cannot supply METADATA cursor data.
 *
 * Wayland is excluded: `screen.getCursorScreenPoint()` returns {0,0} there, and
 * a well-formed sidecar full of origin samples is worse than no sidecar. X11
 * (including Xvfb cloud-agent desktops) can read the real pointer through
 * Electron, xdotool, or xev even when `AvailableSourceTypes=0`.
 *
 * An empty `WAYLAND_DISPLAY` does not count as Wayland — cloud Xvfb sessions
 * often export the variable unset-or-blank alongside `DISPLAY=:N`.
 *
 * `OPENSCREEN_FORCE_X11_CURSOR=1` turns the fallback on even in a Wayland
 * session (Xwayland / diagnostics). `OPENSCREEN_DISABLE_X11_CURSOR=1` turns it
 * off everywhere.
 */
type Env = Readonly<Record<string, string | undefined>>;

export function isX11PointerFallbackEnabled(
	platform: NodeJS.Platform = process.platform,
	env: Env = process.env,
): boolean {
	if (env.OPENSCREEN_DISABLE_X11_CURSOR === "1") {
		return false;
	}
	if (platform !== "linux") {
		return false;
	}
	if (env.OPENSCREEN_FORCE_X11_CURSOR === "1") {
		return true;
	}
	if (env.XDG_SESSION_TYPE === "wayland") {
		return false;
	}
	if (typeof env.WAYLAND_DISPLAY === "string" && env.WAYLAND_DISPLAY.length > 0) {
		return false;
	}
	return true;
}
