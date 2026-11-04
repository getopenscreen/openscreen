// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import type { HudDeviceSettingsLabels } from "./HudDeviceSettings";
import { HudPanelWindow } from "./HudPanelWindow";
import { EMPTY_HUD_PANEL_STATE, type HudPanelAction, type HudPanelState } from "./hudPanel";

vi.mock("../../hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));
vi.mock("../../hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({ stream: null, error: null }),
}));

const labels: HudDeviceSettingsLabels = {
	title: "Device settings",
	close: "Close",
	microphone: "Microphone",
	camera: "Camera",
	micLevel: "Input level",
	micHint: "Speak to check",
	noMicrophones: "No microphone found",
	searching: "Searching...",
	noCameras: "No camera found",
	cameraUnavailable: "Camera unavailable",
	preview: "Preview",
	previewUnavailable: "Preview unavailable",
	about: "About",
	checkForUpdates: "Check for updates",
	checkingForUpdates: "Checking…",
	cameraQuality: "Camera quality",
	cameraQualityOptions: { "1080p": "1080p", "1440p": "1440p", "2160p": "4K" },
};

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

let pushState: ((state: HudPanelState) => void) | null;
let sentActions: HudPanelAction[];

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	pushState = null;
	sentActions = [];
	window.electronAPI = {
		...window.electronAPI,
		onHudPanelState: vi.fn((callback: (state: HudPanelState) => void) => {
			pushState = callback;
			return () => {
				pushState = null;
			};
		}),
		sendHudPanelAction: vi.fn((action: HudPanelAction) => {
			sentActions.push(action);
		}),
		setHudPanelSize: vi.fn(),
		requestHudPanelState: vi.fn(),
	};
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function renderPanel(state: HudPanelState) {
	render(
		<TooltipProvider>
			<HudPanelWindow />
		</TooltipProvider>,
	);
	act(() => pushState?.(state));
}

describe("HudPanelWindow", () => {
	it("renders the device settings the HUD sent and sends a pick back as an action", () => {
		const mic = { deviceId: "mic-2", label: "USB mic", groupId: "g" };
		renderPanel({
			...EMPTY_HUD_PANEL_STATE,
			deviceSettings: {
				showMicrophone: true,
				micDevices: [{ deviceId: "mic-1", label: "Built-in", groupId: "g" }, mic],
				cameraDevices: [],
				activeMicId: "mic-1",
				activeCameraId: undefined,
				cameraLoading: false,
				cameraError: null,
				labels,
				versionLabel: "Version 2.1.2",
				canCheckForUpdates: false,
				checkingForUpdates: false,
				cameraQuality: "1080p",
			},
		});

		expect(screen.getByTestId("hud-device-settings")).toBeInTheDocument();
		fireEvent.click(screen.getByText("USB mic"));
		expect(sentActions).toContainEqual({ kind: "select-mic", device: mic });

		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(sentActions).toContainEqual({ kind: "close-device-settings" });
	});

	it("sends a notice's choice back with the notice's id", () => {
		renderPanel({
			...EMPTY_HUD_PANEL_STATE,
			notices: [
				{
					id: "system-locale",
					title: "Use French?",
					description: "Your system is set to French.",
					dismissLabel: "Keep English",
					confirmLabel: "Switch",
				},
			],
		});

		fireEvent.click(screen.getByRole("button", { name: "Switch" }));
		expect(sentActions).toEqual([{ kind: "notice", id: "system-locale", choice: "confirm" }]);
	});

	it("reports its size on every snapshot, so a hidden panel is shown again", () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			width: 380.2,
			height: 140.6,
		} as DOMRect);
		renderPanel(EMPTY_HUD_PANEL_STATE);
		const sizeMock = window.electronAPI.setHudPanelSize as unknown as ReturnType<typeof vi.fn>;
		sizeMock.mockClear();

		act(() =>
			pushState?.({
				...EMPTY_HUD_PANEL_STATE,
				toasts: [{ id: 1, type: "default", title: "Saved", revision: 1 }],
			}),
		);

		expect(sizeMock).toHaveBeenCalledWith(381, 141);
		vi.restoreAllMocks();
	});

	it("asks for the current snapshot once it is listening, so none is lost to a late mount", () => {
		renderPanel(EMPTY_HUD_PANEL_STATE);
		expect(window.electronAPI.requestHudPanelState).toHaveBeenCalledTimes(1);
	});

	it("closes popovers on Escape", () => {
		renderPanel(EMPTY_HUD_PANEL_STATE);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(sentActions).toEqual([{ kind: "close-popovers" }]);
	});

	it("times a toast out itself and reports the dismissal, since the HUD runs no toaster", () => {
		vi.useFakeTimers();
		renderPanel({
			...EMPTY_HUD_PANEL_STATE,
			toasts: [
				{ id: "fail", type: "error", title: "Recording failed", revision: 1, duration: 5000 },
			],
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Recording failed");

		act(() => vi.advanceTimersByTime(4999));
		expect(sentActions).toEqual([]);
		act(() => vi.advanceTimersByTime(1));
		expect(sentActions).toEqual([{ kind: "toast-dismiss", id: "fail" }]);
	});

	it("times a toast with no duration of its own like the app's toaster", () => {
		vi.useFakeTimers();
		renderPanel({
			...EMPTY_HUD_PANEL_STATE,
			toasts: [{ id: "saved", type: "success", title: "Saved", revision: 1 }],
		});

		act(() => vi.advanceTimersByTime(2999));
		expect(sentActions).toEqual([]);
		act(() => vi.advanceTimersByTime(1));
		expect(sentActions).toEqual([{ kind: "toast-dismiss", id: "saved" }]);
	});

	it("restarts the timer of a toast replaced under the same id", () => {
		vi.useFakeTimers();
		const toast = {
			id: "upload",
			type: "default" as const,
			title: "Uploading",
			revision: 1,
			duration: 3000,
		};
		renderPanel({ ...EMPTY_HUD_PANEL_STATE, toasts: [toast] });

		act(() => vi.advanceTimersByTime(2000));
		act(() => pushState?.({ ...EMPTY_HUD_PANEL_STATE, toasts: [{ ...toast, title: "Uploaded" }] }));
		act(() => vi.advanceTimersByTime(2000));
		expect(sentActions).toEqual([]);
		act(() => vi.advanceTimersByTime(1000));
		expect(sentActions).toEqual([{ kind: "toast-dismiss", id: "upload" }]);
	});

	// sonner restarts a same-id replacement's full duration even when nothing about it changed;
	// the toast it replaced must not dismiss it with the time it had left.
	it("restarts the timer of a same-id toast replaced with identical content", () => {
		vi.useFakeTimers();
		const toast = {
			id: "copy",
			type: "default" as const,
			title: "Copied",
			duration: 3000,
			revision: 1,
		};
		renderPanel({ ...EMPTY_HUD_PANEL_STATE, toasts: [toast] });

		act(() => vi.advanceTimersByTime(2000));
		act(() => pushState?.({ ...EMPTY_HUD_PANEL_STATE, toasts: [{ ...toast, revision: 2 }] }));
		act(() => vi.advanceTimersByTime(2000));
		expect(sentActions).toEqual([]);
		act(() => vi.advanceTimersByTime(1000));
		expect(sentActions).toEqual([{ kind: "toast-dismiss", id: "copy" }]);
	});

	it("names the dismiss button with the label the HUD translated, and follows a change", () => {
		const toasts = [{ id: "note", type: "default" as const, title: "Heads up", revision: 1 }];
		renderPanel({ ...EMPTY_HUD_PANEL_STATE, toasts, toastCloseLabel: "Close notification" });
		expect(screen.getByRole("button", { name: "Close notification" })).toBeInTheDocument();

		// A language picked in the HUD reaches the panel in the next snapshot.
		act(() =>
			pushState?.({ ...EMPTY_HUD_PANEL_STATE, toasts, toastCloseLabel: "Fermer la notification" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Fermer la notification" }));
		expect(sentActions).toEqual([{ kind: "toast-dismiss", id: "note" }]);
	});

	it("keeps a loading toast until the HUD replaces or dismisses it", () => {
		vi.useFakeTimers();
		renderPanel({
			...EMPTY_HUD_PANEL_STATE,
			toasts: [{ id: "save", type: "loading", title: "Saving…", revision: 1 }],
		});
		act(() => vi.advanceTimersByTime(60_000));
		expect(sentActions).toEqual([]);
	});

	it("sends a toast's action back to the HUD", () => {
		renderPanel({
			...EMPTY_HUD_PANEL_STATE,
			toasts: [
				{
					id: "perm",
					type: "warning",
					title: "Needs a permission",
					revision: 1,
					actionLabel: "Open",
				},
			],
		});
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		expect(sentActions).toEqual([{ kind: "toast-action", id: "perm" }]);
	});
});
