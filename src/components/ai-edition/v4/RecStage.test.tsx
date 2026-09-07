// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecStage } from "./RecStage";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: () => ({
		devices: [],
		selectedDeviceId: "default",
		setSelectedDeviceId: vi.fn(),
		isLoading: false,
	}),
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

vi.mock("@/hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));

vi.mock("@/hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({ stream: null, error: null }),
}));

vi.mock("@/hooks/usePortalOwnsSource", () => ({
	usePortalOwnsSource: () => false,
}));

function stubRecordingPrefs(prefs: Record<string, unknown> = {}) {
	const getRecordingPrefs = vi.fn(async () => prefs);
	const setRecordingPrefs = vi.fn(async () => undefined);
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		getRecordingPrefs,
		setRecordingPrefs,
		getSelectedSource: vi.fn(async () => null),
	};
	return { getRecordingPrefs, setRecordingPrefs };
}

function renderRecStage() {
	const onStartRecording = vi.fn();
	render(<RecStage onStartRecording={onStartRecording} />);
	return { onStartRecording };
}

describe("RecStage auto-zoom", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	});

	it("defaults on when a legacy prefs blob has no autoZoomEnabled key", async () => {
		const { getRecordingPrefs } = stubRecordingPrefs({
			micEnabled: false,
			cursorCaptureMode: "editable-overlay",
		});
		renderRecStage();
		await waitFor(() => {
			expect(getRecordingPrefs).toHaveBeenCalled();
		});
		const button = await screen.findByTestId("rec-auto-zoom-button");
		expect(button).toHaveAttribute("aria-pressed", "true");
		expect(button).toHaveTextContent("rec.on");
		expect(button).toBeEnabled();
	});

	it("writes autoZoomEnabled through setRecordingPrefs on click", async () => {
		const { setRecordingPrefs } = stubRecordingPrefs({
			cursorCaptureMode: "editable-overlay",
			autoZoomEnabled: true,
		});
		renderRecStage();
		const button = await screen.findByTestId("rec-auto-zoom-button");
		await waitFor(() => {
			expect(button).toBeEnabled();
		});
		fireEvent.click(button);
		expect(setRecordingPrefs).toHaveBeenCalledWith({ autoZoomEnabled: false });
	});

	it("disables auto-zoom while Rec-stage cursor capture is system", async () => {
		const { setRecordingPrefs } = stubRecordingPrefs({
			cursorCaptureMode: "system",
			autoZoomEnabled: true,
		});
		renderRecStage();
		const button = await screen.findByTestId("rec-auto-zoom-button");
		await waitFor(() => {
			expect(button).toBeDisabled();
		});
		expect(button).toHaveAttribute("title", "rec.autoZoomNeedsEditableCursor");
		expect(button).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(button);
		expect(setRecordingPrefs).not.toHaveBeenCalled();
	});
});
