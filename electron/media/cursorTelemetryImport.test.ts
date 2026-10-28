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
		expect(mouseup).toMatchObject({ timeMs: 560, cx: 0.5, cy: 0.5 });
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
	});
});
