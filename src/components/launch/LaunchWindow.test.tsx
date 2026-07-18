import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { LaunchWindow } from "./LaunchWindow";

type SelectedSourceChangedListener = Parameters<
	Window["electronAPI"]["onSelectedSourceChanged"]
>[0];

const platformState = vi.hoisted(() => ({ value: "darwin" }));
const resizeCallbacks = vi.hoisted(() => [] as Array<ResizeObserverCallback>);

class StubResizeObserver {
	observe() {
		return undefined;
	}
	unobserve() {
		return undefined;
	}
	disconnect() {
		return undefined;
	}
}

class CapturingResizeObserver extends StubResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		super();
		resizeCallbacks.push(callback);
	}
}

const recorderState = vi.hoisted(() => ({
	value: {
		recording: false,
		paused: false,
		saving: false,
		elapsedSeconds: 0,
		toggleRecording: vi.fn(),
		togglePaused: vi.fn(),
		canPauseRecording: false,
		restartRecording: vi.fn(),
		cancelRecording: vi.fn(),
		microphoneEnabled: false,
		setMicrophoneEnabled: vi.fn(),
		microphoneDeviceId: undefined,
		setMicrophoneDeviceId: vi.fn(),
		setMicrophoneDeviceName: vi.fn(),
		webcamEnabled: false,
		setWebcamEnabled: vi.fn(async () => true),
		webcamDeviceId: undefined,
		setWebcamDeviceId: vi.fn(),
		setWebcamDeviceName: vi.fn(),
		systemAudioEnabled: false,
		setSystemAudioEnabled: vi.fn(),
		cursorCaptureMode: "editable-overlay",
		setCursorCaptureMode: vi.fn(),
		softwareEncoderFallbackNoticeVisible: false,
		dismissSoftwareEncoderFallbackNotice: vi.fn(),
	},
}));

let selectedSourceChangedListeners: SelectedSourceChangedListener[] = [];
let sourceSelectorClosedListeners: Array<() => void> = [];

vi.mock("../../hooks/useScreenRecorder", () => ({
	useScreenRecorder: () => recorderState.value,
}));

vi.mock("../../hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => ({
		devices: [],
		selectedDeviceId: "default",
		setSelectedDeviceId: vi.fn(),
	}),
}));

vi.mock("../../hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: [],
		selectedDeviceId: "",
		setSelectedDeviceId: vi.fn(),
		isLoading: false,
		error: null,
	}),
}));

vi.mock("../../hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));

vi.mock("../../lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

vi.mock("@/native", () => ({
	nativeBridgeClient: {
		system: {
			getPlatform: vi.fn(async () => platformState.value),
		},
	},
}));

const i18nState = vi.hoisted(() => ({
	value: {
		locale: "en",
		setLocale: vi.fn(),
		systemLocaleSuggestion: null as string | null,
		acceptSystemLocaleSuggestion: vi.fn(),
		dismissSystemLocaleSuggestion: vi.fn(),
		resolveSystemLocaleSuggestion: vi.fn(),
	},
}));

vi.mock("@/i18n/loader", () => ({
	getAvailableLocales: () => ["en"],
	getLocaleName: () => "English",
}));

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => i18nState.value,
	useScopedT: () => (key: string) => {
		const translations: Record<string, string> = {
			"sourceSelector.defaultSourceName": "Screen",
			"recording.selectSource": "Please select a source to record",
			"tooltips.useVerticalTray": "Use vertical tray",
			"tooltips.useHorizontalTray": "Use horizontal tray",
			"audio.enableSystemAudio": "Enable system audio",
			"audio.disableSystemAudio": "Disable system audio",
			"audio.enableMicrophone": "Enable microphone",
			"audio.disableMicrophone": "Disable microphone",
			"audio.defaultMicrophone": "Default Microphone",
			"webcam.enableWebcam": "Enable webcam",
			"webcam.disableWebcam": "Disable webcam",
			"webcam.defaultCamera": "Default Camera",
			"webcam.searching": "Searching...",
			"webcam.noneFound": "No camera found",
			"webcam.unavailable": "Camera unavailable",
			"cursor.useEditableCursor": "Use editable cursor",
			"cursor.useSystemCursor": "Use system cursor",
			"tooltips.openStudio": "Open Studio",
			"tooltips.hideHUD": "Hide HUD",
			"tooltips.closeApp": "Close App",
			language: "Language",
			"systemLanguagePrompt.title": "Use your system language?",
			"systemLanguagePrompt.description":
				"We detected English as your system language. Do you want to switch OpenScreen to English?",
			"systemLanguagePrompt.keepDefault": "Keep current language",
			"systemLanguagePrompt.switch": "Switch to English",
			"softwareEncoderFallback.title": "Switched to software encoding",
			"softwareEncoderFallback.description":
				"The default GPU encoder failed to start, so OpenScreen fell back to software H.264 encoding. Recording should continue as normal, but CPU usage may be higher.",
			"softwareEncoderFallback.dismiss": "Got it",
			"softwareEncoderFallback.dontShowAgain": "Don't show again",
		};
		return translations[key] ?? key;
	},
}));

function renderLaunchWindow() {
	return render(
		<TooltipProvider>
			<LaunchWindow />
		</TooltipProvider>,
	);
}

function stubElectronAPI(getSelectedSource: Window["electronAPI"]["getSelectedSource"]) {
	window.electronAPI = {
		...window.electronAPI,
		platform: platformState.value,
		getSelectedSource,
		openSourceSelector: vi.fn(async () => ({ opened: true })),
		requestScreenAccess: vi.fn(async () => ({
			success: true,
			granted: true,
			status: "granted",
		})),
		getPlatform: vi.fn(async () => "darwin"),
		setHudOverlaySize: vi.fn(),
		setHudOverlayIgnoreMouseEvents: vi.fn(),
		beginHudOverlayDrag: vi.fn(),
		updateHudOverlayDrag: vi.fn(),
		endHudOverlayDrag: vi.fn(),
		hudOverlayHide: vi.fn(),
		hudOverlayClose: vi.fn(),
		switchToEditor: vi.fn(async () => undefined),
		onSelectedSourceChanged: vi.fn((callback) => {
			selectedSourceChangedListeners.push(callback);
			return () => {
				selectedSourceChangedListeners = selectedSourceChangedListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
		onSourceSelectorClosed: vi.fn((callback) => {
			sourceSelectorClosedListeners.push(callback);
			return () => {
				sourceSelectorClosedListeners = sourceSelectorClosedListeners.filter(
					(listener) => listener !== callback,
				);
			};
		}),
	} as typeof window.electronAPI;
}

const displayOneSource = {
	id: "screen:1:0",
	name: "Display 1",
	display_id: "1",
	thumbnail: null,
	appIcon: null,
} satisfies ProcessedDesktopSource;

async function waitForSourceSelectionSubscription() {
	await waitFor(() => {
		expect(selectedSourceChangedListeners.length).toBeGreaterThan(0);
	});
}

function emitSelectedSourceChanged(source: ProcessedDesktopSource) {
	act(() => {
		selectedSourceChangedListeners.forEach((listener) => listener(source));
	});
}

function emitSourceSelectorClosed() {
	act(() => {
		sourceSelectorClosedListeners.forEach((listener) => listener());
	});
}

function resetLaunchMocks() {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	recorderState.value.toggleRecording.mockClear();
	recorderState.value.softwareEncoderFallbackNoticeVisible = false;
	recorderState.value.dismissSoftwareEncoderFallbackNotice.mockClear();
	selectedSourceChangedListeners = [];
	sourceSelectorClosedListeners = [];
	i18nState.value.systemLocaleSuggestion = null;
	i18nState.value.acceptSystemLocaleSuggestion.mockClear();
	i18nState.value.dismissSystemLocaleSuggestion.mockClear();
	i18nState.value.resolveSystemLocaleSuggestion.mockClear();
	stubElectronAPI(vi.fn(async () => null));
}

describe("LaunchWindow record button", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("opens the source selector instead of disabling the primary action when no source is selected", async () => {
		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");

		expect(recordButton).toBeEnabled();
		expect(recordButton).toHaveAttribute("title", "Please select a source to record");

		fireEvent.click(recordButton);

		await waitFor(() => {
			expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("records immediately after source selection when the record button opened the picker", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
	});

	it("does not record after manual source selection", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("clears record-after-selection intent when the source picker closes without a selection", async () => {
		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));
		emitSourceSelectorClosed();
		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("clears record-after-selection intent when opening the source picker fails", async () => {
		window.electronAPI.openSourceSelector = vi.fn(async () => {
			throw new Error("source selector failed");
		});

		renderLaunchWindow();
		await waitForSourceSelectionSubscription();

		fireEvent.click(await screen.findByTestId("launch-record-button"));

		await waitFor(() => {
			expect(window.electronAPI.openSourceSelector).toHaveBeenCalledTimes(1);
		});

		await act(async () => {
			await Promise.resolve();
		});

		emitSelectedSourceChanged(displayOneSource);

		await waitFor(() => {
			expect(screen.getByTestId("launch-record-button")).toHaveAttribute("title", "Display 1");
		});
		expect(recorderState.value.toggleRecording).not.toHaveBeenCalled();
	});

	it("handles selected source polling failures", async () => {
		const error = new Error("selected source unavailable");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		stubElectronAPI(
			vi.fn(async () => {
				throw error;
			}),
		);

		renderLaunchWindow();

		await waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith("Failed to refresh selected source:", error);
		});

		warnSpy.mockRestore();
	});

	it("starts recording when a source is already selected", async () => {
		stubElectronAPI(vi.fn(async () => displayOneSource));

		renderLaunchWindow();

		const recordButton = await screen.findByTestId("launch-record-button");
		await waitFor(() => {
			expect(recordButton).toHaveAttribute("title", "Display 1");
		});

		fireEvent.click(recordButton);

		expect(recorderState.value.toggleRecording).toHaveBeenCalledTimes(1);
		expect(window.electronAPI.openSourceSelector).not.toHaveBeenCalled();
	});

	it("keeps the HUD interactive on Linux so the drag handle can receive pointer events", async () => {
		platformState.value = "linux";

		renderLaunchWindow();

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
		});
	});
});

describe("LaunchWindow HUD dragging", () => {
	beforeEach(() => {
		platformState.value = "win32";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("uses anchored pointer dragging on the Windows HUD handle", async () => {
		const { container } = renderLaunchWindow();

		const handle = screen.getByTestId("launch-drag-handle");
		await waitFor(() => expect(handle.className).toMatch(/electronNoDrag/));
		expect((container.firstElementChild as HTMLElement).className).not.toMatch(/electronDrag/);

		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});
		fireEvent.pointerDown(handle, { button: 0, pointerId: 7, screenX: 100, screenY: 200 });
		fireEvent.pointerMove(handle, { pointerId: 7, screenX: 110, screenY: 210 });
		fireEvent.pointerUp(handle, { button: 0, pointerId: 7, screenX: 120, screenY: 220 });

		expect(window.electronAPI.beginHudOverlayDrag).toHaveBeenCalledWith(100, 200);
		expect(window.electronAPI.updateHudOverlayDrag).toHaveBeenCalledWith(110, 210);
		expect(window.electronAPI.endHudOverlayDrag).toHaveBeenCalledWith(120, 220);
	});

	it("lets the main process resolve the OS cursor point after pointer cancellation", () => {
		renderLaunchWindow();
		const handle = screen.getByTestId("launch-drag-handle");

		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});

		fireEvent.pointerDown(handle, { button: 0, pointerId: 11, screenX: 100, screenY: 200 });
		fireEvent.pointerCancel(handle, { pointerId: 11, screenX: 0, screenY: 0 });

		expect(window.electronAPI.endHudOverlayDrag).toHaveBeenCalledWith(undefined, undefined);
	});

	it("keeps the visible HUD anchored when Windows enlarges its viewport at 125%", async () => {
		let innerWidth = 588;
		let innerHeight = 95;
		vi.spyOn(window, "innerWidth", "get").mockImplementation(() => innerWidth);
		vi.spyOn(window, "innerHeight", "get").mockImplementation(() => innerHeight);
		const { container } = renderLaunchWindow();
		const handle = screen.getByTestId("launch-drag-handle");
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;

		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});

		fireEvent.pointerDown(handle, { button: 0, pointerId: 7, screenX: 100, screenY: 200 });
		innerWidth = 594;
		innerHeight = 99;
		fireEvent.resize(window);

		await waitFor(() => {
			expect(hudBar.style.left).toBe("calc(50% - 3px)");
			expect(hudBar.style.bottom).toBe("24px");
		});

		fireEvent.pointerUp(handle, { button: 0, pointerId: 7, screenX: 110, screenY: 210 });
		fireEvent.pointerDown(handle, { button: 0, pointerId: 8, screenX: 110, screenY: 210 });
		innerWidth = 596;
		innerHeight = 100;
		fireEvent.pointerMove(handle, { pointerId: 8, screenX: 120, screenY: 220 });

		await waitFor(() => {
			expect(hudBar.style.left).toBe("calc(50% - 4px)");
			expect(hudBar.style.bottom).toBe("25px");
		});
	});

	it("applies a fractional-DPI viewport resize delivered after pointer-up", async () => {
		let innerWidth = 588;
		let innerHeight = 95;
		vi.spyOn(window, "innerWidth", "get").mockImplementation(() => innerWidth);
		vi.spyOn(window, "innerHeight", "get").mockImplementation(() => innerHeight);
		const { container } = renderLaunchWindow();
		const handle = screen.getByTestId("launch-drag-handle");
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;

		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});

		fireEvent.pointerDown(handle, { button: 0, pointerId: 9, screenX: 100, screenY: 200 });
		fireEvent.pointerUp(handle, { button: 0, pointerId: 9, screenX: 120, screenY: 220 });

		// Chromium can publish the transparent-HWND size change on the next task,
		// after pointer-up has already completed.
		innerWidth = 594;
		innerHeight = 99;
		fireEvent.resize(window);

		await waitFor(() => {
			expect(hudBar.style.left).toBe("calc(50% - 3px)");
			expect(hudBar.style.bottom).toBe("24px");
		});
	});

	it("waits for successive mixed-DPI viewport resizes to settle", () => {
		vi.useFakeTimers();
		let innerWidth = 588;
		let innerHeight = 95;
		vi.spyOn(window, "innerWidth", "get").mockImplementation(() => innerWidth);
		vi.spyOn(window, "innerHeight", "get").mockImplementation(() => innerHeight);
		const { container } = renderLaunchWindow();
		const handle = screen.getByTestId("launch-drag-handle");
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;

		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});

		fireEvent.pointerDown(handle, { button: 0, pointerId: 12, screenX: 100, screenY: 200 });
		fireEvent.pointerUp(handle, { button: 0, pointerId: 12, screenX: 120, screenY: 220 });

		innerWidth = 594;
		innerHeight = 99;
		fireEvent.resize(window);
		expect(hudBar.style.left).toBe("calc(50% - 3px)");
		expect(hudBar.style.bottom).toBe("24px");

		act(() => vi.advanceTimersByTime(200));
		innerWidth = 596;
		innerHeight = 100;
		fireEvent.resize(window);
		expect(hudBar.style.left).toBe("calc(50% - 4px)");
		expect(hudBar.style.bottom).toBe("25px");

		act(() => vi.advanceTimersByTime(251));
		innerWidth = 600;
		innerHeight = 104;
		fireEvent.resize(window);
		// The quiet period expired, so an unrelated later content resize is ignored.
		expect(hudBar.style.left).toBe("calc(50% - 4px)");
		expect(hudBar.style.bottom).toBe("25px");
	});

	it("does not treat an intentional vertical tray resize as delayed DPI drag rounding", () => {
		vi.useFakeTimers();
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
		let innerWidth = 588;
		let innerHeight = 95;
		vi.spyOn(window, "innerWidth", "get").mockImplementation(() => innerWidth);
		vi.spyOn(window, "innerHeight", "get").mockImplementation(() => innerHeight);
		const { container } = renderLaunchWindow();
		const handle = screen.getByTestId("launch-drag-handle");
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;

		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});
		fireEvent.pointerDown(handle, { button: 0, pointerId: 13, screenX: 100, screenY: 200 });
		fireEvent.pointerUp(handle, { button: 0, pointerId: 13, screenX: 120, screenY: 220 });

		fireEvent.click(screen.getByTestId("launch-tray-layout-button"));
		expect(hudBar).toHaveAttribute("data-tray-layout", "vertical");

		// The main process now resizes the intentionally tall/narrow content window.
		// This is not the few-pixel Chromium rounding that the drag anchor compensates.
		innerWidth = 220;
		innerHeight = 526;
		fireEvent.resize(window);

		expect(hudBar.style.left).toBe("calc(50% - 0px)");
		expect(hudBar.style.bottom).toBe("20px");
	});

	it("drops vertical drag compensation when switching back to the horizontal tray", () => {
		vi.useFakeTimers();
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ trayLayout: "horizontal" }),
		);
		let innerWidth = 220;
		let innerHeight = 526;
		vi.spyOn(window, "innerWidth", "get").mockImplementation(() => innerWidth);
		vi.spyOn(window, "innerHeight", "get").mockImplementation(() => innerHeight);
		const { container } = renderLaunchWindow();
		const handle = screen.getByTestId("launch-drag-handle");
		const layoutButton = screen.getByTestId("launch-tray-layout-button");
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;

		fireEvent.click(layoutButton);
		expect(hudBar).toHaveAttribute("data-tray-layout", "vertical");
		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});

		fireEvent.pointerDown(handle, { button: 0, pointerId: 14, screenX: 100, screenY: 200 });
		innerWidth = 218;
		innerHeight = 524;
		fireEvent.resize(window);
		expect(hudBar.style.left).toBe("calc(50% + 1px)");
		expect(hudBar.style.bottom).toBe("18px");
		fireEvent.pointerUp(handle, { button: 0, pointerId: 14, screenX: 110, screenY: 210 });

		fireEvent.click(layoutButton);
		expect(hudBar).toHaveAttribute("data-tray-layout", "horizontal");
		expect(hudBar.style.left).toBe("calc(50% - 0px)");
		expect(hudBar.style.bottom).toBe("20px");
	});

	it("defers vertical content sizing until the active drag ends", () => {
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
		const { container } = renderLaunchWindow();
		const handle = screen.getByTestId("launch-drag-handle");
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;
		let naturalWidth = 564;
		let naturalHeight = 48;
		Object.defineProperties(hudBar, {
			scrollWidth: { get: () => naturalWidth, configurable: true },
			scrollHeight: { get: () => naturalHeight, configurable: true },
		});
		Object.defineProperties(handle, {
			setPointerCapture: { value: vi.fn(), configurable: true },
			hasPointerCapture: { value: vi.fn(() => true), configurable: true },
			releasePointerCapture: { value: vi.fn(), configurable: true },
		});

		act(() => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		expect(window.electronAPI.setHudOverlaySize).toHaveBeenLastCalledWith(588, 92);
		vi.mocked(window.electronAPI.setHudOverlaySize).mockClear();

		fireEvent.pointerDown(handle, { button: 0, pointerId: 15, screenX: 100, screenY: 200 });
		naturalWidth = 40;
		naturalHeight = 480;
		act(() => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		expect(window.electronAPI.setHudOverlaySize).not.toHaveBeenCalled();

		fireEvent.pointerUp(handle, { button: 0, pointerId: 15, screenX: 110, screenY: 210 });
		expect(window.electronAPI.setHudOverlaySize).toHaveBeenLastCalledWith(220, 524);
	});

	it("keeps Electron's native drag region on non-Windows platforms", async () => {
		window.electronAPI.platform = "darwin";
		renderLaunchWindow();

		const handle = screen.getByTestId("launch-drag-handle");
		await waitFor(() => expect(handle.className).toMatch(/electronDrag/));
	});

	it("enables mouse input from forwarded root movement over the native drag handle", async () => {
		const { container } = renderLaunchWindow();
		const root = container.firstElementChild as HTMLElement;
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;

		vi.spyOn(hudBar, "getBoundingClientRect").mockReturnValue({
			left: 100,
			right: 300,
			top: 700,
			bottom: 760,
			width: 200,
			height: 60,
			x: 100,
			y: 700,
			toJSON: () => ({}),
		});

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenCalledWith(true);
		});
		vi.mocked(window.electronAPI.setHudOverlayIgnoreMouseEvents).mockClear();

		// Electron's click-through forwarding can target the transparent root even
		// though the pointer is visually over a -webkit-app-region: drag element.
		fireEvent.pointerMove(root, { clientX: 110, clientY: 730 });

		expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenCalledWith(false);
	});

	it("returns the transparent overlay to click-through outside the HUD bounds", async () => {
		const { container } = renderLaunchWindow();
		const root = container.firstElementChild as HTMLElement;
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;

		vi.spyOn(hudBar, "getBoundingClientRect").mockReturnValue({
			left: 100,
			right: 300,
			top: 700,
			bottom: 760,
			width: 200,
			height: 60,
			x: 100,
			y: 700,
			toJSON: () => ({}),
		});

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenCalledWith(true);
		});
		fireEvent.pointerMove(root, { clientX: 110, clientY: 730 });
		vi.mocked(window.electronAPI.setHudOverlayIgnoreMouseEvents).mockClear();

		fireEvent.pointerMove(root, { clientX: 50, clientY: 500 });

		expect(window.electronAPI.setHudOverlayIgnoreMouseEvents).toHaveBeenCalledWith(true);
	});

	it("does not grow the HUD when 125% rounding changes only its viewport position", async () => {
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
		const { container } = renderLaunchWindow();
		const hudBar = container.querySelector("[data-tray-layout]") as HTMLElement;
		let roundedTop = 22.4;
		vi.spyOn(hudBar, "getBoundingClientRect").mockImplementation(() => ({
			left: 11.9,
			right: 576.1,
			top: roundedTop,
			bottom: roundedTop + 49.6,
			width: 564.2,
			height: 49.6,
			x: 11.9,
			y: roundedTop,
			toJSON: () => ({}),
		}));
		Object.defineProperty(hudBar, "scrollHeight", { value: 48, configurable: true });
		Object.defineProperty(hudBar, "scrollWidth", { value: 564, configurable: true });
		vi.mocked(window.electronAPI.setHudOverlaySize).mockClear();

		await act(async () => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalledTimes(1);
		expect(window.electronAPI.setHudOverlaySize).toHaveBeenLastCalledWith(588, 92);

		// Moving the physical window can change fractional viewport top/bottom values,
		// but must not feed those values back into the requested window height.
		roundedTop = 25.6;
		await act(async () => {
			for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
		});
		expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalledTimes(1);
	});
});

describe("LaunchWindow system language prompt", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
		resizeCallbacks.length = 0;
		vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("grows the HUD overlay tall enough to fit the prompt so its buttons stay clickable", async () => {
		i18nState.value.systemLocaleSuggestion = "zh-CN";

		renderLaunchWindow();

		const prompt = await screen.findByText("Use your system language?");
		expect(prompt).toBeInTheDocument();

		// jsdom reports zero layout, so stub both the bar and the prompt to mimic a real HUD.
		const viewportHeight = 800;
		const barHeight = 56;
		const bottomMargin = 20;
		const barBottom = viewportHeight - bottomMargin;
		const bar = prompt.parentElement?.parentElement?.querySelector(
			"[data-tray-layout]",
		) as HTMLElement | null;
		if (bar) {
			vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({
				top: barBottom - barHeight,
				left: 200,
				right: 600,
				bottom: barBottom,
				width: 400,
				height: barHeight,
				x: 200,
				y: barBottom - barHeight,
				toJSON: () => ({}),
			});
			Object.defineProperty(bar, "scrollHeight", { value: barHeight, configurable: true });
			Object.defineProperty(bar, "scrollWidth", { value: 400, configurable: true });
		}

		const promptBox = { width: 480, height: 130 };
		const promptPanel = prompt.parentElement as HTMLElement;
		Object.defineProperty(promptPanel, "scrollHeight", {
			value: promptBox.height,
			configurable: true,
		});
		Object.defineProperty(promptPanel, "offsetHeight", {
			value: promptBox.height,
			configurable: true,
		});
		vi.spyOn(promptPanel, "getBoundingClientRect").mockReturnValue({
			top: 32,
			left: 60,
			right: 60 + promptBox.width,
			bottom: 32 + promptBox.height,
			width: promptBox.width,
			height: promptBox.height,
			x: 60,
			y: 32,
			toJSON: () => ({}),
		});

		// Fire any observers attached during render so the spied rect is actually consumed.
		await act(async () => {
			for (const callback of resizeCallbacks) {
				callback([], {} as ResizeObserver);
			}
		});

		await waitFor(() => {
			expect(window.electronAPI.setHudOverlaySize).toHaveBeenCalled();
		});

		const sizeMock = window.electronAPI.setHudOverlaySize as unknown as {
			mock: { calls: Array<[number, number]> };
		};
		const [, height] = sizeMock.mock.calls[sizeMock.mock.calls.length - 1];
		// Must at least cover the prompt plus the TOP_MARGIN slack (24).
		expect(height).toBeGreaterThanOrEqual(32 + promptBox.height + 24);
		// And must be less than the full viewport — guards against regressions that always
		// grow to the full viewport because of a missed bottom anchor.
		expect(height).toBeLessThan(viewportHeight + 24);
	});
});

describe("LaunchWindow software encoder fallback notice", () => {
	beforeEach(() => {
		platformState.value = "darwin";
		resetLaunchMocks();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("stays hidden while the recorder reports no fallback", () => {
		renderLaunchWindow();

		expect(screen.queryByText("Switched to software encoding")).not.toBeInTheDocument();
	});

	it("shows the notice when the recorder reports a software fallback", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		expect(await screen.findByText("Switched to software encoding")).toBeInTheDocument();
		expect(screen.getByText(/fell back to software H\.264 encoding/)).toBeInTheDocument();
	});

	it("dismisses the notice without persisting when Got it is clicked", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "Got it" }));

		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledTimes(1);
		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledWith();
	});

	it("persists the suppression when Don't show again is clicked", async () => {
		recorderState.value.softwareEncoderFallbackNoticeVisible = true;

		renderLaunchWindow();

		fireEvent.click(await screen.findByRole("button", { name: "Don't show again" }));

		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledTimes(1);
		expect(recorderState.value.dismissSoftwareEncoderFallbackNotice).toHaveBeenCalledWith(true);
	});
});
