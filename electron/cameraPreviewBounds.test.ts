import { describe, expect, it } from "vitest";
import { cameraPreviewBounds } from "./cameraPreviewBounds";

const bounds = { x: 400, y: 300, width: 368, height: 214 };
const area = { x: 0, y: 0, width: 1440, height: 900 };
describe("camera preview geometry", () => {
	it("moves across displays with negative origins and clamps into the work area", () => {
		expect(
			cameraPreviewBounds(bounds, "move", { x: -3000, y: 3000 }, { ...area, x: -1440 }),
		).toEqual({ ...bounds, x: -1440, y: 686 });
	});
	it.each(["nw", "ne", "sw", "se"] as const)("anchors the opposite corner for %s", (direction) => {
		const result = cameraPreviewBounds(bounds, direction, { x: 64, y: 32 }, area);
		expect((result.width - 16) / (result.height - 16)).toBeCloseTo(16 / 9, 1);
		expect(direction.includes("w") ? result.x + result.width : result.x).toBe(
			direction.includes("w") ? bounds.x + bounds.width : bounds.x,
		);
		expect(direction.includes("n") ? result.y + result.height : result.y).toBe(
			direction.includes("n") ? bounds.y + bounds.height : bounds.y,
		);
	});
	it("limits both very small and very large resizes", () => {
		const small = cameraPreviewBounds(bounds, "se", { x: -10000, y: -10000 }, area);
		const large = cameraPreviewBounds(bounds, "se", { x: 10000, y: 10000 }, area);
		expect(small.width).toBe(256);
		expect(large.width).toBe(736);
		expect(large.x + large.width).toBeLessThanOrEqual(area.width);
		expect(large.y + large.height).toBeLessThanOrEqual(area.height);
	});
});
