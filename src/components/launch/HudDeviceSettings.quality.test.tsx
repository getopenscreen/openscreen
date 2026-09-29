// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WEBCAM_QUALITY_IDS } from "../../hooks/webcamCaptureTarget";
import { HudDeviceSettings, type HudDeviceSettingsLabels } from "./HudDeviceSettings";

vi.mock("../../hooks/useAudioLevelMeter", () => ({
	useAudioLevelMeter: () => ({ level: 0 }),
}));
vi.mock("../../hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({ stream: null, error: null }),
}));

const labels: HudDeviceSettingsLabels = {
	title: "Device settings",
	done: "Done",
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
	cameraQualityOptions: {
		"1080p": "1080p",
		"1440p": "1440p",
		"2160p": "4K",
	},
};

function renderPanel(overrides: Partial<Parameters<typeof HudDeviceSettings>[0]> = {}) {
	const onSelectCameraQuality = vi.fn();
	render(
		<HudDeviceSettings
			showMicrophone
			micDevices={[]}
			cameraDevices={[{ deviceId: "cam-1", label: "Logitech BRIO", groupId: "group-1" }]}
			activeMicId={undefined}
			activeCameraId="cam-1"
			cameraLoading={false}
			cameraError={null}
			labels={labels}
			versionLabel={null}
			canCheckForUpdates={false}
			checkingForUpdates={false}
			cameraQuality="1440p"
			onSelectCameraQuality={onSelectCameraQuality}
			onSelectMic={vi.fn()}
			onSelectCamera={vi.fn()}
			onCheckForUpdates={vi.fn()}
			onClose={vi.fn()}
			panelRef={() => undefined}
			{...overrides}
		/>,
	);
	return { onSelectCameraQuality };
}

describe("HudDeviceSettings camera quality", () => {
	it("offers every preset the capture pipeline knows about", () => {
		renderPanel();

		for (const id of WEBCAM_QUALITY_IDS) {
			expect(screen.getByTestId(`camera-quality-${id}`)).toBeTruthy();
		}
	});

	it("marks the stored choice as the checked one", () => {
		renderPanel();

		expect(screen.getByTestId("camera-quality-1440p").getAttribute("aria-checked")).toBe("true");
		expect(screen.getByTestId("camera-quality-2160p").getAttribute("aria-checked")).toBe("false");
	});

	it("reports the picked preset so it can be persisted", () => {
		const { onSelectCameraQuality } = renderPanel();

		fireEvent.click(screen.getByTestId("camera-quality-2160p"));

		expect(onSelectCameraQuality).toHaveBeenCalledWith("2160p");
	});

	it("hides the choice when there is no camera to apply it to", () => {
		// A resolution picker above "No camera found" is a control that cannot do
		// anything, and it pushes the real message out of view.
		renderPanel({ cameraDevices: [], activeCameraId: undefined });

		expect(screen.queryByTestId("camera-quality-2160p")).toBeNull();
	});
});
