import assert from "node:assert/strict";
import { test } from "node:test";

import { followHeight, footageSize } from "./layout.ts";

test("a picture taller than the inspector keeps its full 16:9 size", () => {
	const size = footageSize(1238, 497, 964);
	assert.equal(size.width, 1238);
	assert.equal(size.height, 696.375);
});

test("a picture shorter than the inspector extends its height without narrowing it", () => {
	const size = footageSize(609, 410, 489);
	assert.equal(size.width, 609);
	assert.equal(size.height, 410);
});

test("a short viewport reduces the picture proportionally to leave room for the timeline", () => {
	const size = footageSize(1238, 316, 374);
	assert.ok(Math.abs(size.height - 374) < 0.000001);
	assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.000001);
});

test("a viewport-fitted picture still aligns with a taller inspector", () => {
	const size = footageSize(1238, 298, 279);
	assert.equal(size.height, 298);
	assert.ok(Math.abs(size.width - 279 * (16 / 9)) < 0.000001);
});

test("pane height changes stay between their endpoints and settle without a yoyo", () => {
	for (const [from, target] of [
		[318, 360],
		[503, 410],
		[410, 318],
	]) {
		let height = from;
		for (let frame = 0; frame < 60; frame++) {
			const next = followHeight(height, target, 16);
			assert.ok(next >= Math.min(height, target) && next <= Math.max(height, target));
			height = next;
		}
		assert.equal(height, target);
	}
});

test("reversing a height change continues from the displayed height", () => {
	let height = followHeight(318, 503, 48);
	assert.ok(height > 318 && height < 503);
	const reversed = followHeight(height, 318, 16);
	assert.ok(reversed < height && reversed > 318);
	height = followHeight(reversed, 360, 16);
	assert.ok(height >= Math.min(reversed, 360) && height <= Math.max(reversed, 360));
});

test("height changes have the same pace at 60 Hz and 120 Hz", () => {
	const at = (step: number) => {
		let height = 318;
		for (let elapsed = 0; elapsed < 96; elapsed += step) {
			height = followHeight(height, 503, step);
		}
		return height;
	};
	assert.ok(Math.abs(at(16) - at(8)) < 0.001);
	assert.equal(followHeight(318, 503, 0), 318);
});
