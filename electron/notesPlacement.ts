// Opening Notes clear of the HUD bar on GNOME Wayland.
//
// A Wayland client cannot place its windows. mutter opens a new one 50px down-right of each
// window whose top-left corner sits on its diagonal from the work area's corner, and the HUD
// sits on that diagonal from launch. How many steps Notes takes depends on the other windows on
// the desktop, so no opening height keeps it off the bar: in rc.3, at 402px, three steps put it
// 48px over the bar.
//
// What mutter does not vary is where a window as tall as the work area goes: its top edge. A
// cascade step would push it off the bottom, so mutter starts the next cascade along the top
// edge, and its first-fit search must fit the whole window too. A resize then keeps the window's
// top-left. So Notes opens that tall and shrinks once the compositor has placed it. The HUD's
// window cannot rise above that edge, and everything it draws sits at least
// WAYLAND_HUD_BAR_TOP below its own top, so a Notes window shorter than that ends above the bar
// wherever the HUD is. Measured on GNOME 46 (v2.3.0-rc.3): Notes at x 50–450, y 32–433 with the
// bar at y 535, where it had opened at y 183–583.

/** The slice of `BrowserWindow` this needs, so the rule can be tested without Electron. */
export type PlacedWindow = {
	isDestroyed(): boolean;
	once(event: "resize", listener: () => void): unknown;
	setSize(width: number, height: number): void;
	setMaximumSize(width: number, height: number): void;
};

type Size = { width: number; height: number };

/**
 * How long to wait for the compositor's first configure before shrinking anyway, for a
 * compositor that does not clamp the window to its work area and so never sends one.
 */
export const PLACEMENT_FALLBACK_MS = 1000;

/**
 * Taller than any display, so the compositor has to clamp the window to its work area: that
 * clamp is the configure `shrinkOncePlaced` waits for.
 */
export function topEdgeOpeningHeight(displayHeights: readonly number[]): number {
	return Math.max(0, ...displayHeights) + 1;
}

/**
 * For a window just shown at `topEdgeOpeningHeight`: brings it to `size`, and its maximum back
 * to `max`, once the compositor has placed it. Its first configure, the `resize` that clamps it
 * to the work area, tells when. A resize sent before it is overwritten (measured: 16ms after
 * `show()`, Notes stayed full height), so the shrink waits for it and goes out on the next turn.
 */
export function shrinkOncePlaced(win: PlacedWindow, size: Size, max: Size): void {
	let done = false;
	const shrink = () => {
		if (done || win.isDestroyed()) return;
		done = true;
		win.setSize(size.width, size.height);
		win.setMaximumSize(max.width, max.height);
	};
	win.once("resize", () => setTimeout(shrink, 0));
	setTimeout(shrink, PLACEMENT_FALLBACK_MS);
}
