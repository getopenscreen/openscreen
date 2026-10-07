// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RecStage } from "./RecStage";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn() },
}));

// Whether the native helper can leave the system cursor out of the pixels. Its own answer (and
// the HUD's) is tested with the function it calls; here it is a switch.
const editableCursor = vi.hoisted(() => ({ available: true }));
vi.mock("@/hooks/useEditableCursorAvailable", () => ({
	useEditableCursorAvailable: () => editableCursor.available,
}));

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

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

/** Camera access granted, and the OS listing these devices. Call after `stubRecordingPrefs`. */
function stubCameras(devices: Array<Partial<MediaDeviceInfo>>) {
	Object.assign(window.electronAPI as object, {
		requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
	});
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { enumerateDevices: vi.fn(async () => devices) },
	});
}

/** The OS listing these devices, for the microphone check. */
function stubMediaDevices(devices: Array<Partial<MediaDeviceInfo>>) {
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { enumerateDevices: vi.fn(async () => devices) },
	});
}

function renderRecStage() {
	const onStartRecording = vi.fn();
	const view = render(
		<TooltipProvider>
			<RecStage onStartRecording={onStartRecording} />
		</TooltipProvider>,
	);
	return { onStartRecording, ...view };
}

/** A row's On/Off pill: it is named by the row's label, and `aria-pressed` says On or Off. */
function pill(rowLabelKey: string) {
	return screen.getByRole("button", { name: rowLabelKey });
}

/** Opens a pill's tooltip the way the keyboard does (focus opens it at once) and returns what
 *  it says, or null when it opens nothing. */
async function tooltipOn(control: HTMLElement) {
	// A keyboard focus: one the mouse gave opens no tooltip.
	fireEvent.keyDown(window, { key: "Tab" });
	act(() => control.focus());
	try {
		const text = (await screen.findByRole("tooltip", {}, { timeout: 150 })).textContent;
		act(() => control.blur());
		await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
		return text;
	} catch {
		return null;
	} finally {
		act(() => control.blur());
	}
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
		editableCursor.available = true;
		vi.stubGlobal("ResizeObserver", StubResizeObserver);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
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

	// The HUD names the last pick in Apple's picker after a relaunch; this row does not. Beside
	// a preview that still asks what to record, a name reads as a source that is already chosen.
	it("keeps the last pick in Apple's picker out of the source row", async () => {
		stubRecordingPrefs({ micEnabled: false });
		Object.assign(window.electronAPI as unknown as Record<string, unknown>, {
			getLastPickedSource: vi.fn(async () => "Studio Display"),
		});
		renderRecStage();

		await screen.findByRole("button", { name: "rec.selectSource" });
		expect(screen.queryByText("Studio Display")).toBeNull();
		expect(screen.getAllByText("rec.selectSource")).toHaveLength(3);
	});

	it("shows a live source in the source row", async () => {
		stubRecordingPrefs(
			{ micEnabled: false },
			{ id: "screen:1:0", name: "Display 1", display_id: "1", thumbnail: null, appIcon: null },
		);
		renderRecStage();

		await screen.findByRole("button", { name: "Display 1" });
		expect(screen.queryByText("rec.selectSource")).toBeNull();
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

	// The HUD toggle refuses a camera the OS does not list (#967). This row stored it as on
	// anyway, beside its own "No camera found" (#998).
	it("keeps the camera off, and never stores it on, when the OS lists no camera", async () => {
		const { getRecordingPrefs, setRecordingPrefs } = stubRecordingPrefs({ camEnabled: false });
		stubCameras([]);
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		fireEvent.click(pill("rec.camera"));

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("recording.cameraNotFound"));
		expect(pill("rec.camera")).toHaveAttribute("aria-pressed", "false");
		expect(setRecordingPrefs).not.toHaveBeenCalledWith({ camEnabled: true });
	});

	it("turns a listed camera on, and stores it", async () => {
		const { getRecordingPrefs, setRecordingPrefs } = stubRecordingPrefs({ camEnabled: false });
		stubCameras([{ kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD Camera" }]);
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		fireEvent.click(pill("rec.camera"));

		await waitFor(() => expect(pill("rec.camera")).toHaveAttribute("aria-pressed", "true"));
		expect(setRecordingPrefs).toHaveBeenCalledWith({ camEnabled: true });
		expect(toast.error).not.toHaveBeenCalled();
	});

	// The microphone row stored "on" with no input at all, beside its own "No microphone
	// found", and the take after a Restart never started (#995).
	it("keeps the microphone off, and never stores it on, when the OS lists no input", async () => {
		const { getRecordingPrefs, setRecordingPrefs } = stubRecordingPrefs({ micEnabled: false });
		stubMediaDevices([{ kind: "videoinput", deviceId: "cam-1" }]);
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		fireEvent.click(pill("rec.microphone"));
		fireEvent.click(pill("rec.microphone"));

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("rec.noMicrophoneFound"));
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(pill("rec.microphone")).toHaveAttribute("aria-pressed", "false");
		expect(setRecordingPrefs).not.toHaveBeenCalledWith({ micEnabled: true });
	});

	it("turns a listed microphone on, and stores it", async () => {
		const { getRecordingPrefs, setRecordingPrefs } = stubRecordingPrefs({ micEnabled: false });
		stubMediaDevices([{ kind: "audioinput", deviceId: "mic-1" }]);
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		fireEvent.click(pill("rec.microphone"));

		await waitFor(() => expect(pill("rec.microphone")).toHaveAttribute("aria-pressed", "true"));
		expect(setRecordingPrefs).toHaveBeenCalledWith({ micEnabled: true });
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("lets a second click during the microphone check take the first one back", async () => {
		const { getRecordingPrefs, setRecordingPrefs } = stubRecordingPrefs({ micEnabled: false });
		stubMediaDevices([{ kind: "audioinput", deviceId: "mic-1" }]);
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		fireEvent.click(pill("rec.microphone"));
		fireEvent.click(pill("rec.microphone"));

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pill("rec.microphone")).toHaveAttribute("aria-pressed", "false");
		expect(setRecordingPrefs).not.toHaveBeenCalledWith({ micEnabled: true });
	});

	it("runs one camera check for a double click", async () => {
		const { getRecordingPrefs } = stubRecordingPrefs({ camEnabled: false });
		stubCameras([]);
		renderRecStage();
		await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());

		fireEvent.click(pill("rec.camera"));
		fireEvent.click(pill("rec.camera"));

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("recording.cameraNotFound"));
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(window.electronAPI?.requestCameraAccess).toHaveBeenCalledTimes(1);
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

		expect(pill("rec.editableCursor")).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(pill("rec.editableCursor"));
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
		rerender(
			<TooltipProvider>
				<RecStage onStartRecording={onStartRecording} />
			</TooltipProvider>,
		);
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
		rerender(
			<TooltipProvider>
				<RecStage onStartRecording={onStartRecording} />
			</TooltipProvider>,
		);
		expect(screen.getByText("rec.microphoneUnavailable")).toHaveAttribute(
			"title",
			"enumeration failed",
		);
	});

	it("ties microphone discovery to the toggle so off then on requests a retry", async () => {
		stubRecordingPrefs({ micEnabled: true });
		stubMediaDevices([{ kind: "audioinput", deviceId: "mic-1" }]);
		renderRecStage();
		await screen.findByText("rec.noMicrophoneFound");
		const toggle = pill("rec.microphone");
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		microphoneHook.call.mockClear();
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(microphoneHook.call).toHaveBeenLastCalledWith(false, undefined, undefined),
		);
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(microphoneHook.call).toHaveBeenLastCalledWith(true, undefined, undefined),
		);
	});

	it("offers Hide desktop icons where a helper honours it, and persists the toggle", async () => {
		const { setRecordingPrefs } = stubRecordingPrefs({});
		Object.assign(window.electronAPI as object, { getPlatform: () => "win32" });
		renderRecStage();
		const label = await screen.findByText("rec.hideDesktopIcons");
		// The tooltip is on the pill, not the label: the pill is the control. No native title.
		expect(label).not.toHaveAttribute("title");
		const desktopIcons = pill("rec.hideDesktopIcons");
		expect(desktopIcons).not.toHaveAttribute("title");
		expect(await tooltipOn(desktopIcons)).toBe("rec.hideDesktopIconsHintWindows");
		fireEvent.click(desktopIcons);
		await waitFor(() => expect(setRecordingPrefs).toHaveBeenCalledWith({ hideDesktopIcons: true }));
		cleanup();

		// The portal records Linux: nothing there could hide the icons.
		stubRecordingPrefs({});
		Object.assign(window.electronAPI as object, { getPlatform: () => "linux" });
		renderRecStage();
		await screen.findByText("rec.editableCursor");
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
		await screen.findByText("rec.systemAudio");
		await waitFor(() => expect(pill("rec.systemAudio")).toHaveAttribute("aria-pressed", "true"));

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

describe("RecStage names and tooltips", () => {
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
		editableCursor.available = true;
		vi.stubGlobal("ResizeObserver", StubResizeObserver);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		cleanup();
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	});

	async function renderReady(prefs: Record<string, unknown> = {}) {
		const stubs = stubRecordingPrefs({ cursorCaptureMode: "editable-overlay", ...prefs });
		renderRecStage();
		await waitFor(() => expect(stubs.getRecordingPrefs).toHaveBeenCalled());
		await screen.findByText("rec.editableCursor");
		return stubs;
	}

	// The cursor row is the HUD's term: "Cursor highlight" suggested a halo, and the HUD's own
	// toggle says "Editable cursor" for the same setting.
	it("calls the cursor row the Editable cursor, as the HUD does", async () => {
		await renderReady();
		expect(screen.getByText("rec.editableCursor")).toBeInTheDocument();
		expect(screen.queryByText("rec.cursorHighlight")).toBeNull();
	});

	// A pill that reads "On" or "Off" names no control: the row's label is its name, and
	// aria-pressed carries the state, so a screen reader never hears "Off, pressed".
	it("names every On/Off pill by its row, and says which state with aria-pressed", async () => {
		await renderReady({ systemAudioEnabled: true, hideDesktopIcons: false });
		Object.assign(window.electronAPI as object, { getPlatform: () => "win32" });
		for (const row of [
			"rec.systemAudio",
			"rec.microphone",
			"rec.camera",
			"rec.editableCursor",
			"rec.autoZoom",
		]) {
			const control = pill(row);
			expect(control).toHaveAttribute("aria-pressed");
			expect(control).not.toHaveAttribute("title");
			expect(control).toHaveTextContent(/^rec\.(on|off)$/);
		}
		expect(pill("rec.systemAudio")).toHaveAttribute("aria-pressed", "true");
		expect(pill("rec.camera")).toHaveAttribute("aria-pressed", "false");
	});

	it("explains system audio and the editable cursor, in a tooltip on the pill", async () => {
		await renderReady();
		expect(await tooltipOn(pill("rec.systemAudio"))).toBe("rec.systemAudioTip");
		expect(await tooltipOn(pill("rec.editableCursor"))).toBe("rec.editableCursorTip");
	});

	// To the left a tooltip sits on the label the user is reading, and below the last row it covers
	// Start recording: it opens above the pill.
	it("opens the row tooltips above their pill, never over the row's own label", async () => {
		stubRecordingPrefs({ cursorCaptureMode: "editable-overlay" });
		// Windows offers the desktop icons row too, so all three tooltips can be checked.
		Object.assign(window.electronAPI as object, { getPlatform: () => "win32" });
		renderRecStage();
		await screen.findByText("rec.hideDesktopIcons");
		for (const row of ["rec.systemAudio", "rec.editableCursor", "rec.hideDesktopIcons"]) {
			const control = pill(row);
			// A keyboard focus: one the mouse gave opens no tooltip.
			fireEvent.keyDown(window, { key: "Tab" });
			act(() => control.focus());
			await screen.findByRole("tooltip");
			expect(
				document.querySelector('[data-slot="tooltip-content"]')?.getAttribute("data-side"),
			).toBe("top");
			act(() => control.blur());
			await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
		}
	});

	// Decided: the rest are labelled and say what they do, so a tooltip would repeat the label.
	it("gives the microphone, camera and auto-zoom pills no tooltip", async () => {
		await renderReady();
		expect(await tooltipOn(pill("rec.microphone"))).toBeNull();
		expect(await tooltipOn(pill("rec.camera"))).toBeNull();
		expect(await tooltipOn(pill("rec.autoZoom"))).toBeNull();
	});

	// Without its native helper the browser records, and it always draws the system cursor into
	// the video: there is nothing to switch, and Auto-zoom reads what the editable cursor records.
	it("hides the cursor row and the auto-zoom row when capture falls back to the browser", async () => {
		editableCursor.available = false;
		stubRecordingPrefs({ cursorCaptureMode: "editable-overlay", autoZoomEnabled: true });
		renderRecStage();
		await screen.findByText("rec.systemAudio");
		expect(screen.queryByText("rec.editableCursor")).toBeNull();
		expect(screen.queryByText("rec.autoZoom")).toBeNull();
		expect(screen.queryByTestId("rec-auto-zoom-button")).toBeNull();
	});
});
