// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecStage } from "./RecStage";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

const microphoneHook = vi.hoisted(() => ({
	call: vi.fn(),
	value: {
		devices: [] as Array<{ deviceId: string; label: string; groupId: string }>,
		selectedDeviceId: "default",
		setSelectedDeviceId: vi.fn(),
		isLoading: false,
		isReady: true,
		error: null as string | null,
	},
}));
vi.mock("@/hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: (...args: unknown[]) => {
		microphoneHook.call(...args);
		return microphoneHook.value;
	},
}));

vi.mock("@/hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: [],
		selectedDeviceId: "",
		setSelectedDeviceId: vi.fn(),
		isLoading: false,
		error: null,
	}),
}));

const audioMeter = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: (options: unknown) => {
		audioMeter.call(options);
		return { level: 0 };
	},
}));

const cameraPreview = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: (options: unknown) => {
		cameraPreview.call(options);
		return { stream: null, error: null };
	},
}));

vi.mock("@/hooks/usePortalOwnsSource", () => ({
	usePortalOwnsSource: () => false,
}));

type RecordingPrefs = Awaited<ReturnType<Window["electronAPI"]["getRecordingPrefs"]>>;
type SelectedSource = Awaited<ReturnType<Window["electronAPI"]["getSelectedSource"]>>;
let recordingPrefsListeners: Array<(prefs: RecordingPrefs) => void> = [];
let selectedSourceListeners: Array<(source: SelectedSource) => void> = [];

function stubRecordingPrefs(
	prefs: Record<string, unknown> = {},
	selectedSource: SelectedSource = null,
) {
	const getRecordingPrefs = vi.fn(async () => prefs);
	const setRecordingPrefs = vi.fn(async () => undefined);
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		getRecordingPrefs,
		setRecordingPrefs,
		getSelectedSource: vi.fn(async () => selectedSource),
		onRecordingPrefsChanged: vi.fn((callback: (next: RecordingPrefs) => void) => {
			recordingPrefsListeners.push(callback);
			return () => {
				recordingPrefsListeners = recordingPrefsListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
		onSelectedSourceChanged: vi.fn((callback: (next: SelectedSource) => void) => {
			selectedSourceListeners.push(callback);
			return () => {
				selectedSourceListeners = selectedSourceListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
	};
	return { getRecordingPrefs, setRecordingPrefs };
}

function renderRecStage() {
	const onStartRecording = vi.fn();
	const view = render(<RecStage onStartRecording={onStartRecording} />);
	return { onStartRecording, ...view };
}

describe("RecStage controls", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		recordingPrefsListeners = [];
		selectedSourceListeners = [];
		microphoneHook.value = {
			devices: [],
			selectedDeviceId: "default",
			setSelectedDeviceId: vi.fn(),
			isLoading: false,
			isReady: true,
			error: null,
		};
	});

	afterEach(() => {
		cleanup();
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	});

	it("does not render an auto-zoom toggle button (auto-zoom is systematic)", async () => {
		const { getRecordingPrefs } = stubRecordingPrefs({
			micEnabled: false,
			cursorCaptureMode: "editable-overlay",
		});
		renderRecStage();
		await waitFor(() => {
			expect(getRecordingPrefs).toHaveBeenCalled();
		});
		expect(screen.queryByTestId("rec-auto-zoom-button")).toBeNull();
	});

	it("waits for microphone discovery before starting the meter and normalizes default", async () => {
		stubRecordingPrefs({
			micEnabled: true,
			micDeviceId: "saved-id",
			micDeviceName: "Saved microphone",
		});
		microphoneHook.value = {
			...microphoneHook.value,
			isLoading: true,
			isReady: false,
		};
		const { rerender, onStartRecording } = renderRecStage();
		await waitFor(() =>
			expect(microphoneHook.call).toHaveBeenCalledWith(true, "saved-id", "Saved microphone"),
		);
		expect(audioMeter.call).toHaveBeenLastCalledWith({ enabled: false, deviceId: undefined });

		microphoneHook.value = {
			...microphoneHook.value,
			devices: [{ deviceId: "default", label: "System default", groupId: "g" }],
			selectedDeviceId: "default",
			isLoading: false,
			isReady: true,
		};
		rerender(<RecStage onStartRecording={onStartRecording} />);
		expect(audioMeter.call).toHaveBeenLastCalledWith({ enabled: true, deviceId: undefined });
	});

	it("shows explicit empty and error states instead of an empty microphone select", async () => {
		stubRecordingPrefs({ micEnabled: true });
		microphoneHook.value = { ...microphoneHook.value, devices: [], error: null };
		const { rerender, onStartRecording } = renderRecStage();
		expect(await screen.findByText("rec.noMicrophoneFound")).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

		microphoneHook.value = {
			...microphoneHook.value,
			devices: [],
			error: "enumeration failed",
		};
		rerender(<RecStage onStartRecording={onStartRecording} />);
		expect(screen.getByText("rec.microphoneUnavailable")).toHaveAttribute(
			"title",
			"enumeration failed",
		);
	});

	it("ties microphone discovery to the toggle so off then on requests a retry", async () => {
		stubRecordingPrefs({ micEnabled: true });
		renderRecStage();
		await screen.findByText("rec.noMicrophoneFound");
		const row = screen.getByText("rec.microphone").closest("div");
		if (!row?.parentElement) throw new Error("microphone row is missing");
		const toggle = within(row.parentElement).getByRole("button", { name: "rec.on" });
		microphoneHook.call.mockClear();
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(microphoneHook.call).toHaveBeenLastCalledWith(false, undefined, undefined),
		);
		fireEvent.click(within(row.parentElement).getByRole("button", { name: "rec.off" }));
		await waitFor(() =>
			expect(microphoneHook.call).toHaveBeenLastCalledWith(true, undefined, undefined),
		);
	});

	it("applies pushed preference events and ignores older initial preference and source reads", async () => {
		let resolvePrefs: ((value: RecordingPrefs) => void) | undefined;
		let resolveSource: ((value: SelectedSource) => void) | undefined;
		const initialPrefs = new Promise<RecordingPrefs>((resolve) => {
			resolvePrefs = resolve;
		});
		const initialSource = new Promise<SelectedSource>((resolve) => {
			resolveSource = resolve;
		});
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			getRecordingPrefs: vi.fn(() => initialPrefs),
			setRecordingPrefs: vi.fn(async () => undefined),
			getSelectedSource: vi.fn(() => initialSource),
			onRecordingPrefsChanged: vi.fn((callback: (next: RecordingPrefs) => void) => {
				recordingPrefsListeners.push(callback);
				return () => {
					recordingPrefsListeners = recordingPrefsListeners.filter(
						(listener) => listener !== callback,
					);
				};
			}),
			onSelectedSourceChanged: vi.fn((callback: (next: SelectedSource) => void) => {
				selectedSourceListeners.push(callback);
				return () => {
					selectedSourceListeners = selectedSourceListeners.filter(
						(listener) => listener !== callback,
					);
				};
			}),
		};
		const { unmount } = renderRecStage();
		await waitFor(() => {
			expect(recordingPrefsListeners).toHaveLength(1);
			expect(selectedSourceListeners).toHaveLength(1);
		});

		const resetPrefs: RecordingPrefs = {
			micEnabled: false,
			micDeviceId: null,
			micDeviceName: null,
			camEnabled: false,
			camDeviceId: null,
			camDeviceName: null,
			systemAudioEnabled: false,
			cursorCaptureMode: "editable-overlay",
		};
		act(() => {
			recordingPrefsListeners.forEach((listener) => listener(resetPrefs));
			selectedSourceListeners.forEach((listener) => listener(null));
		});
		await act(async () => {
			resolvePrefs?.({
				...resetPrefs,
				micEnabled: true,
				camEnabled: true,
				systemAudioEnabled: true,
			});
			resolveSource?.({
				id: "screen:stale",
				name: "Stale source",
				display_id: "1",
				thumbnail: null,
				appIcon: null,
			});
		});

		await waitFor(() =>
			expect(microphoneHook.call).toHaveBeenLastCalledWith(false, undefined, undefined),
		);
		expect(audioMeter.call).toHaveBeenLastCalledWith({ enabled: false, deviceId: undefined });
		expect(cameraPreview.call).toHaveBeenLastCalledWith({ enabled: false, deviceId: undefined });
		expect(screen.getByRole("button", { name: "rec.selectSource" })).toBeInTheDocument();
		expect(screen.queryByText("Stale source")).not.toBeInTheDocument();

		unmount();
		expect(recordingPrefsListeners).toEqual([]);
		expect(selectedSourceListeners).toEqual([]);
	});
});
