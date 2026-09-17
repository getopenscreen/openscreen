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
});
