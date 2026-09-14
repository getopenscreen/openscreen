import { describe, expect, it } from "vitest";
import { clampHudToWorkArea, HUD_WINDOW_MIN, hudDragDestination } from "./hudWindowBounds";

// 1920x1080 with a 48px taskbar at the bottom: the work area stops above it, so a window
// whose bottom edge reaches 1032 is sitting on the taskbar.
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1032 };
// A HUD with room to move: 560x100, well clear of the bottom of the work area.
const HUD = { x: 680, y: 800, width: 560, height: 100 };

/** The drag path as the IPC handler runs it: destination first, then the work-area clamp. */
function dragTo(deltaX: number, deltaY: number, { bounds = HUD, workArea = WORK_AREA } = {}) {
	return clampHudToWorkArea(
		hudDragDestination({ bounds, origin: bounds, deltaX, deltaY }),
		workArea,
	);
}

describe("hud drag bounds", () => {
	it("follows the pointer while the window stays on screen", () => {
		expect(dragTo(40, -120)).toEqual({ x: 720, y: 680, width: 560, height: 100 });
	});

	it("stops the bar above the taskbar when the drag aims past the bottom of the screen", () => {
		const asked = hudDragDestination({ bounds: HUD, origin: HUD, deltaX: 0, deltaY: 4000 });
		// Without the clamp this is where the window would land: 3000px past the taskbar.
		expect(asked.y).toBe(4800);

		const clamped = dragTo(0, 4000);
		expect(clamped.y + clamped.height).toBe(WORK_AREA.height);
		expect(clamped.x).toBe(HUD.x);
	});

	it("keeps the bar off the left, top and right edges", () => {
		expect(dragTo(-4000, 0)).toEqual({ ...HUD, x: 0 });
		expect(dragTo(0, -4000)).toEqual({ ...HUD, y: 0 });
		expect(dragTo(4000, 0)).toEqual({ ...HUD, x: WORK_AREA.width - HUD.width });
	});

	it("uses the work area of the display the drag lands on, not the one it started on", () => {
		// Second display to the left of the primary one, work area 1280x984 starting at
		// x = -1280. Dragging left across the boundary must be allowed to follow.
		const left = { x: -1280, y: 0, width: 1280, height: 984 };
		const destination = hudDragDestination({
			bounds: HUD,
			origin: HUD,
			deltaX: -1500,
			deltaY: 0,
		});
		expect(destination.x).toBe(-820);

		const clamped = clampHudToWorkArea(destination, left);
		expect(clamped).toEqual({ ...HUD, x: -820 });
		expect(clamped.x).toBeLessThan(0);
	});

	it("shrinks a HUD that cannot fit the work area at all", () => {
		const clamped = clampHudToWorkArea(
			{ x: 900, y: 900, width: 2600, height: 1400 },
			{ x: 0, y: 0, width: 1024, height: 768 },
		);
		expect(clamped).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
	});

	it("never hands a fractional or negative-zero coordinate to the window", () => {
		// A fractional, slightly negative delta is routine under fractional display
		// scaling, and Math.round turns it into -0 — which the native setter rejects
		// (see the comment in hudDragDestination).
		const tiny = hudDragDestination({ bounds: HUD, origin: HUD, deltaX: -0.2, deltaY: -0.4 });
		expect(Number.isInteger(tiny.x)).toBe(true);
		expect(Number.isInteger(tiny.y)).toBe(true);

		const clamped = clampHudToWorkArea(tiny, { ...WORK_AREA, x: 0 });
		expect(Object.is(clamped.x, -0)).toBe(false);
		expect(Object.is(clamped.y, -0)).toBe(false);
	});

	it("is idempotent, so a drag that re-clamps every frame cannot creep", () => {
		const once = dragTo(0, 4000);
		const twice = clampHudToWorkArea(once, WORK_AREA);
		expect(twice).toEqual(once);
	});
});

describe("hud window minimum", () => {
	it("matches the window's own floor, not the editor's", () => {
		// browserWindow minWidth/minHeight at construction (electron/windows.ts).
		expect(HUD_WINDOW_MIN).toEqual({ width: 120, height: 80 });
	});
});
