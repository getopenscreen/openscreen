import assert from "node:assert/strict";
import { test } from "node:test";

import { type BackgroundLayer, createBackgrounds } from "./backgrounds.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: () => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
	const loads: { slot: number; index: number; done: ReturnType<typeof deferred> }[] = [];
	const paints: { slot: number; visible: boolean; foreground: boolean }[] = [];
	const fades: ReturnType<typeof deferred>[] = [];
	const layers = [0, 1].map(
		(slot): BackgroundLayer => ({
			load(index) {
				const done = deferred();
				loads.push({ slot, index, done });
				return done.promise;
			},
			show(visible, foreground = false) {
				paints.push({ slot, visible, foreground });
			},
		}),
	) as [BackgroundLayer, BackgroundLayer];
	const controller = createBackgrounds(layers, 3, () => {
		const fade = deferred();
		fades.push(fade);
		return fade.promise;
	});
	return { controller, loads, paints, fades };
}

test("keep the painted wallpaper until the new one decodes, then hold it through the fade", async () => {
	const h = harness();
	h.controller.show(0);
	assert.equal(h.loads.length, 1);
	assert.deepEqual(h.paints, []);
	h.loads[0].done.resolve();
	await flush();
	assert.deepEqual(h.paints, [
		{ slot: 0, visible: true, foreground: false },
		{ slot: 1, visible: true, foreground: true },
	]);
	assert.equal(h.loads.length, 1, "do not replace the outgoing bitmap mid-fade");
	h.fades[0].resolve();
	await flush();
	assert.deepEqual(h.paints.at(-1), { slot: 0, visible: false, foreground: false });
	assert.equal(h.loads[1].index, 1, "only the next wallpaper is prepared");
	h.controller.dispose();
});

test("rapid scroll during decode skips obsolete wallpapers", async () => {
	const h = harness();
	h.controller.show(0);
	h.controller.show(1);
	h.controller.show(2);
	h.loads[0].done.resolve();
	await flush();
	assert.deepEqual(h.paints, []);
	assert.equal(h.loads[1].index, 2);
	h.loads[1].done.resolve();
	await flush();
	assert.equal(h.paints.at(-1)?.foreground, true);
	assert.equal(h.loads.length, 2);
	h.controller.dispose();
	h.fades[0].resolve();
});

test("scrolling back during a fade waits for it, then decodes only the latest request", async () => {
	const h = harness();
	h.controller.show(0);
	h.loads[0].done.resolve();
	await flush();
	h.controller.show(1);
	h.controller.show(2);
	assert.equal(h.loads.length, 1);
	h.fades[0].resolve();
	await flush();
	assert.equal(h.loads[1].index, 2);
	assert.equal(h.loads[1].slot, 0);
	h.controller.dispose();
	h.loads[1].done.resolve();
});

test("a failed download retains the current picture and a later scroll can recover", async () => {
	const h = harness();
	h.controller.show(0);
	h.loads[0].done.reject();
	await flush();
	assert.deepEqual(h.paints, []);
	h.controller.show(2);
	h.loads[1].done.resolve();
	await flush();
	assert.equal(h.paints.at(-1)?.foreground, true);
	h.controller.dispose();
	h.fades[0].resolve();
});

test("detaching during decode prevents a stale driver from changing the scene", async () => {
	const h = harness();
	h.controller.show(0);
	h.controller.dispose();
	h.loads[0].done.resolve();
	await flush();
	assert.deepEqual(h.paints, []);
	assert.equal(h.loads.length, 1);
});
