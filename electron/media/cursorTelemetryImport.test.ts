import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCursorRecordingFileAt } from "./cursorSidecar";
import {
	buildCursorSidecar,
	parseClickTimestamps,
	parseMouseCsv,
	writeCursorSidecarFromCsv,
} from "./cursorTelemetryImport";

describe("cursorTelemetryImport", () => {
	it("parses t,x,y and time,x,y headers", () => {
		expect(parseMouseCsv("t,x,y\n0,10,20\n0.5,30,40\n")).toEqual([
			{ t: 0, x: 10, y: 20 },
			{ t: 0.5, x: 30, y: 40 },
		]);
		expect(parseMouseCsv("time,x,y\n1,2,3\n")).toEqual([{ t: 1, x: 2, y: 3 }]);
		expect(parseMouseCsv('"t","x","y"\n"1","2","3"\n')).toEqual([{ t: 1, x: 2, y: 3 }]);
	});

	it("rejects a CSV with no time column", () => {
		expect(() => parseMouseCsv("x,y\n10,20\n")).toThrow(/t \(or time \/ time_s\)/);
	});

	it("skips rows with empty numeric cells", () => {
		expect(parseMouseCsv("t,x,y\n1,,25\n2,10,20\n")).toEqual([{ t: 2, x: 10, y: 20 }]);
	});

	it("parses click timestamps, skipping comments", () => {
		expect(parseClickTimestamps("# hold\n1.5\n2.0,extra\n")).toEqual([1.5, 2]);
	});

	it("builds a version-2 sidecar with normalised coords and click/mouseup pairs", () => {
		const data = buildCursorSidecar({
			mouse: [
				{ t: 0, x: 0, y: 0 },
				{ t: 1, x: 1920, y: 1080 },
			],
			clicks: [0.5],
			width: 1920,
			height: 1080,
			clickHoldMs: 60,
		});
		expect(data.version).toBe(2);
		expect(data.provider).toBe("none");
		const click = data.samples.find((sample) => sample.interactionType === "click");
		const mouseup = data.samples.find((sample) => sample.interactionType === "mouseup");
		expect(click).toMatchObject({ timeMs: 500, cx: 0.5, cy: 0.5 });
		expect(mouseup).toMatchObject({ timeMs: 560, cx: 0.56, cy: 0.56 });
		expect(data.samples.filter((sample) => sample.interactionType === "click")).toHaveLength(1);
		expect(data.samples.filter((sample) => sample.interactionType === "mouseup")).toHaveLength(1);
	});

	it("places a click-only import at the capture centre", () => {
		const data = buildCursorSidecar({
			mouse: [],
			clicks: [1],
			width: 1920,
			height: 1080,
			clickHoldMs: 60,
		});
		expect(data.samples).toEqual([
			expect.objectContaining({ timeMs: 1000, cx: 0.5, cy: 0.5, interactionType: "click" }),
			expect.objectContaining({ timeMs: 1060, cx: 0.5, cy: 0.5, interactionType: "mouseup" }),
		]);
	});
});

describe("writeCursorSidecarFromCsv", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-import-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("writes <video>.cursor.json that the production reader accepts", async () => {
		const csvPath = path.join(dir, "mouse.csv");
		const clicksPath = path.join(dir, "clicks.txt");
		const videoPath = path.join(dir, "take.mp4");
		await fs.writeFile(csvPath, "t,x,y\n0,96,54\n1,192,108\n", "utf8");
		await fs.writeFile(clicksPath, "0.5\n", "utf8");
		await fs.writeFile(videoPath, "fake", "utf8");

		const { outputPath, data } = await writeCursorSidecarFromCsv({
			csvPath,
			clicksPath,
			videoPath,
			width: 1920,
			height: 1080,
		});

		expect(outputPath).toBe(`${videoPath}.cursor.json`);
		expect(data.samples.length).toBeGreaterThan(2);
		const loaded = await readCursorRecordingFileAt(outputPath);
		expect(loaded.samples.some((sample) => sample.interactionType === "click")).toBe(true);
		const click = loaded.samples.find((sample) => sample.interactionType === "click");
		expect(click?.cx).toBeCloseTo(0.075);
		expect(click?.cy).toBeCloseTo(0.075);
	});

	it("writes --output without a video path", async () => {
		const csvPath = path.join(dir, "mouse.csv");
		const outputPath = path.join(dir, "sidecar.cursor.json");
		await fs.writeFile(csvPath, "t,x,y\n0,10,20\n", "utf8");
		const { data } = await writeCursorSidecarFromCsv({
			csvPath,
			outputPath,
			width: 100,
			height: 100,
		});
		expect(data.samples[0]).toMatchObject({ cx: 0.1, cy: 0.2 });
		await expect(fs.readFile(outputPath, "utf8")).resolves.toContain('"cx": 0.1');
	});

	it("rejects an empty import before writing", async () => {
		const csvPath = path.join(dir, "mouse.csv");
		const outputPath = path.join(dir, "out.cursor.json");
		await fs.writeFile(csvPath, "t,x,y\n", "utf8");
		await fs.writeFile(outputPath, "keep-me", "utf8");
		await expect(
			writeCursorSidecarFromCsv({ csvPath, outputPath, width: 1920, height: 1080 }),
		).rejects.toThrow(/no samples/);
		await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("keep-me");
	});

	it("rejects an --output path that matches --csv", async () => {
		const csvPath = path.join(dir, "mouse.csv");
		await fs.writeFile(csvPath, "t,x,y\n0,1,2\n", "utf8");
		await expect(
			writeCursorSidecarFromCsv({
				csvPath,
				outputPath: csvPath,
				width: 10,
				height: 10,
			}),
		).rejects.toThrow(/same path as --csv/);
		await expect(fs.readFile(csvPath, "utf8")).resolves.toBe("t,x,y\n0,1,2\n");
	});
});
