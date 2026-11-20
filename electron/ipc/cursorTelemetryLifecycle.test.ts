import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
	compactCursorTelemetryPauseRanges,
	finalizeBrowserCursorTelemetry,
} from "../native-bridge/cursor/recording/cursorPauseRanges";

const source = fs.readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");

// Execute the small registration in isolation: importing handlers.ts requires
// the complete Electron runtime, but a source-only assertion misses broken cleanup.
function fixture() {
	const start = source.indexOf('ipcMain.handle("discard-cursor-telemetry"');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("\n\t});", start) + 7;
	const handle = vi.fn();
	const context = {
		ipcMain: { handle },
		cursorTelemetryRecordingId: 7 as number | null,
		pendingCursorRecordingData: { samples: [1] } as unknown,
		stopCursorRecording: vi.fn(async () => undefined),
	};
	runInNewContext(source.slice(start, end).replace("recordingId: number", "recordingId"), context);
	return {
		context,
		discard: handle.mock.calls[0][1] as (event: unknown, id: number) => Promise<void>,
	};
}

describe("discard cursor telemetry IPC", () => {
	it("registers the preload channel and clears only the matching take after stopping", async () => {
		const { context, discard } = fixture();
		await discard({}, 7);
		expect(context.stopCursorRecording).toHaveBeenCalledTimes(1);
		expect(context.pendingCursorRecordingData).toBeNull();
		expect(context.cursorTelemetryRecordingId).toBeNull();
	});
	it("does not clear a newer take if stopping the old sampler yields", async () => {
		const { context, discard } = fixture();
		context.stopCursorRecording.mockImplementation(async () => {
			context.cursorTelemetryRecordingId = 8;
			context.pendingCursorRecordingData = { samples: [2] };
		});
		await discard({}, 7);
		expect(context.cursorTelemetryRecordingId).toBe(8);
		expect(context.pendingCursorRecordingData).toEqual({ samples: [2] });
	});

	it.each([6, NaN, Infinity])("ignores stale or invalid discard id %s", async (id) => {
		const { context, discard } = fixture();
		await discard({}, id);
		expect(context.stopCursorRecording).not.toHaveBeenCalled();
		expect(context.pendingCursorRecordingData).not.toBeNull();
		expect(context.cursorTelemetryRecordingId).toBe(7);
	});
	it("compacts and bounds the browser track before publishing its sidecar", () => {
		const body = source.slice(source.indexOf("async function storeRecordedSessionFiles"));
		expect(body.indexOf("finalizeBrowserCursorTelemetry(")).toBeLessThan(
			body.indexOf("await writePendingCursorTelemetry(screenVideoPath)"),
		);
		expect(body).toContain("payload.cursorPauseRanges");
		expect(body).toContain("payload.durationMs");
	});
});

function execute(code: string, context: object) {
	runInNewContext(
		ts.transpileModule(code, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText,
		context,
	);
}
function writeFixture() {
	const start = source.indexOf("async function writePendingCursorTelemetry(");
	const end = source.indexOf("\n}", start) + 2;
	const context = {
		fs: { writeFile: vi.fn(async (_path: string, _body: string, _encoding: string) => undefined) },
		pendingCursorRecordingData: { samples: [{ timeMs: 1 }] },
		cursorTelemetryRecordingId: 7 as number | null,
		writePendingCursorTelemetry: undefined as unknown as (path: string) => Promise<void>,
	};
	execute(source.slice(start, end), context);
	return { context, write: context.writePendingCursorTelemetry };
}
describe("sidecar write ownership", () => {
	it("does not clear a newer take during an in-flight write", async () => {
		const { context, write } = writeFixture();
		const old = context.pendingCursorRecordingData;
		const newer = { samples: [{ timeMs: 2 }] };
		context.fs.writeFile.mockImplementation(async () => {
			context.cursorTelemetryRecordingId = 8;
			context.pendingCursorRecordingData = newer;
		});
		await write("old.mp4");
		expect(JSON.parse(context.fs.writeFile.mock.calls[0][1])).toEqual(old);
		expect(context.pendingCursorRecordingData).toBe(newer);
		expect(context.cursorTelemetryRecordingId).toBe(8);
	});
	it("clears the completed take", async () => {
		const { context, write } = writeFixture();
		await write("old.mp4");
		expect(context.pendingCursorRecordingData).toBeNull();
		expect(context.cursorTelemetryRecordingId).toBeNull();
	});
	it("keeps data available if the write fails", async () => {
		const { context, write } = writeFixture();
		const data = context.pendingCursorRecordingData;
		context.fs.writeFile.mockRejectedValue(new Error("disk full"));
		await expect(write("old.mp4")).rejects.toThrow("disk full");
		expect(context.pendingCursorRecordingData).toBe(data);
		expect(context.cursorTelemetryRecordingId).toBe(7);
	});
});

describe("native Linux fallback timing", () => {
	it("starts the sampler on the helper pause-range clock, not picker or delayed sampler time", async () => {
		const start = source.indexOf("async function startCursorRecording(");
		const end = source.indexOf("\nasync function stopCursorRecording", start);
		const create = vi.fn((_options: { startTimeMs?: number }) => ({
			start: vi.fn(async () => undefined),
		}));
		const context = {
			cursorTelemetryRecordingId: null,
			linuxNativeCaptureSession: { cursorStartTimeMs: 1000 },
			isX11PointerFallbackEnabled: () => true,
			cursorRecordingSession: null,
			pendingCursorRecordingData: null,
			createX11PointerRecordingSession: create,
			getX11CaptureBounds: () => null,
			MAX_CURSOR_SAMPLES: 100,
			CURSOR_SAMPLE_INTERVAL_MS: 33,
			console: { info: vi.fn() },
			startCursorRecording: undefined as unknown as (id: number) => Promise<void>,
		};
		execute(source.slice(start, end), context);
		await context.startCursorRecording(100);
		expect(create.mock.calls[0][0]).toMatchObject({ startTimeMs: 1000 });
	});
	function fixture(mode = "editable-overlay", helperHasSamples = false) {
		const start = source.indexOf('ipcMain.handle("stop-native-linux-recording"');
		const end = source.indexOf("\n\t});", start) + 7;
		const handle = vi.fn();
		let finish!: () => void;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const cursor = {
			version: 2 as const,
			provider: "none" as const,
			assets: [],
			samples: (helperHasSamples ? [42] : []).map((timeMs) => ({ timeMs, cx: 0.5, cy: 0.5 })),
		};
		const result = {
			path: "/take.mp4",
			durationMs: 500,
			interrupted: false,
			cursor,
			cursorPauseRanges: [{ startMs: 200, endMs: 400 }],
		};
		const session = {
			stop: vi.fn(async () => {
				await done;
				return result;
			}),
			discard: vi.fn(),
		};
		const context = {
			ipcMain: { handle },
			linuxNativeCaptureSession: session,
			linuxNativeCaptureRecordingId: 7,
			linuxNativeCaptureCursorMode: mode,
			pendingCursorRecordingData: null as unknown,
			stopCursorRecording: vi.fn(async () => {
				context.pendingCursorRecordingData = {
					...cursor,
					samples: [100, 200, 300, 400, 500, 700, 701, 1500].map((timeMs) => ({
						timeMs,
						cx: 0.5,
						cy: 0.5,
					})),
				};
			}),
			fs: {
				writeFile: vi.fn(async (_path: string, _body: string) => undefined),
				rm: vi.fn(async () => undefined),
			},
			compactCursorTelemetryPauseRanges,
			finalizeBrowserCursorTelemetry,
			path,
			RECORDINGS_DIR: "/recordings",
			RECORDING_FILE_PREFIX: "recording-",
			RECORDING_SESSION_SUFFIX: ".json",
			setCurrentRecordingSessionState: vi.fn(),
			currentProjectPath: null,
			nativeRecordingWarning: null,
			mainT: () => "interrupted",
			formatDuration: () => "0:00",
			registerRecordingMediaLinks: vi.fn(),
			console: { info: vi.fn(), error: vi.fn() },
			linuxNativeCaptureSourceLabel: null,
			linuxSourceLabel: () => "screen",
			setAppRecording: vi.fn(),
		};
		execute(source.slice(start, end), context);
		return {
			context,
			session,
			finish,
			result,
			stop: handle.mock.calls[0][1] as (e: unknown, discard?: boolean) => Promise<unknown>,
		};
	}
	it("stops the sampler before helper teardown completes and bounds compacted samples to video", async () => {
		const { context, finish, stop } = fixture();
		const pending = stop({});
		const stoppedBeforeHelper = context.stopCursorRecording.mock.calls.length;
		finish();
		await pending;
		const call = context.fs.writeFile.mock.calls.find(([p]) => p.endsWith(".cursor.json"));
		expect(call).toBeDefined();
		expect(JSON.parse(call![1]).samples.map((s: { timeMs: number }) => s.timeMs)).toEqual([
			100, 300, 500,
		]);
		expect(stoppedBeforeHelper).toBe(1);
	});
	it("bounds interrupted takes and closes a pause still active at stop", async () => {
		const { context, finish, stop, result } = fixture();
		result.interrupted = true;
		result.cursorPauseRanges = [{ startMs: 200, endMs: 1500 }];
		result.durationMs = 200;
		const pending = stop({});
		finish();
		await pending;
		const call = context.fs.writeFile.mock.calls.find(([p]) => p.endsWith(".cursor.json"));
		expect(JSON.parse(call![1]).samples.map((s: { timeMs: number }) => s.timeMs)).toEqual([100]);
	});
	it.each([
		"system",
		"editable-overlay",
	])("starts a sampler only for editable native mode (%s)", async (mode) => {
		const nativeStart = source.indexOf('ipcMain.handle(\n\t\t"start-native-linux-recording"');
		expect(nativeStart).toBeGreaterThan(-1);
		const start = source.indexOf('if (cursorCaptureMode === "editable-overlay")', nativeStart);
		const end = source.indexOf("\n\t\t\t\treturn { success: true, recordingId", start);
		expect(end).toBeGreaterThan(start);
		const startCursorRecording = vi.fn();
		const context = { cursorCaptureMode: mode, startCursorRecording, recordingId: 7 };
		const code = `(async () => {${source.slice(start, end)}})()`;
		await runInNewContext(
			ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
			context,
		);
		expect(startCursorRecording).toHaveBeenCalledTimes(mode === "editable-overlay" ? 1 : 0);
	});

	it("prefers helper telemetry without re-compacting it", async () => {
		const { context, finish, stop } = fixture("editable-overlay", true);
		const pending = stop({});
		finish();
		await pending;
		const call = context.fs.writeFile.mock.calls.find(([p]) => p.endsWith(".cursor.json"));
		expect(JSON.parse(call![1]).samples.map((s: { timeMs: number }) => s.timeMs)).toEqual([42]);
	});
	it("system cursor publishes no editable sidecar", async () => {
		const { context, finish, stop } = fixture("system");
		const pending = stop({});
		finish();
		await pending;
		expect(context.fs.writeFile.mock.calls.some(([p]) => p.endsWith(".cursor.json"))).toBe(false);
	});
	it("discard publishes no sidecar and does not stop the helper for storage", async () => {
		const { context, session, stop } = fixture();
		await stop({}, true);
		expect(session.discard).toHaveBeenCalledOnce();
		expect(session.stop).not.toHaveBeenCalled();
		expect(context.fs.writeFile).not.toHaveBeenCalled();
	});
});

describe("final browser container cursor boundary", () => {
	it.each([
		1966,
		null,
	])("uses actual remux duration, or caller duration when unavailable: %s", async (mediaDuration) => {
		const store = source.indexOf("async function storeRecordedSessionFiles");
		const start = source.indexOf(
			'if (cursorCaptureMode !== "system" && pendingCursorRecordingData) {',
			store,
		);
		const end = source.indexOf(
			'\n\t\tif (cursorCaptureMode !== "system") await writePendingCursorTelemetry',
			start,
		);
		expect(start).toBeGreaterThan(store);
		expect(end).toBeGreaterThan(start);
		const context = {
			cursorCaptureMode: "editable-overlay",
			pendingCursorRecordingData: {
				version: 2,
				provider: "none",
				assets: [],
				samples: [0, 1951, 1966, 1985].map((timeMs) => ({ timeMs, cx: 0.5, cy: 0.5 })),
			},
			payload: { durationMs: 2058, cursorPauseRanges: [] },
			cursorDurationMs: mediaDuration ?? 2058,
			screenVideoPath: "/final.webm",
			readWebmDurationOnDisk: vi.fn(async () => mediaDuration),
			finalizeBrowserCursorTelemetry,
		};
		const code = `(async () => {${source.slice(start, end)}})()`;
		await runInNewContext(
			ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
			context,
		);
		expect(context.pendingCursorRecordingData.samples.map((s) => s.timeMs)).toEqual(
			mediaDuration === null ? [0, 1951, 1966, 1985] : [0, 1951, 1966],
		);
	});
});

describe("container repair returns the duration used by cursor finalization", () => {
	it.each([
		1966,
		null,
	])("returns measured remux duration or falls back when unknown: %s", async (measured) => {
		const start = source.indexOf("async function repairRecordingContainer(");
		const end = source.indexOf("\n}", start) + 2;
		const context = {
			reindexRecordingOnDisk: vi.fn(async () => ({
				reindexed: true,
				packets: 1,
				streams: 1,
				wallS: 0,
			})),
			readWebmDurationOnDisk: vi.fn(async () => measured),
			patchWebmDurationOnDisk: vi.fn(),
			console: { info: vi.fn() },
			path,
			repairRecordingContainer: undefined as unknown as (p: string, d: number) => Promise<number>,
		};
		execute(source.slice(start, end), context);
		expect(await context.repairRecordingContainer("/final.webm", 2058)).toBe(measured ?? 2058);
		expect(context.patchWebmDurationOnDisk).not.toHaveBeenCalled();
	});
	it("uses repair output only for screen duration, not webcam duration", () => {
		const start = source.indexOf("async function storeRecordedSessionFiles");
		const body = source.slice(start);
		const screen = body.indexOf("repairRecordingContainer(screenVideoPath");
		expect(body.slice(screen, body.indexOf("if (webcamStreamed", screen))).toContain(
			"cursorDurationMs = durationMs",
		);
		expect(body.indexOf("await Promise.all(patches)")).toBeLessThan(
			body.indexOf("finalizeBrowserCursorTelemetry("),
		);
	});
});
