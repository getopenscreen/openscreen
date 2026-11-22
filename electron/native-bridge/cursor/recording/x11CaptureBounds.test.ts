import { describe, expect, it } from "vitest";
import { resolveX11CaptureBounds } from "./x11CaptureBounds";

const left = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const right = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
const options = { displays: [left, right], sourceKind: "monitor", origin: null, size: null };

describe("resolveX11CaptureBounds", () => {
	it("uses the captured origin even with identical-size monitors", () => {
		expect(
			resolveX11CaptureBounds({
				...options,
				displays: [left, { ...right, scaleFactor: 1 }],
				origin: { x: -1920, y: 0 },
			}),
		).toEqual(left.bounds);
	});
	it("uses DIP bounds rather than combining pixel dimensions with a logical origin", () => {
		expect(
			resolveX11CaptureBounds({
				...options,
				origin: { x: 0, y: 0 },
				size: { width: 3840, height: 2160 },
			}),
		).toEqual(right.bounds);
	});
	it("resolves a unique pixel-size match on a scaled monitor", () => {
		expect(resolveX11CaptureBounds({ ...options, size: { width: 3840, height: 2160 } })).toEqual(
			right.bounds,
		);
	});
	it("declines pixel/DIP origin collisions in scaled multi-monitor layouts", () => {
		const displays = [0, 960, 1920].map((x) => ({
			bounds: { x, y: 0, width: 960, height: 540 },
			scaleFactor: 2,
		}));
		// The native helper captured monitor 2 at pixel x=1920, not monitor 3
		// whose Electron DIP x happens to be 1920. Measured with Xorg dummy.
		expect(
			resolveX11CaptureBounds({
				displays,
				sourceKind: "monitor",
				origin: { x: 1920, y: 0 },
				size: { width: 1920, height: 1080 },
			}),
		).toBeNull();
	});
	it("declines untagged nonzero origins in mixed-scale layouts", () => {
		expect(resolveX11CaptureBounds({ ...options, origin: { x: -1920, y: 0 } })).toBeNull();
	});
	it("declines ambiguous equal-size monitors", () => {
		expect(resolveX11CaptureBounds({ ...options, size: { width: 1920, height: 1080 } })).toBeNull();
	});
	it("does not infer a window or unknown source from monitor dimensions", () => {
		for (const sourceKind of ["window", "virtual", undefined]) {
			expect(
				resolveX11CaptureBounds({ ...options, sourceKind, origin: { x: 0, y: 0 } }),
			).toBeNull();
		}
	});
	it("declines missing or unmatched geometry and duplicate origins", () => {
		expect(resolveX11CaptureBounds(options)).toBeNull();
		expect(resolveX11CaptureBounds({ ...options, origin: { x: 80, y: 80 } })).toBeNull();
		expect(
			resolveX11CaptureBounds({ ...options, displays: [right, right], origin: { x: 0, y: 0 } }),
		).toBeNull();
	});
});
