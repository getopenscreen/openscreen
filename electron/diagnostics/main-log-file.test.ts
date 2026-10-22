import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainLogFile } from "./main-log-file";

describe("MainLogFile", () => {
	const logs: MainLogFile[] = [];
	let dir: string;

	function make(maxFileBytes?: number) {
		const log = new MainLogFile(maxFileBytes);
		logs.push(log);
		return log;
	}

	function silenceConsole(captured: string[] = []) {
		Object.assign(console, {
			log: (...args: unknown[]) => captured.push(`log:${args.join(",")}`),
			info: (...args: unknown[]) => captured.push(`info:${args.join(",")}`),
			warn: (...args: unknown[]) => captured.push(`warn:${args.join(",")}`),
			error: (...args: unknown[]) => captured.push(`error:${args.join(",")}`),
		});
		return captured;
	}

	function lines(file = "main.log") {
		return fs.readFileSync(path.join(dir, file), "utf-8").trimEnd().split("\n");
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-main-log-"));
	});

	afterEach(() => {
		for (const log of logs) log.uninstall();
		logs.length = 0;
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("writes a launch header, then every console level, and still calls the console", () => {
		const captured = silenceConsole();
		make().install(dir, "launch 1.2.3 pid 42");
		console.log("hello");
		console.info("world");
		console.warn("watch");
		console.error("bad");

		const written = lines();
		expect(written[0]).toMatch(/^\S+ --- launch 1\.2\.3 pid 42 ---$/);
		expect(written.slice(1).map((line) => line.split(" ").slice(1).join(" "))).toEqual([
			"log hello",
			"info world",
			"warn watch",
			"error bad",
		]);
		expect(captured).toEqual(["log:hello", "info:world", "warn:watch", "error:bad"]);
	});

	it("appends to the previous launch's file", () => {
		silenceConsole();
		const first = make();
		first.install(dir, "launch one");
		console.info("from one");
		first.uninstall();
		make().install(dir, "launch two");

		expect(lines().map((line) => line.split(" ").slice(1).join(" "))).toEqual([
			"--- launch one ---",
			"info from one",
			"--- launch two ---",
		]);
	});

	it("writes an Error as its stack and an object as JSON", () => {
		silenceConsole();
		make().install(dir, "launch");
		const error = new Error("helper exited (code=1)");
		console.error("Failed to stop:", error);
		console.info({ a: 1 });

		const text = fs.readFileSync(path.join(dir, "main.log"), "utf-8");
		expect(text).toContain(`error Failed to stop: ${error.stack}`);
		expect(text).toContain('info {"a":1}');
	});

	it("moves a full file to main.old.log and never keeps more than two files", () => {
		silenceConsole();
		make(200).install(dir, "launch");
		for (let i = 0; i < 30; i += 1) console.info(`line ${String(i).padStart(2, "0")}`);

		expect(fs.readdirSync(dir).sort()).toEqual(["main.log", "main.old.log"]);
		expect(fs.statSync(path.join(dir, "main.log")).size).toBeLessThanOrEqual(200);
		expect(fs.statSync(path.join(dir, "main.old.log")).size).toBeLessThanOrEqual(200);
		expect(lines().at(-1)).toMatch(/info line 29$/);
	});

	it("rotates a file already over the cap when it is installed", () => {
		silenceConsole();
		fs.writeFileSync(path.join(dir, "main.log"), "x".repeat(300));
		make(200).install(dir, "launch");

		expect(fs.readFileSync(path.join(dir, "main.old.log"), "utf-8")).toBe("x".repeat(300));
		expect(lines()).toHaveLength(1);
	});

	it("reads the tail across main.old.log and main.log, from a line start", () => {
		fs.writeFileSync(path.join(dir, "main.old.log"), "old 1\nold 2\nold 3\n");
		fs.writeFileSync(path.join(dir, "main.log"), "new 1\nnew 2\n");
		silenceConsole();
		const log = make();
		log.install(dir, "launch");
		const header = lines().at(-1) as string;
		const currentBytes = Buffer.byteLength(`new 1\nnew 2\n${header}\n`);

		expect(log.readTail(10_000)).toBe(`old 1\nold 2\nold 3\nnew 1\nnew 2\n${header}\n`);
		// Eight bytes into the old file land mid-line: that partial line is dropped.
		expect(log.readTail(currentBytes + 8)).toBe(`old 3\nnew 1\nnew 2\n${header}\n`);
		expect(log.readTail(Buffer.byteLength(`${header}\n`) + 3)).toBe(`${header}\n`);
	});

	it("keeps the console working and reports why when the folder cannot be created", () => {
		const captured = silenceConsole();
		const blocker = path.join(dir, "not-a-folder");
		fs.writeFileSync(blocker, "");
		const log = make();
		log.install(path.join(blocker, "logs"), "launch");
		console.info("still here");

		expect(captured).toEqual(["info:still here"]);
		expect(log.lastError).toMatch(/^(EEXIST|ENOTDIR)/);
		expect(log.readTail(1000)).toBe("");
	});

	it("stops writing after a failed write and keeps the error", () => {
		const captured = silenceConsole();
		const log = make();
		log.install(dir, "launch");
		vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
				code: "ENOSPC",
			});
		});
		console.info("lost");
		console.info("also lost");

		expect(captured).toEqual(["info:lost", "info:also lost"]);
		expect(log.lastError).toMatch(/^ENOSPC/);
		expect(lines()).toHaveLength(1);
	});

	it("reports a failed read and keeps writing", () => {
		silenceConsole();
		const log = make();
		log.install(dir, "launch");
		vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
		});

		expect(log.readTail(1000)).toBe("");
		expect(log.lastError).toMatch(/^EIO/);
		console.info("after");
		expect(lines()).toHaveLength(2);
	});

	it("uninstall restores the console methods", () => {
		const captured = silenceConsole();
		const original = console.info;
		const log = make();
		log.install(dir, "launch");
		log.uninstall();
		console.info("after");

		expect(console.info).toBe(original);
		expect(captured).toEqual(["info:after"]);
		expect(lines()).toHaveLength(1);
	});

	describe("flood guard", () => {
		function texts() {
			return lines().map((line) => line.split(" ").slice(1).join(" "));
		}

		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("counts an identical line in a row instead of writing it", () => {
			const captured = silenceConsole();
			make().install(dir, "launch");
			for (let i = 0; i < 1000; i += 1) console.warn("[live] readback_direct: lost");
			console.info("next");

			expect(texts()).toEqual([
				"--- launch ---",
				"warn [live] readback_direct: lost",
				"warn last message repeated 999 times",
				"info next",
			]);
			expect(captured).toHaveLength(1001);
		});

		it("does not merge the same text at different levels", () => {
			silenceConsole();
			make().install(dir, "launch");
			console.info("same");
			console.warn("same");

			expect(texts()).toEqual(["--- launch ---", "info same", "warn same"]);
		});

		it("writes the repeat count while a flood lasts", () => {
			silenceConsole();
			make().install(dir, "launch");
			console.warn("flood");
			console.warn("flood");
			vi.advanceTimersByTime(30_000);
			console.warn("flood");
			for (let i = 0; i < 10_000; i += 1) console.warn("flood");

			expect(texts()).toEqual([
				"--- launch ---",
				"warn flood",
				"warn last message repeated 2 times",
				"warn last message repeated 10000 times",
			]);
		});

		it("rate-limits lines that differ and says how many were dropped", () => {
			const captured = silenceConsole();
			make().install(dir, "launch");
			for (let i = 0; i < 300; i += 1) console.warn(i % 2 ? "[annotation] a" : "[annotation] b");
			vi.advanceTimersByTime(1000);
			console.info("after");

			const written = texts();
			expect(written).toHaveLength(1 + 200 + 2);
			expect(written.at(-2)).toBe("warn 100 lines suppressed (more than 10 lines/s)");
			expect(written.at(-1)).toBe("info after");
			expect(captured).toHaveLength(301);
		});

		it("writes the suppressed count once lines are let through again", () => {
			silenceConsole();
			make().install(dir, "launch");
			for (let i = 0; i < 250; i += 1) console.warn(`frame ${i}`);
			vi.advanceTimersByTime(30_000);
			// 300 tokens came back over 30 s, capped at 200: the first line of this batch
			// is written along with the summary.
			console.warn("frame 250");

			expect(texts().slice(-2)).toEqual([
				"warn 50 lines suppressed (more than 10 lines/s)",
				"warn frame 250",
			]);
		});

		it("writes pending counts before the tail is read", () => {
			silenceConsole();
			const log = make();
			log.install(dir, "launch");
			console.warn("flood");
			console.warn("flood");

			expect(log.readTail(10_000)).toMatch(/warn last message repeated 1 time\n$/);
		});

		it("caps a single line", () => {
			silenceConsole();
			make().install(dir, "launch");
			console.info("x".repeat(70 * 1024));

			const written = lines()[1];
			expect(written).toMatch(/…\[truncated 6144 chars\]$/);
			expect(written.length).toBeLessThan(65 * 1024);
		});
	});

	it("install is idempotent", () => {
		silenceConsole();
		const log = make();
		log.install(dir, "launch");
		log.install(dir, "launch");
		console.info("once");

		expect(lines()).toHaveLength(2);
	});
});
