// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingStartOutcome } from "@/hooks/useScreenRecorder";
import { CliRecordRunner } from "./CliRecordRunner";

const recorder = vi.hoisted(() => ({
	recording: false,
	saving: false,
	startRecordingImmediately: vi.fn(
		async (): Promise<RecordingStartOutcome> => ({
			kind: "started",
		}),
	),
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
	camera: false,
	cameraDevice: null as string | null,
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

	it("turns the camera on when asked, and fails when it cannot", async () => {
		vi.mocked(window.electronAPI.cliGetRequest).mockResolvedValueOnce({ ...request, camera: true });
		recorder.setWebcamEnabled.mockClear();
		render(<CliRecordRunner />);
		await waitFor(() =>
			expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					error: expect.stringContaining("camera could not be turned on"),
				}),
			),
		);
		expect(recorder.setWebcamEnabled).toHaveBeenCalledWith(true);
		expect(recorder.startRecordingImmediately).not.toHaveBeenCalled();
	});

	it("fails, and stops the starting capture, when the camera turns on but cannot be opened", async () => {
		vi.mocked(window.electronAPI.cliGetRequest).mockResolvedValueOnce({ ...request, camera: true });
		recorder.setWebcamEnabled.mockImplementationOnce(async () => {
			recorder.webcamEnabled = true;
			return true;
		});
		try {
			const { rerender } = render(<CliRecordRunner />);
			await waitFor(() => expect(recorder.startRecordingImmediately).toHaveBeenCalledTimes(1));
			// The acquire failed (another app holds the camera): the recorder turns it back off.
			recorder.webcamEnabled = false;
			rerender(<CliRecordRunner />);
			await waitFor(() =>
				expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
					expect.objectContaining({
						success: false,
						error: expect.stringContaining("camera could not be opened"),
					}),
				),
			);
			recorder.recording = true;
			rerender(<CliRecordRunner />);
			await waitFor(() => expect(recorder.toggleRecording).toHaveBeenCalledTimes(1));
			expect(window.electronAPI.cliLog).not.toHaveBeenCalledWith("info", "Recording started");
		} finally {
			recorder.webcamEnabled = false;
			recorder.recording = false;
		}
	});

	describe("camera with no name", () => {
		const cameras = [
			{ kind: "videoinput", deviceId: "cam-vcam", label: "VCam Camera" },
			{ kind: "videoinput", deviceId: "cam-streamcam", label: "Logitech StreamCam" },
		];
		const runWith = async (prefs: { camDeviceId: string | null; camDeviceName: string | null }) => {
			Object.defineProperty(navigator, "mediaDevices", {
				configurable: true,
				value: { enumerateDevices: vi.fn(async () => cameras) },
			});
			window.electronAPI.getRecordingPrefs = vi.fn(async () => prefs) as never;
			vi.mocked(window.electronAPI.cliGetRequest).mockResolvedValueOnce({
				...request,
				camera: true,
			});
			recorder.setWebcamDeviceId.mockClear();
			render(<CliRecordRunner />);
			await waitFor(() => expect(recorder.setWebcamDeviceId).toHaveBeenCalled());
			return recorder.setWebcamDeviceId.mock.calls[0]?.[0];
		};

		it("records the camera the user picked in OpenScreen, not the first one listed", async () => {
			expect(await runWith({ camDeviceId: "cam-streamcam", camDeviceName: null })).toBe(
				"cam-streamcam",
			);
		});

		it("finds the picked camera by its name when its id changed", async () => {
			expect(await runWith({ camDeviceId: "stale", camDeviceName: "Logitech StreamCam" })).toBe(
				"cam-streamcam",
			);
		});

		it("leaves the choice to the system when the picked camera is gone", async () => {
			expect(await runWith({ camDeviceId: "gone", camDeviceName: "Gone" })).toBeUndefined();
		});
	});

	it("leaves the camera off unless asked", async () => {
		recorder.setWebcamEnabled.mockClear();
		render(<CliRecordRunner />);
		await waitFor(() => expect(recorder.startRecordingImmediately).toHaveBeenCalledTimes(1));
		expect(recorder.setWebcamEnabled).toHaveBeenCalledWith(false);
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

	describe("the start outcome", () => {
		const METADATA_FAILURE =
			"The ScreenCast portal does not advertise METADATA cursor mode, so real cursor positions cannot be obtained on this session.";

		it("fails a cursor-metadata start immediately, with the retry advice", async () => {
			recorder.startRecordingImmediately.mockResolvedValueOnce({
				kind: "failed",
				message: METADATA_FAILURE,
			});
			render(<CliRecordRunner />);
			await waitFor(() =>
				expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
					expect.objectContaining({
						success: false,
						error: expect.stringContaining(`${METADATA_FAILURE} Retry with "cursor": "system"`),
					}),
				),
			);
		});

		it("reports another failure without the cursor advice", async () => {
			recorder.startRecordingImmediately.mockResolvedValueOnce({
				kind: "failed",
				message: "Native Linux capture failed.",
			});
			render(<CliRecordRunner />);
			await waitFor(() =>
				expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
					expect.objectContaining({
						success: false,
						error: expect.not.stringContaining("Retry with"),
					}),
				),
			);
		});

		it("fails immediately when the picker was dismissed", async () => {
			recorder.startRecordingImmediately.mockResolvedValueOnce({ kind: "cancelled" });
			render(<CliRecordRunner />);
			await waitFor(() =>
				expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
					expect.objectContaining({
						success: false,
						error: expect.stringContaining("picker was dismissed"),
					}),
				),
			);
		});

		it("lets the camera failure win when both it and the start fail", async () => {
			vi.mocked(window.electronAPI.cliGetRequest).mockResolvedValueOnce({
				...request,
				camera: true,
			});
			recorder.setWebcamEnabled.mockImplementationOnce(async () => {
				recorder.webcamEnabled = true;
				return true;
			});
			let answerStart: (outcome: RecordingStartOutcome) => void = () => undefined;
			recorder.startRecordingImmediately.mockImplementationOnce(
				() =>
					new Promise<RecordingStartOutcome>((resolve) => {
						answerStart = resolve;
					}),
			);
			try {
				const { rerender } = render(<CliRecordRunner />);
				await waitFor(() => expect(recorder.startRecordingImmediately).toHaveBeenCalledTimes(1));
				// The camera turns back off before the start answers: its error wins, one cliDone.
				recorder.webcamEnabled = false;
				rerender(<CliRecordRunner />);
				await waitFor(() =>
					expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
						expect.objectContaining({
							success: false,
							error: expect.stringContaining("camera could not be opened"),
						}),
					),
				);
				answerStart({ kind: "failed", message: "Native Linux capture failed." });
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(window.electronAPI.cliDone).toHaveBeenCalledTimes(1);
			} finally {
				recorder.webcamEnabled = false;
				recorder.recording = false;
			}
		});

		it("keeps a backstop for a start that reports success but never confirms", async () => {
			vi.useFakeTimers();
			try {
				render(<CliRecordRunner />);
				await vi.waitFor(() => expect(recorder.startRecordingImmediately).toHaveBeenCalledTimes(1));
				// `recording` never flips: only the backstop can say so.
				await vi.advanceTimersByTimeAsync(30_000);
				expect(window.electronAPI.cliDone).toHaveBeenCalledWith(
					expect.objectContaining({
						success: false,
						error: expect.stringContaining("never confirmed"),
					}),
				);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
