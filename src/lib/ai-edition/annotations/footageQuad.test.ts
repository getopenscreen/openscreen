import { describe, expect, it } from "vitest";
import { type FootageQuad, footageAt, footagePoint, quadFromPacket, rectQuad } from "./footageQuad";

// A plane leaning away on its right, as the fixed angles draw it, and the same corners under
// the real camera (their homography).
const LEANING: FootageQuad["corners"] = [
	[0.12, 0.08],
	[0.86, 0.16],
	[0.84, 0.82],
	[0.1, 0.9],
];

describe("footageQuad", () => {
	it("maps the footage onto a rect at rest", () => {
		const q = rectQuad(0.1, 0.2, 0.8, 0.5);
		const [x, y] = footagePoint(q, 0.25, 0.5);
		expect(x).toBeCloseTo(0.3, 12);
		expect(y).toBeCloseTo(0.45, 12);
		const [u, v] = footageAt(q, 0.3, 0.45);
		expect(u).toBeCloseTo(0.25, 9);
		expect(v).toBeCloseTo(0.5, 9);
	});

	it("lands on the corners and goes back, bilinear or projective", () => {
		for (const projective of [false, true]) {
			const q = { corners: LEANING, projective };
			const corners = [
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 1],
			];
			corners.forEach(([u, v], k) => {
				const [x, y] = footagePoint(q, u, v);
				expect(x).toBeCloseTo(LEANING[k][0], 9);
				expect(y).toBeCloseTo(LEANING[k][1], 9);
			});
			for (const [u, v] of [
				[0.3, 0.7],
				[0.62, 0.18],
				[1.1, -0.05],
			]) {
				const [x, y] = footagePoint(q, u, v);
				const [bu, bv] = footageAt(q, x, y);
				expect(bu).toBeCloseTo(u, 6);
				expect(bv).toBeCloseTo(v, 6);
			}
		}
	});

	it("follows the homography of `square_to_quad`, not the bilinear blend, under the camera", () => {
		// The middle of the square: where the diagonals cross under a homography, and the mean
		// of the corners under the bilinear warp. Leaning, the two differ.
		const [px, py] = footagePoint({ corners: LEANING, projective: true }, 0.5, 0.5);
		const [bx, by] = footagePoint({ corners: LEANING, projective: false }, 0.5, 0.5);
		expect(Math.hypot(px - bx, py - by)).toBeGreaterThan(1e-3);
		// The diagonals TL-BR and TR-BL cross at (px, py).
		const [tl, tr, br, bl] = LEANING;
		const cross = (a: readonly number[], b: readonly number[], p: readonly number[]) =>
			(b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
		expect(cross(tl, br, [px, py])).toBeCloseTo(0, 9);
		expect(cross(tr, bl, [px, py])).toBeCloseTo(0, 9);
	});

	it("reads the eight numbers of a frame packet", () => {
		expect(quadFromPacket([0, 0, 1, 0, 1, 1, 0, 1], true)).toEqual({
			corners: [
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 1],
			],
			projective: true,
		});
		expect(quadFromPacket(undefined)).toBeNull();
		expect(quadFromPacket([0, 0, 1])).toBeNull();
	});
});
