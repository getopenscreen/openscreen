// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliRecordRunner } from "./CliRecordRunner";

const recorder = vi.hoisted(() => ({
	recording: false,
	saving: false,
	startRecordingImmediately: vi.fn(async () => undefined),
	toggleRecording: vi.fn(),
	setMicrophoneEnabled: vi.fn(),
	setMicrophoneDeviceId: vi.fn(),
	setMicrophoneDeviceName: vi.fn(),
	setSystemAudioEnabled: vi.fn(),
	setCursorCaptureMode: vi.fn(),
	setWebcamEnabled: vi.fn(async () => false),
	setWebcamDeviceId: vi.fn(),
	setWebcamDeviceName: vi.fn(),
	recordingPrefsLoaded: true,
	microphoneEnabled: false,
	webcamEnabled: false,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay" as const,
}));

vi.mock("@/hooks/useScreenRecorder", () => ({
	useScreenRecorder: () => recorder,
}));

const screenSource = {
	id: "screen:gone",
	name: "Display 1",
	display_id: "1",
	thumbnail: null,
	appIcon: null,
} satisfies ProcessedDesktopSource;

const request = {
	kind: "record" as const,
	displayIndex: 0,
	windowTitle: null,
	mic: false,
	micDevice: null,
	systemAudio: false,
	cursorMode: "editable-overlay" as const,
	durationMs: null,
	projectOut: null,
};

describe("CliRecordRunner", () => {
	beforeEach(() => {
		recorder.startRecordingImmediately.mockClear();
		recorder.toggleRecording.mockClear();
		window.electronAPI = {
			getPlatform: vi.fn(() => "win32"),
			isNativeLinuxCaptureAvailable: vi.fn(async () => ({ success: true, available: false })),
			cliGetRequest: vi.fn(async () => request),
			cliLog: vi.fn(),
			cliDone: vi.fn(async () => undefined),
			onCliStopRecording: vi.fn(() => () => undefined),
			getCurrentRecordingSession: vi.fn(async () => ({ success: false, session: null })),
			getSources: vi.fn(async () => [screenSource]),
			selectSource: vi.fn(async () => screenSource),
		} as unknown as typeof window.electronAPI;
	});

	it("fails immediately when selectSource returns null", async () => {
		vi.mocked(window.electronAPI.selectSource).mockResolvedValueOnce(null);
		render(<CliRecordRunner />);
		await waitFor(() => expect(window.electronAPI.cliDone).toHaveBeenCalled());
		expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
			expect.objectContaining({
				success: false,
				error: expect.stringContaining("openscreen sources"),
			}),
		);
		expect(recorder.startRecordingImmediately).not.toHaveBeenCalled();
		expect(recorder.toggleRecording).not.toHaveBeenCalled();
	});

	it("starts recording when the selected source is still available", async () => {
		render(<CliRecordRunner />);
		await waitFor(() => expect(recorder.startRecordingImmediately).toHaveBeenCalledTimes(1));
		expect(window.electronAPI.cliDone).not.toHaveBeenCalled();
	});

	it("keeps source selection for Linux without the native helper", async () => {
		vi.mocked(window.electronAPI.getPlatform).mockReturnValue("linux");
		render(<CliRecordRunner />);
		await waitFor(() => expect(recorder.startRecordingImmediately).toHaveBeenCalledTimes(1));
		expect(window.electronAPI.getSources).toHaveBeenCalledTimes(1);
		expect(window.electronAPI.selectSource).toHaveBeenCalledWith(screenSource, { persist: false });
	});

	it("reports missing sources in the browser fallback", async () => {
		vi.mocked(window.electronAPI.getPlatform).mockReturnValue("linux");
		vi.mocked(window.electronAPI.getSources).mockResolvedValueOnce([]);
		render(<CliRecordRunner />);
		await waitFor(() =>
			expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					error: expect.stringContaining("Display index 0 not found"),
				}),
			),
		);
		expect(recorder.startRecordingImmediately).not.toHaveBeenCalled();
	});

	it("lets the native Linux portal choose the source without Chromium enumeration", async () => {
		vi.mocked(window.electronAPI.getPlatform).mockReturnValue("linux");
		vi.mocked(window.electronAPI.isNativeLinuxCaptureAvailable).mockResolvedValue({
			success: true,
			available: true,
		});
		vi.mocked(window.electronAPI.getSources).mockResolvedValueOnce([]);
		render(<CliRecordRunner />);
		await waitFor(() => expect(recorder.startRecordingImmediately).toHaveBeenCalledTimes(1));
		expect(window.electronAPI.getSources).not.toHaveBeenCalled();
		expect(window.electronAPI.selectSource).not.toHaveBeenCalled();
		expect(window.electronAPI.cliDone).not.toHaveBeenCalled();
		expect(window.electronAPI.cliLog).toHaveBeenCalledWith(
			"info",
			expect.stringContaining("--window do not apply"),
		);
	});
});
