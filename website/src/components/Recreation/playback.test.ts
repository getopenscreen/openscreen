import assert from "node:assert/strict";
import { test } from "node:test";

import { createPlayback, followDock } from "./playback.ts";

test("the preview loops at real time and pauses without catching up", () => {
	const sample = createPlayback(26);
	sample(0, 0, 8000, 600, true);
	assert.equal(sample(5500, 0, 8000, 600, true).time, 5.5);
	assert.equal(sample(27500, 0, 8000, 600, true).time, 1.5);
	assert.equal(sample(28000, 0, 8000, 600, false).time, 1.5);
	assert.equal(sample(50000, 0, 8000, 600, true).time, 1.5);
	assert.equal(sample(51000, 0, 8000, 600, true).time, 2.5);
});

test("docking rewinds from the displayed frame and stays still when scrolling stops", () => {
	const sample = createPlayback(26);
	sample(0, 0, 8000, 600, true);
	sample(10000, 0, 8000, 600, true);
	const middle = sample(10000, 300, 8000, 600, true);
	assert.deepEqual(middle, { time: 5, dock: 0.5, phase: "docking" });
	assert.deepEqual(sample(20000, 300, 8000, 600, true), middle);
	assert.deepEqual(sample(21000, 600, 8000, 600, true), {
		time: 0,
		dock: 1,
		phase: "editor",
	});
	assert.equal(sample(22000, 4300, 8000, 600, true).time, 13);
	assert.equal(sample(23000, 9000, 8000, 600, true).time, 26);
});

test("scrolling back undoes docking continuously and resumes the loop", () => {
	const sample = createPlayback(26);
	sample(0, 0, 8000, 600, true);
	sample(12000, 0, 8000, 600, true);
	sample(12000, 4300, 8000, 600, true);
	assert.equal(sample(18000, 300, 8000, 600, true).time, 6);
	assert.equal(sample(19000, 0, 8000, 600, true).time, 12);
	assert.equal(sample(20000, 0, 8000, 600, true).time, 13);
});

test("the first scroll pixel already docks and rewinds the preview", () => {
	const sample = createPlayback(26);
	sample(0, 0, 8000, 240, true);
	sample(10000, 0, 8000, 240, true);
	const first = sample(10000, 1, 8000, 240, true);
	assert.equal(first.phase, "docking");
	assert.ok(first.dock > 0);
	assert.ok(first.time < 10);
	assert.equal(sample(10000, 240, 8000, 240, true).phase, "editor");
});

test("a wheel jump moves immediately and settles within a quarter second", () => {
	let offset = followDock(0, 240, 16);
	assert.ok(offset > 0 && offset < 240);
	for (let elapsed = 16; elapsed < 240; elapsed += 16) offset = followDock(offset, 240, 16);
	assert.equal(offset, 240);
	assert.ok(followDock(offset, 0, 16) < offset, "scrolling back responds immediately too");
});

test("the smoothing has the same pace on 60 Hz and 120 Hz displays", () => {
	const at = (step: number) => {
		let offset = 0;
		for (let elapsed = 0; elapsed < 96; elapsed += step) offset = followDock(offset, 240, step);
		return offset;
	};
	assert.ok(Math.abs(at(16) - at(8)) < 0.001);
});

test("a large wheel step travels through the dock seam before advancing the editor", () => {
	const sample = createPlayback(26);
	sample(0, 0, 8000, 240, true);
	sample(10000, 0, 8000, 240, true);
	let offset = 0;
	let editor = false;
	for (let elapsed = 16; elapsed <= 800; elapsed += 16) {
		offset = followDock(offset, 1000, 16, 240);
		const frame = sample(10000 + elapsed, offset, 8000, 240, true);
		if (elapsed === 16) assert.equal(frame.phase, "docking");
		if (frame.phase === "editor" && !editor) {
			assert.equal(frame.time, 0, "the editor starts at its first frame");
			editor = true;
		}
	}
	assert.ok(editor);
	assert.equal(offset, 1000, "the remaining scroll also settles without a snap");
});

test("landing directly in the editor does not play a preview first", () => {
	const sample = createPlayback(26);
	assert.deepEqual(sample(1000, 600, 8000, 600, true), {
		time: 0,
		dock: 1,
		phase: "editor",
	});
});
