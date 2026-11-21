import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { browserCursorCaptureError } from "../../src/lib/browserCursorCapture";

const source = fs.readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
function execute(code: string, context: object) {
	runInNewContext(
		ts.transpileModule(code, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText,
		context,
	);
}
function stateFixture(platform = "linux") {
	const start = source.indexOf('ipcMain.handle(\n\t\t"set-recording-state",');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("\n\t);", start) + 5;
	const handle = vi.fn();
	const context = {
		ipcMain: { handle },
		process: { platform },
		browserCursorCaptureError,
		isWindowsUpdatePending: () => false,
		selectedSource: { name: "Chosen screen" },
		normalizeCursorCaptureMode: (mode: string) =>
			mode === "system" || mode === "editable-overlay" ? mode : undefined,
		setAppRecording: vi.fn(),
		startCursorRecording: vi.fn(async () => undefined),
		stopCursorRecording: vi.fn(async () => undefined),
	};
	execute(source.slice(start, end), context);
	return {
		context,
		invoke: handle.mock.calls[0][1] as (
			...args: unknown[]
		) => Promise<{ success: boolean; error?: string }>,
	};
}
describe("browser cursor main-process capability boundary", () => {
	it.each([
		true,
		false,
	])("refuses an editable browser start before reservation/sampler (reserve=%s)", async (reserve) => {
		const { context, invoke } = stateFixture();
		expect(await invoke({}, true, 123, "editable-overlay", reserve)).toMatchObject({
			success: false,
			error: expect.stringContaining("native Linux capture"),
		});
		expect(context.setAppRecording).not.toHaveBeenCalled();
		expect(context.startCursorRecording).not.toHaveBeenCalled();
		expect(context.stopCursorRecording).not.toHaveBeenCalled();
	});
	it("does not silently treat a missing mode as a supported editable take", async () => {
		const { context, invoke } = stateFixture();
		expect(await invoke({}, true)).toMatchObject({ success: false });
		expect(context.setAppRecording).not.toHaveBeenCalled();
	});
	it("still allows stop/cleanup regardless of the unsupported requested mode", async () => {
		const { context, invoke } = stateFixture();
		expect(await invoke({}, false, 123, "editable-overlay")).toMatchObject({ success: true });
		expect(context.stopCursorRecording).toHaveBeenCalledOnce();
	});
	it.each([
		["linux", "system"],
		["win32", "editable-overlay"],
		["darwin", "editable-overlay"],
	])("preserves %s %s recording", async (platform, mode) => {
		const { context, invoke } = stateFixture(platform);
		expect(await invoke({}, true, 123, mode)).toMatchObject({ success: true });
		expect(context.setAppRecording).toHaveBeenCalled();
		if (mode === "system") expect(context.startCursorRecording).not.toHaveBeenCalled();
		else expect(context.startCursorRecording).toHaveBeenCalledWith(123);
	});
});

function storeFixture() {
	const start = source.indexOf("async function storeRecordedSessionFiles(");
	const end = source.indexOf('\n\tipcMain.handle("store-recorded-video"', start);
	const context = {
		process: { platform: "linux" },
		browserCursorCaptureError,
		normalizeCursorCaptureMode: (mode: string) =>
			mode === "system" || mode === "editable-overlay" ? mode : undefined,
		resolveRecordingOutputPath: vi.fn((name: string) => `/rec/${name}`),
		finalizeRecordingFile: vi.fn(async () => false),
		recordingStreams: new Map(),
		stoppedBrowserCursorRecordings: new Map(),
		fs: { stat: vi.fn(async () => ({ size: 4096 })), writeFile: vi.fn(async () => undefined) },
		isValidDurationMs: () => false,
		pendingCursorRecordingData: { samples: [{ timeMs: 10 }] },
		cursorTelemetryRecordingId: 999,
		finalizeBrowserCursorTelemetry: vi.fn((data: unknown) => data),
		writePendingCursorTelemetry: vi.fn(async () => undefined),
		setCurrentRecordingSessionState: vi.fn(),
		currentProjectPath: null,
		RECORDINGS_DIR: "/rec",
		RECORDING_SESSION_SUFFIX: ".session.json",
		path,
		registerRecordingMediaLinks: vi.fn(async () => undefined),
		storeRecordedSessionFiles: undefined as unknown as (
			payload: object,
		) => Promise<{ success: boolean; error?: string; session?: { cursorCaptureMode: string } }>,
	};
	execute(source.slice(start, end), context);
	return context;
}
describe("browser store capability boundary", () => {
	it.each([
		"editable-overlay",
		undefined,
		"invalid",
	])("rejects unsupported/ambiguous mode %s before file or ownership changes", async (mode) => {
		const c = storeFixture();
		const owned = c.pendingCursorRecordingData;
		expect(
			await c.storeRecordedSessionFiles({
				screen: { fileName: "screen.webm" },
				cursorCaptureMode: mode,
			}),
		).toMatchObject({ success: false, error: expect.stringContaining("--cursor system") });
		expect(c.finalizeRecordingFile).not.toHaveBeenCalled();
		expect(c.fs.writeFile).not.toHaveBeenCalled();
		expect(c.setCurrentRecordingSessionState).not.toHaveBeenCalled();
		expect(c.pendingCursorRecordingData).toBe(owned);
		expect(c.cursorTelemetryRecordingId).toBe(999);
	});
	it("stores explicit system without attaching or clearing another take's pending telemetry", async () => {
		const c = storeFixture();
		const owned = c.pendingCursorRecordingData;
		expect(
			await c.storeRecordedSessionFiles({
				screen: { fileName: "screen.webm" },
				cursorCaptureMode: "system",
			}),
		).toMatchObject({ success: true, session: { cursorCaptureMode: "system" } });
		expect(c.writePendingCursorTelemetry).not.toHaveBeenCalled();
		expect(c.finalizeBrowserCursorTelemetry).not.toHaveBeenCalled();
		expect(c.pendingCursorRecordingData).toBe(owned);
	});
});
