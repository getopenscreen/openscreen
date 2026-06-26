import { afterEach, describe, expect, it } from "vitest";
import { MainLogBuffer } from "./main-log-buffer";

describe("MainLogBuffer", () => {
	const buffers: MainLogBuffer[] = [];

	function make(capacity: number) {
		const b = new MainLogBuffer(capacity);
		buffers.push(b);
		return b;
	}

	afterEach(() => {
		for (const b of buffers) b.uninstall();
		buffers.length = 0;
	});

	it("captures every console level and routes to original", () => {
		const buf = make(10);
		const captured: string[] = [];
		const original = {
			log: (...args: unknown[]) => captured.push(`log:${args.join(",")}`),
			info: (...args: unknown[]) => captured.push(`info:${args.join(",")}`),
			warn: (...args: unknown[]) => captured.push(`warn:${args.join(",")}`),
			error: (...args: unknown[]) => captured.push(`error:${args.join(",")}`),
		};
		Object.assign(console, original);
		buf.install();
		console.log("hello");
		console.info("world");
		console.warn("watch");
		console.error("bad");
		const snap = buf.snapshot();
		expect(snap.map((e) => e.level)).toEqual(["log", "info", "warn", "error"]);
		expect(snap.map((e) => e.text)).toEqual(["hello", "world", "watch", "bad"]);
		expect(captured).toEqual(["log:hello", "info:world", "warn:watch", "error:bad"]);
	});

	it("stringifies non-string args", () => {
		const buf = make(5);
		buf.install();
		console.info({ a: 1 });
		const snap = buf.snapshot();
		expect(snap[0].text).toBe('{"a":1}');
	});

	it("drops oldest entries past capacity", () => {
		const buf = make(3);
		buf.install();
		for (let i = 0; i < 5; i += 1) console.info(`line ${i}`);
		const snap = buf.snapshot();
		expect(snap.map((e) => e.text)).toEqual(["line 2", "line 3", "line 4"]);
	});

	it("uninstall restores originals", () => {
		const buf = make(5);
		buf.install();
		console.info("captured");
		buf.uninstall();
		console.info("after-uninstall");
		const snap = buf.snapshot();
		expect(snap.map((e) => e.text)).toEqual(["captured"]);
	});

	it("clear empties the buffer", () => {
		const buf = make(5);
		buf.install();
		console.info("one");
		console.info("two");
		buf.clear();
		expect(buf.snapshot()).toEqual([]);
	});

	it("install is idempotent", () => {
		const buf = make(5);
		buf.install();
		buf.install();
		console.info("once");
		const snap = buf.snapshot();
		expect(snap.map((e) => e.text)).toEqual(["once"]);
	});
});
