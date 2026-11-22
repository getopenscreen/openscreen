import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
	compactCursorTelemetryPauseRanges,
	finalizeSampledCursorTelemetry,
} from "../native-bridge/cursor/recording/cursorPauseRanges";

const source = fs.readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");

function execute(code: string, context: object) {
	runInNewContext(
		ts.transpileModule(code, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText,
		context,
	);
}

describe("native Linux fallback timing", () => {
	it("starts the sampler on the helper pause-range clock, not picker or delayed sampler time", async () => {
		const start = source.indexOf("async function startCursorRecording(");
		const end = source.indexOf("\nasync function stopCursorRecording", start);
		const create = vi.fn((_options: { startTimeMs?: number }) => ({
			start: vi.fn(async () => undefined),
		}));
		const context = {
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
			finalizeSampledCursorTelemetry,
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
