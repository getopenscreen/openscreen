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

	it("hands the choice to Apple's picker instead of listing sources itself", async () => {
		stubRecordingPrefs({ micEnabled: false });
		const api = window.electronAPI as unknown as Record<string, unknown>;
		const getSources = vi.fn(async () => []);
		const openSourceSelector = vi.fn(async () => ({ opened: true }));
		const usesSystemSourcePicker = vi.fn(async () => true);
		Object.assign(api, { getSources, openSourceSelector, usesSystemSourcePicker });
		renderRecStage();
		await waitFor(() => expect(usesSystemSourcePicker).toHaveBeenCalled());

		await act(async () => {
			screen.getByRole("button", { name: "rec.selectSource" }).click();
		});

		// Enumerating would go through the Screen Recording grant the picker makes unnecessary.
		await waitFor(() => expect(openSourceSelector).toHaveBeenCalled());
		expect(getSources).not.toHaveBeenCalled();
	});

	it("names the last pick in the source row only, without selecting it", async () => {
		stubRecordingPrefs({ micEnabled: false });
		const getLastPickedSource = vi.fn(async () => "Studio Display");
		Object.assign(window.electronAPI as unknown as Record<string, unknown>, {
			getLastPickedSource,
		});
		renderRecStage();

		const row = await screen.findByRole("button", { name: "Studio Display" });
		expect(row).toHaveAttribute("data-remembered", "true");
		// Nothing is live: the preview keeps asking what to record.
		expect(screen.getAllByText("rec.selectSource")).toHaveLength(2);
	});

	it("shows a live source in place of the remembered name", async () => {
		stubRecordingPrefs(
			{ micEnabled: false },
			{ id: "screen:1:0", name: "Display 1", display_id: "1", thumbnail: null, appIcon: null },
		);
		const getLastPickedSource = vi.fn(async () => "Studio Display");
		Object.assign(window.electronAPI as unknown as Record<string, unknown>, {
			getLastPickedSource,
		});
		renderRecStage();

		const row = await screen.findByRole("button", { name: "Display 1" });
		expect(row).not.toHaveAttribute("data-remembered");
		expect(screen.queryByRole("button", { name: "Studio Display" })).toBeNull();
	});

	it("asks to choose when nothing was picked before", async () => {
		stubRecordingPrefs({ micEnabled: false });
		const getLastPickedSource = vi.fn(async () => null);
		Object.assign(window.electronAPI as unknown as Record<string, unknown>, {
			getLastPickedSource,
		});
		renderRecStage();

		await waitFor(() => expect(getLastPickedSource).toHaveBeenCalled());
		const row = screen.getByRole("button", { name: "rec.selectSource" });
		expect(row).not.toHaveAttribute("data-remembered");
	});

	it("writes autoZoomEnabled through setRecordingPrefs on click", async () => {
		const { getRecordingPrefs, setRecordingPrefs } = stubRecordingPrefs({
			micEnabled: false,
			cursorCaptureMode: "editable-overlay",
			autoZoomEnabled: true,
		});
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		const button = screen.getByTestId("rec-auto-zoom-button");
		await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
		await act(async () => {
			button.click();
		});
		expect(setRecordingPrefs).toHaveBeenCalledWith({ autoZoomEnabled: false });
		expect(button).toHaveAttribute("aria-pressed", "false");
	});

	// A settings file written before the preference existed has no key, and every such
	// installation has been getting auto-zoom — so absent must read as on, not off.
	it("defaults on when a stored prefs blob has no autoZoomEnabled key", async () => {
		const { getRecordingPrefs } = stubRecordingPrefs({
			micEnabled: false,
			cursorCaptureMode: "editable-overlay",
			hideDesktopIcons: false,
		});
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());
		expect(screen.getByTestId("rec-auto-zoom-button")).toHaveAttribute("aria-pressed", "true");
	});

	// The system cursor writes no telemetry sidecar, so there is no dwell to place a
	// zoom from: the row is not offered at all, and the stored choice is left alone.
	it("hides the auto-zoom row while the system cursor is capturing", async () => {
		const { setRecordingPrefs } = stubRecordingPrefs({
			micEnabled: false,
			cursorCaptureMode: "system",
			autoZoomEnabled: true,
		});
		renderRecStage();
		await waitFor(() => expect(screen.queryByTestId("rec-auto-zoom-button")).toBeNull());
		expect(screen.queryByText("rec.autoZoom")).toBeNull();

		const cursorLabel = screen.getByText("rec.cursorHighlight");
		if (!cursorLabel.parentElement) throw new Error("cursor highlight row is missing");
		fireEvent.click(within(cursorLabel.parentElement).getByRole("button", { name: "rec.off" }));
		expect(await screen.findByTestId("rec-auto-zoom-button")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(setRecordingPrefs).toHaveBeenCalledTimes(1);
		expect(setRecordingPrefs).toHaveBeenCalledWith({ cursorCaptureMode: "editable-overlay" });
	});

	// The durable value is what the import path reads back, so a panel left showing Off
	// after a rejected write would promise something the next take does not honour.
	it("falls back to the stored value when the preference write is rejected", async () => {
		const { getRecordingPrefs } = stubRecordingPrefs({
			micEnabled: false,
			cursorCaptureMode: "editable-overlay",
			autoZoomEnabled: true,
		});
		const api = window.electronAPI as unknown as Record<string, unknown>;
		const setRecordingPrefs = vi.fn(async () => {
			throw new Error("write failed");
		});
		Object.assign(api, { setRecordingPrefs });
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		const button = screen.getByTestId("rec-auto-zoom-button");
		await act(async () => {
			button.click();
		});
		expect(setRecordingPrefs).toHaveBeenCalledWith({ autoZoomEnabled: false });
		await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
	});

	// Another window can land a change while this panel's write is failing. Its pushed
	// snapshot is newer than the re-read that the failure starts, so the push must win.
	it("keeps a snapshot pushed after a rejected write over the re-read", async () => {
		const stored: RecordingPrefs = {
			micEnabled: false,
			micDeviceId: null,
			micDeviceName: null,
			camEnabled: false,
			camDeviceId: null,
			camDeviceName: null,
			camQuality: "2160p",
			systemAudioEnabled: false,
			cursorCaptureMode: "editable-overlay",
			hideDesktopIcons: false,
			autoZoomEnabled: true,
		};
		stubRecordingPrefs();
		let answerReread: ((prefs: RecordingPrefs) => void) | undefined;
		const getRecordingPrefs = vi
			.fn<() => Promise<RecordingPrefs>>()
			.mockResolvedValueOnce(stored)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						answerReread = resolve;
					}),
			);
		const setRecordingPrefs = vi.fn(async () => {
			throw new Error("write failed");
		});
		Object.assign(window.electronAPI as object, { getRecordingPrefs, setRecordingPrefs });
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalledTimes(1));

		const button = screen.getByTestId("rec-auto-zoom-button");
		await act(async () => {
			button.click();
		});
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalledTimes(2));
		act(() => {
			recordingPrefsListeners.forEach((listener) =>
				listener({ ...stored, autoZoomEnabled: false }),
			);
		});
		await act(async () => {
			answerReread?.(stored);
		});
		expect(button).toHaveAttribute("aria-pressed", "false");
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

	it("offers Hide desktop icons where a helper honours it, and persists the toggle", async () => {
		const { setRecordingPrefs } = stubRecordingPrefs({});
		Object.assign(window.electronAPI as object, { getPlatform: () => "win32" });
		renderRecStage();
		const label = await screen.findByText("rec.hideDesktopIcons");
		expect(label).toHaveAttribute("title", "rec.hideDesktopIconsHintWindows");
		if (!label.parentElement) throw new Error("desktop icons row is missing");
		fireEvent.click(within(label.parentElement).getByRole("button", { name: "rec.off" }));
		await waitFor(() => expect(setRecordingPrefs).toHaveBeenCalledWith({ hideDesktopIcons: true }));
		cleanup();

		// The portal records Linux: nothing there could hide the icons.
		stubRecordingPrefs({});
		Object.assign(window.electronAPI as object, { getPlatform: () => "linux" });
		renderRecStage();
		await screen.findByText("rec.cursorHighlight");
		expect(screen.queryByText("rec.hideDesktopIcons")).toBeNull();
	});

	// ScreenCaptureKit captures the microphone from macOS 15 only (#700).
	it("offers no microphone on macOS 14, and leaves a saved one unapplied", async () => {
		const { setRecordingPrefs } = stubRecordingPrefs({
			micEnabled: true,
			systemAudioEnabled: true,
		});
		Object.assign(window.electronAPI as object, {
			getPlatform: () => "darwin",
			getSystemVersion: () => "14.6.1",
		});
		renderRecStage();
		// The saved prefs have landed once system audio reads on.
		const systemAudioRow = (await screen.findByText("rec.systemAudio")).parentElement;
		if (!systemAudioRow) throw new Error("system audio row is missing");
		await within(systemAudioRow).findByRole("button", { name: "rec.on" });

		expect(screen.queryByText("rec.microphone")).toBeNull();
		expect(microphoneHook.call).toHaveBeenLastCalledWith(false, undefined, undefined);
		expect(audioMeter.call).toHaveBeenLastCalledWith({ enabled: false, deviceId: undefined });
		expect(setRecordingPrefs).not.toHaveBeenCalled();
		cleanup();

		stubRecordingPrefs({ micEnabled: true });
		Object.assign(window.electronAPI as object, {
			getPlatform: () => "darwin",
			getSystemVersion: () => "15.0",
		});
		renderRecStage();
		expect(await screen.findByText("rec.microphone")).toBeInTheDocument();
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
			camQuality: "2160p",
			systemAudioEnabled: false,
			cursorCaptureMode: "editable-overlay",
			hideDesktopIcons: false,
			autoZoomEnabled: true,
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
