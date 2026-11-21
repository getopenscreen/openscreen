import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { StoreRecordedSessionInput } from "../../src/lib/recordingSession";
import { finalizeBrowserCursorTelemetry } from "../native-bridge/cursor/recording/cursorPauseRanges";

const source = fs.readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
function execute(code: string, context: object) {
	runInNewContext(
		ts.transpileModule(code, {
			compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
		}).outputText,
		context,
	);
}
function data(timeMs: number) {
	return {
		version: 2 as const,
		provider: "none" as const,
		assets: [],
		samples: [{ timeMs, cx: 0.5, cy: 0.5 }],
	};
}
function fixture() {
	const a = data(100);
	const b = data(200);
	let release!: () => void;
	const disk = new Promise<void>((done) => {
		release = done;
	});
	const context = {
		pendingCursorRecordingData: a as ReturnType<typeof data> | null,
		cursorTelemetryRecordingId: 7 as number | null,
		stoppedBrowserCursorRecordings: new Map([[7, a]]),
		fs: {
			writeFile: vi.fn(async (_p: string, _b: string, _encoding?: string) => undefined),
			stat: vi.fn(async () => ({ size: 2048 })),
		},
		normalizeCursorCaptureMode: (mode: string) => mode,
		browserCursorCaptureError: () => null,
		process: { platform: "win32" },
		resolveRecordingOutputPath: (name: string) => path.join("/recordings", name),
		finalizeRecordingFile: vi.fn(async () => {
			await disk;
			return false;
		}),
		recordingStreams: new Map(),
		isValidDurationMs: () => false,
		finalizeBrowserCursorTelemetry,
		setCurrentRecordingSessionState: vi.fn(),
		currentProjectPath: null,
		path,
		RECORDINGS_DIR: "/recordings",
		RECORDING_SESSION_SUFFIX: ".json",
		registerRecordingMediaLinks: vi.fn(),
		storeRecordedSessionFiles: undefined as unknown as (
			input: StoreRecordedSessionInput,
		) => Promise<unknown>,
	};
	let start = source.indexOf("async function writePendingCursorTelemetry(");
	execute(source.slice(start, source.indexOf("\n}", start) + 2), context);
	start = source.indexOf("async function storeRecordedSessionFiles(");
	execute(source.slice(start, source.indexOf("\n\t}", start) + 3), context);
	const input: StoreRecordedSessionInput = {
		screen: { fileName: "recording-7.webm", videoData: new ArrayBuffer(0) },
		createdAt: 7,
		cursorCaptureMode: "editable-overlay",
		durationMs: 500,
	};
	return {
		context,
		a,
		b,
		release,
		save: (overrides: Partial<StoreRecordedSessionInput> = {}) =>
			context.storeRecordedSessionFiles({ ...input, ...overrides }),
	};
}

describe("browser telemetry belongs to the stopped take", () => {
	it.each([
		"started",
		"stopped",
	])("saves A's cursor when B has %s while A finalizes", async (state) => {
		const { context, a, b, release, save } = fixture();
		const pending = save();
		context.cursorTelemetryRecordingId = 8;
		context.pendingCursorRecordingData = state === "started" ? null : b;
		if (state === "stopped") context.stoppedBrowserCursorRecordings.set(8, b);
		release();
		await pending;
		const write = context.fs.writeFile.mock.calls.find(([file]) => file.endsWith(".cursor.json"));
		expect(write).toBeDefined();
		expect(JSON.parse(write![1])).toEqual(a);
		expect(context.stoppedBrowserCursorRecordings.has(7)).toBe(false);
		expect(context.cursorTelemetryRecordingId).toBe(8);
		expect(context.pendingCursorRecordingData).toBe(state === "started" ? null : b);
		if (state === "stopped") expect(context.stoppedBrowserCursorRecordings.get(8)).toBe(b);
	});
	it("never borrows an unmatched take's cursor", async () => {
		const { context, a, release, save } = fixture();
		release();
		await save({ createdAt: 9 });
		expect(
			context.fs.writeFile.mock.calls.filter(([file]) => file.endsWith(".cursor.json")),
		).toEqual([]);
		expect(context.stoppedBrowserCursorRecordings.get(7)).toBe(a);
		expect(context.pendingCursorRecordingData).toBe(a);
	});
	it("keeps the owned raw samples if the sidecar write fails", async () => {
		const { context, a, release, save } = fixture();
		context.fs.writeFile.mockRejectedValueOnce(new Error("disk full"));
		release();
		await expect(save()).rejects.toThrow("disk full");
		expect(context.stoppedBrowserCursorRecordings.get(7)).toBe(a);
	});
	it("does not write telemetry in deliberate system mode", async () => {
		const { context, release, save } = fixture();
		release();
		await save({ cursorCaptureMode: "system" });
		expect(
			context.fs.writeFile.mock.calls.filter(([file]) => file.endsWith(".cursor.json")),
		).toEqual([]);
	});
	it("retains the stopped browser session by original ID even if another sampler starts", async () => {
		const a = data(100);
		const b = data(200);
		let release!: (value: typeof a) => void;
		const session = {
			stop: () =>
				new Promise<typeof a>((done) => {
					release = done;
				}),
		};
		const context = {
			cursorRecordingSession: session,
			cursorTelemetryRecordingId: 7,
			pendingCursorRecordingData: b,
			stoppedBrowserCursorRecordings: new Map<number, typeof a>(),
			console,
			stopCursorRecording: undefined as unknown as (retain: boolean) => Promise<void>,
		};
		const start = source.indexOf("async function stopCursorRecording(");
		execute(
			source.slice(start, source.indexOf("\nasync function writePendingCursorTelemetry", start)),
			context,
		);
		const stopped = context.stopCursorRecording(true);
		context.cursorRecordingSession = { stop: async () => b };
		context.cursorTelemetryRecordingId = 8;
		release(a);
		await stopped;
		expect(context.stoppedBrowserCursorRecordings.get(7)).toBe(a);
		expect(context.pendingCursorRecordingData).toBe(b);
		expect(context.cursorTelemetryRecordingId).toBe(8);
	});
	it("discards an old retained take without stopping or deleting the newer one", async () => {
		const a = data(100);
		const b = data(200);
		const handle = vi.fn();
		const context = {
			ipcMain: { handle },
			cursorTelemetryRecordingId: 8,
			pendingCursorRecordingData: b,
			stoppedBrowserCursorRecordings: new Map([
				[7, a],
				[8, b],
			]),
			stopCursorRecording: vi.fn(async () => undefined),
		};
		const start = source.indexOf('ipcMain.handle("discard-cursor-telemetry"');
		execute(source.slice(start, source.indexOf("\n\t});", start) + 7), context);
		await handle.mock.calls[0][1]({}, 7);
		expect(context.stoppedBrowserCursorRecordings.has(7)).toBe(false);
		expect(context.stoppedBrowserCursorRecordings.get(8)).toBe(b);
		expect(context.stopCursorRecording).not.toHaveBeenCalled();
		expect(context.pendingCursorRecordingData).toBe(b);
	});
});
