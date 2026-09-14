// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

describe("RecStage controls", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
});
