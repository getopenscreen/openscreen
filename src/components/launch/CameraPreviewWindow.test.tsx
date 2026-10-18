// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraPreviewState } from "../../lib/cameraPreview";
import { CameraPreviewWindow } from "./CameraPreviewWindow";

const mocks = vi.hoisted(() => ({
	cameras: vi.fn(),
	stream: vi.fn(),
	hide: vi.fn(),
	transform: vi.fn(),
}));
vi.mock("../../contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("../../hooks/useCameraDevices", () => ({ useCameraDevices: mocks.cameras }));
vi.mock("../../hooks/useCameraPreviewStream", () => ({ useCameraPreviewStream: mocks.stream }));
let publish: (state: CameraPreviewState) => void;
let resolveInitial: (state: CameraPreviewState) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.cameras.mockReturnValue({ isReady: false, selectedDeviceId: "", error: null });
	mocks.stream.mockReturnValue({ stream: null, error: null });
	unsubscribe = vi.fn();
	vi.stubGlobal("electronAPI", undefined);
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			getCameraPreviewState: () =>
				new Promise<CameraPreviewState>((resolve) => {
					resolveInitial = resolve;
				}),
			onCameraPreviewState: (callback: (state: CameraPreviewState) => void) => {
				publish = callback;
				return unsubscribe;
			},
			hideCameraPreview: mocks.hide,
			transformCameraPreview: mocks.transform,
		},
	});
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
describe("floating camera preview", () => {
	it("waits for the live camera identity and ignores a stale initial IPC snapshot", async () => {
		render(<CameraPreviewWindow />);
		await act(async () => {
			publish({ enabled: true, deviceId: "new-id", deviceName: "Chosen camera" });
			resolveInitial({ enabled: false, deviceId: "old-id" });
		});
		expect(mocks.cameras).toHaveBeenLastCalledWith(true, "new-id", "Chosen camera");
		expect(mocks.stream).toHaveBeenLastCalledWith({ enabled: false, deviceId: undefined });
		mocks.cameras.mockReturnValue({ isReady: true, selectedDeviceId: "resolved-id", error: null });
		await act(async () => {
			publish({ enabled: true, deviceId: "new-id", deviceName: "Chosen camera" });
		});
		expect(mocks.stream).toHaveBeenLastCalledWith({ enabled: true, deviceId: "resolved-id" });
	});
	it("hides independently of the recording and exposes keyboard resize controls", () => {
		const view = render(<CameraPreviewWindow />);
		fireEvent.click(screen.getByRole("button", { name: "preview.hide" }));
		expect(mocks.hide).toHaveBeenCalledOnce();
		fireEvent.keyDown(screen.getByRole("button", { name: "preview.se" }), { key: "ArrowRight" });
		expect(mocks.transform).toHaveBeenCalledWith({
			action: "nudge",
			direction: "se",
			dx: 5,
			dy: 0,
		});
		view.unmount();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
	it("shows a failure rather than waiting forever when no camera is connected", async () => {
		mocks.cameras.mockReturnValue({ isReady: true, selectedDeviceId: "", error: null });
		render(<CameraPreviewWindow />);
		await act(async () => {
			resolveInitial({ enabled: true });
		});
		expect(screen.getByRole("status").textContent).toBe("webcam.unavailable");
		expect(mocks.stream).toHaveBeenLastCalledWith({ enabled: false, deviceId: undefined });
	});
});
