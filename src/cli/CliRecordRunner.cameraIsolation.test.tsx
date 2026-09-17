// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { CliRecordRunner } from "./CliRecordRunner";

const persistedPrefs = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: true,
	camDeviceId: "cam1",
	camDeviceName: "Camera 1",
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay" as const,
};

describe("CliRecordRunner camera isolation", () => {
	const getUserMedia = vi.fn(async () => ({
		getTracks: () => [],
		getVideoTracks: () => [],
	}));

	beforeAll(() => {
		window.history.replaceState(null, "", "/?windowType=cli-record");
		Object.defineProperty(global.navigator, "mediaDevices", {
			configurable: true,
			value: {
				enumerateDevices: vi.fn(async () => []),
				getUserMedia,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			},
		});
	});

	beforeEach(() => {
		getUserMedia.mockClear();
		window.electronAPI = {
			getRecordingPrefs: vi.fn(async () => persistedPrefs),
			onRecordingPrefsChanged: vi.fn(() => () => undefined),
			getPlatform: vi.fn(() => "win32"),
			getSelectedSource: vi.fn(async () => null),
			cliGetRequest: vi.fn(
				() =>
					new Promise(() => {
						/* source/request stay pending */
					}),
			),
			cliLog: vi.fn(),
			cliDone: vi.fn(async () => undefined),
			onCliStopRecording: vi.fn(() => () => undefined),
			getCurrentRecordingSession: vi.fn(async () => ({ success: false, session: null })),
			getSources: vi.fn(
				() =>
					new Promise(() => {
						/* enumeration pending */
					}),
			),
			selectSource: vi.fn(),
		} as unknown as typeof window.electronAPI;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not acquire webcam from GUI prefs while CLI source enumeration is pending", async () => {
		render(<CliRecordRunner />);
		await waitFor(() => expect(window.electronAPI.getRecordingPrefs).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(getUserMedia).not.toHaveBeenCalled();
	});
});
