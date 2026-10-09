import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN = path.join(ROOT, "dist-electron/main.js");
const FIXTURE = path.join(ROOT, "tests/fixtures/sample.webm");

test("CLI edit saves only on Done and returns the edited document without rendering", async () => {
	const testInfo = test.info();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-cli-edit-e2e-"));
	const source = path.join(root, "take.webm");
	fs.copyFileSync(FIXTURE, source);
	const input = path.join(root, "take.openscreen");
	const output = path.join(root, "edited.openscreen");
	const original = JSON.stringify({
		version: 2,
		media: { screenVideoPath: source, cursorCaptureMode: "system" },
		editor: {},
	});
	fs.writeFileSync(input, original);
	const app = await electron.launch({
		args: [
			MAIN,
			"--no-sandbox",
			"--lang=en-US",
			`--user-data-dir=${path.join(root, "profile")}`,
			"edit",
			input,
			"--out",
			output,
			"--json",
		],
		env: { ...process.env, OPENSCREEN_COMPOSITOR_BACKEND: "cpu", OPENSCREEN_PREVIEW_READBACK: "1" },
	});
	const child = app.process();
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	try {
		const page = await app.firstWindow();
		await expect(page.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
		expect(fs.existsSync(output)).toBe(false);
		expect(fs.readFileSync(input, "utf8")).toBe(original);
		// Rename through the actual editor controls; its native save must drain
		// before the Done snapshot is committed.
		await page.getByRole("button", { name: "Rename project" }).click();
		const title = page.locator("header input");
		await title.fill("Edited take");
		await title.press("Enter");
		await page.getByRole("button", { name: "Edit clip", exact: true }).click();
		const clipDialog = page.getByRole("dialog", { name: "Edit clip" });
		await clipDialog.getByRole("button", { name: "1:1", exact: true }).click();
		const track = await clipDialog.getByTestId("edit-clip-trim-track").boundingBox();
		const endGrip = await clipDialog.getByRole("button", { name: "Adjust clip end" }).boundingBox();
		expect(track).not.toBeNull();
		expect(endGrip).not.toBeNull();
		await page.mouse.move(endGrip!.x + endGrip!.width / 2, endGrip!.y + endGrip!.height / 2);
		await page.mouse.down();
		await page.mouse.move(track!.x + track!.width * 0.75, endGrip!.y + endGrip!.height / 2);
		await page.mouse.up();
		await clipDialog.getByRole("button", { name: "Apply", exact: true }).click();
		// Read-back preview must paint a native frame, not just the CSS wallpaper.
		await expect
			.poll(
				() =>
					page.getByTestId("native-compositor-mount").evaluate((element) => {
						const canvas = element as HTMLCanvasElement;
						const ctx = canvas.getContext("2d");
						return ctx && canvas.width > 1 && canvas.height > 1
							? ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
									.data[3]
							: 0;
					}),
				{ timeout: 15_000 },
			)
			.toBeGreaterThan(0);
		await page.screenshot({ path: testInfo.outputPath("edited-project.png") });
		const exited = once(child, "exit");
		await page.getByRole("button", { name: "Done", exact: true }).click();
		expect(await exited, stderr).toEqual([0, null]);
		const document = JSON.parse(fs.readFileSync(output, "utf8"));
		expect(document.project.title).toBe("Edited take");
		expect(document.timeline.clips[0].cropRegion).toBeDefined();
		expect(document.timeline.clips[0].sourceEndSec).toBeLessThan(document.assets[0].durationSec);
		expect(fs.readFileSync(input, "utf8")).toBe(original);
		expect(stdout).toContain('"success":true');
		expect(stdout).toContain(JSON.stringify(output));
		expect(
			fs.readdirSync(root).some((file) => file.endsWith(".mp4") || file.endsWith(".gif")),
		).toBe(false);
	} finally {
		if (child.exitCode === null) await app.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("closing CLI edit cancels and leaves an in-place input byte-for-byte unchanged", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-cli-edit-cancel-"));
	const source = path.join(root, "take.webm");
	fs.copyFileSync(FIXTURE, source);
	const input = path.join(root, "take.openscreen");
	const original = JSON.stringify({ version: 2, media: { screenVideoPath: source }, editor: {} });
	fs.writeFileSync(input, original);
	const app = await electron.launch({
		args: [
			MAIN,
			"--no-sandbox",
			"--lang=en-US",
			`--user-data-dir=${path.join(root, "profile")}`,
			"edit",
			input,
			"--json",
		],
		env: { ...process.env, OPENSCREEN_COMPOSITOR_BACKEND: "cpu", OPENSCREEN_PREVIEW_READBACK: "1" },
	});
	const child = app.process();
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	try {
		const page = await app.firstWindow();
		await expect(page.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
		const exited = once(child, "exit");
		await app.evaluate(({ BrowserWindow }) => {
			setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 10);
		});
		expect(await exited, stderr).toEqual([1, null]);
		expect(fs.readFileSync(input, "utf8")).toBe(original);
		expect(stdout).toContain('"canceled":true');
	} finally {
		if (child.exitCode === null) await app.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a failed output write keeps CLI edit open for a successful retry", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-cli-edit-retry-"));
	const source = path.join(root, "take.webm");
	fs.copyFileSync(FIXTURE, source);
	const input = path.join(root, "take.openscreen");
	fs.writeFileSync(
		input,
		JSON.stringify({ version: 2, media: { screenVideoPath: source }, editor: {} }),
	);
	const output = path.join(root, "output.openscreen");
	// A directory at the requested output path reliably refuses publication on every OS.
	fs.mkdirSync(output);
	const app = await electron.launch({
		args: [
			MAIN,
			"--no-sandbox",
			"--lang=en-US",
			`--user-data-dir=${path.join(root, "profile")}`,
			"edit",
			input,
			"-o",
			output,
			"--json",
		],
		env: { ...process.env, OPENSCREEN_COMPOSITOR_BACKEND: "cpu", OPENSCREEN_PREVIEW_READBACK: "1" },
	});
	const child = app.process();
	try {
		const page = await app.firstWindow();
		const done = page.getByRole("button", { name: "Done", exact: true });
		await expect(done).toBeEnabled();
		await done.click();
		await expect(page.getByText("Could not finish editing", { exact: true })).toBeVisible();
		await expect(done).toBeEnabled();
		expect(child.exitCode).toBeNull();
		fs.rmdirSync(output);
		const exited = once(child, "exit");
		await done.click();
		expect(await exited).toEqual([0, null]);
		expect(JSON.parse(fs.readFileSync(output, "utf8")).schemaVersion).toBe(8);
	} finally {
		if (child.exitCode === null && child.signalCode === null) await app.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
