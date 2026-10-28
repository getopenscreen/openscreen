import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCursorImportCommand } from "./cursorCommands";

describe("runCursorImportCommand", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-cli-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("writes the sidecar and a human summary", async () => {
		const csvPath = path.join(dir, "mouse.csv");
		const videoPath = path.join(dir, "clip.mp4");
		await fs.writeFile(csvPath, "t,x,y\n0,10,20\n", "utf8");
		await fs.writeFile(videoPath, "v", "utf8");
		const lines: string[] = [];
		const code = await runCursorImportCommand(
			{
				csvPath,
				clicksPath: null,
				videoPath,
				outputPath: null,
				width: 100,
				height: 100,
				clickHoldMs: 60,
			},
			false,
			(text) => {
				lines.push(text);
			},
		);
		expect(code).toBe(0);
		expect(lines.join("")).toContain("Wrote ");
		expect(lines.join("")).toContain("samples=1");
		await expect(fs.stat(`${videoPath}.cursor.json`)).resolves.toMatchObject({
			size: expect.any(Number),
		});
	});

	it("emits JSON when asked", async () => {
		const csvPath = path.join(dir, "mouse.csv");
		await fs.writeFile(csvPath, "t,x,y\n0,1,2\n", "utf8");
		const outputPath = path.join(dir, "out.cursor.json");
		const lines: string[] = [];
		await runCursorImportCommand(
			{
				csvPath,
				clicksPath: null,
				videoPath: null,
				outputPath,
				width: 10,
				height: 10,
				clickHoldMs: 60,
			},
			true,
			(text) => {
				lines.push(text);
			},
		);
		const payload = JSON.parse(lines.join(""));
		expect(payload).toMatchObject({ event: "done", success: true, outputPath, samples: 1 });
	});
});
