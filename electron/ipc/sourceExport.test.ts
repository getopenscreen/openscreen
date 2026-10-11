import { EventEmitter } from "node:events";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dialog: vi.fn(),
	probe: vi.fn(),
	audio: vi.fn(),
	srt: vi.fn(),
	unused: vi.fn(),
}));
vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => null } }));
vi.mock("../messageBox", () => ({ showSaveDialogOver: mocks.dialog }));
vi.mock("../media/sourceExport", () => ({
	inspectSourceAudio: mocks.probe,
	exportSourceAudioFile: mocks.audio,
	exportSourceSrtFile: mocks.srt,
	unusedExportPath: mocks.unused,
	sourceAudioExtension: (format: string) => (format === "original" ? "m4a" : format),
}));

import { registerSourceExportHandlers } from "./sourceExport";

function setup() {
	const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
	const approve = vi.fn((value: string) => (value === "/source.mp4" ? value : null));
	registerSourceExportHandlers(
		{
			handle: (name, callback) => {
				handlers.set(name, callback);
			},
		},
		approve,
	);
	const sender = Object.assign(new EventEmitter(), { id: 1 });
	const event = { sender } as unknown as IpcMainInvokeEvent;
	return { sender, call: (name: string, request?: unknown) => handlers.get(name)!(event, request) };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.probe.mockResolvedValue("aac");
	mocks.unused.mockResolvedValue("/source-audio.m4a");
	mocks.audio.mockResolvedValue(undefined);
	mocks.srt.mockResolvedValue(undefined);
	mocks.dialog.mockResolvedValue({ canceled: false, filePath: "/export.m4a" });
});

describe("source export IPC boundary", () => {
	it("rejects unknown paths and invalid formats without reading them or showing a dialog", async () => {
		const { call } = setup();
		expect(
			await call("source-audio:export", { sourcePath: "/secret.mp4", format: "wav" }),
		).toMatchObject({ success: false });
		expect(
			await call("source-audio:export", { sourcePath: "/source.mp4", format: "exe" }),
		).toMatchObject({ success: false });
		expect(await call("source-audio:export", null)).toMatchObject({ success: false });
		expect(mocks.probe).not.toHaveBeenCalled();
		expect(mocks.dialog).not.toHaveBeenCalled();
	});
	it("returns save-panel cancellation and leaves all files alone", async () => {
		mocks.dialog.mockResolvedValue({ canceled: true });
		const { call } = setup();
		expect(
			await call("source-audio:export", { sourcePath: "/source.mp4", format: "original" }),
		).toEqual({ success: false, canceled: true });
		expect(mocks.audio).not.toHaveBeenCalled();
	});
	it("writes only the native save-panel target and releases the active slot", async () => {
		const { call, sender } = setup();
		const request = { sourcePath: "/source.mp4", format: "original", outputPath: "/injected" };
		expect(await call("source-audio:export", request)).toEqual({
			success: true,
			path: "/export.m4a",
		});
		expect(mocks.audio).toHaveBeenCalledWith(
			{ sourcePath: "/source.mp4", outputPath: "/export.m4a", format: "original", codec: "aac" },
			{ signal: expect.any(AbortSignal) },
		);
		expect(sender.listenerCount("destroyed")).toBe(0);
		expect(await call("source-audio:export", request)).toMatchObject({ success: true });
	});
	it.each([
		"source-audio:cancel",
		"destroyed",
	])("cancels on %s and refuses concurrent exports in the same window", async (trigger) => {
		let entered: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			entered = resolve;
		});
		mocks.audio.mockImplementation(
			(_request, { signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
					entered?.();
				}),
		);
		const { call, sender } = setup();
		const work = call("source-audio:export", { sourcePath: "/source.mp4", format: "wav" });
		await pending;
		expect(
			await call("source-audio:export", { sourcePath: "/source.mp4", format: "wav" }),
		).toMatchObject({ success: false, error: expect.stringContaining("already running") });
		if (trigger === "destroyed") sender.emit("destroyed");
		else await call(trigger);
		expect(await work).toEqual({ success: false, canceled: true });
	});
	it("validates SRT bytes/structure before the native save dialog", async () => {
		const { call } = setup();
		for (const srtText of ["not SRT", "x".repeat(5 * 1024 * 1024 + 1)]) {
			expect(await call("source-srt:export", { sourcePath: "/source.mp4", srtText })).toMatchObject(
				{ success: false },
			);
		}
		expect(mocks.dialog).not.toHaveBeenCalled();
	});
	it("exports valid Traditional Chinese SRT without touching transcription providers", async () => {
		const { call } = setup();
		mocks.dialog.mockResolvedValue({ canceled: false, filePath: "/export.srt" });
		const srtText = "1\n00:00:01,000 --> 00:00:02,000\n繁體字幕\n";
		expect(await call("source-srt:export", { sourcePath: "/source.mp4", srtText })).toEqual({
			success: true,
			path: "/export.srt",
		});
		expect(mocks.srt).toHaveBeenCalledWith("/source.mp4", "/export.srt", srtText);
		expect(mocks.probe).not.toHaveBeenCalled();
	});
	it("uses a distinct default name for timeline subtitles while keeping the real approved source path", async () => {
		const { call } = setup();
		mocks.dialog.mockResolvedValue({ canceled: false, filePath: "/timeline.srt" });
		await call("source-srt:export", {
			sourcePath: "/source.mp4",
			srtText: "1\n00:00:00,000 --> 00:00:01,000\nText",
			scope: "timeline",
		});
		expect(mocks.unused).toHaveBeenCalledWith("/source.mp4", "-timeline-subtitles", "srt");
	});
});
