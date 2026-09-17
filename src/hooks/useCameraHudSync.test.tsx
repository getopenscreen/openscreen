// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraHudSync } from "./useCameraHudSync";

const mockDevices = [
	{ kind: "videoinput", deviceId: "cam1", label: "Camera 1", groupId: "group1" },
	{ kind: "videoinput", deviceId: "cam2", label: "Camera 2", groupId: "group1" },
];

const mockEnumerateDevices = vi.fn().mockResolvedValue(mockDevices);

Object.defineProperty(global.navigator, "mediaDevices", {
	value: {
		enumerateDevices: mockEnumerateDevices,
		getUserMedia: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	},
	configurable: true,
});

function useRecorderBackedCameraSync() {
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(undefined);
	const [webcamDeviceName, setWebcamDeviceName] = useState<string | undefined>(undefined);
	const [recordingPrefsLoaded, setRecordingPrefsLoaded] = useState(false);
	const camera = useCameraHudSync({
		webcamDeviceId,
		webcamDeviceName,
		recordingPrefsLoaded,
		setWebcamDeviceId,
		setWebcamDeviceName,
	});
	return {
		camera,
		webcamDeviceId,
		webcamDeviceName,
		recordingPrefsLoaded,
		setRecordingPrefsLoaded,
		applyPersistedCamera: (id: string, name: string) => {
			setWebcamDeviceId(id);
			setWebcamDeviceName(name);
			setRecordingPrefsLoaded(true);
		},
	};
}

describe("useCameraHudSync", () => {
	beforeEach(() => {
		mockEnumerateDevices.mockResolvedValue(mockDevices);
	});

	it("keeps enumeration cam1 off the recorder until persisted cam2 arrives, then settles", async () => {
		let renders = 0;
		const { result } = renderHook(() => {
			renders += 1;
			return useRecorderBackedCameraSync();
		});

		await waitFor(() => {
			expect(result.current.camera.selectedDeviceId).toBe("cam1");
		});
		expect(result.current.webcamDeviceId).toBeUndefined();
		expect(result.current.recordingPrefsLoaded).toBe(false);

		act(() => {
			result.current.applyPersistedCamera("cam2", "Camera 2");
		});

		await waitFor(() => {
			expect(result.current.camera.selectedDeviceId).toBe("cam2");
			expect(result.current.webcamDeviceId).toBe("cam2");
			expect(result.current.camera.isReady).toBe(true);
		});

		const settled = renders;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(result.current.camera.selectedDeviceId).toBe("cam2");
		expect(result.current.webcamDeviceId).toBe("cam2");
		expect(renders - settled).toBeLessThanOrEqual(2);
	});
});
