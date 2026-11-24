// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WEBCAM_QUALITY_IDS } from "../../hooks/webcamCaptureTarget";
import { TooltipProvider } from "../ui/tooltip";
import { HudDeviceSettings, type HudDeviceSettingsLabels } from "./HudDeviceSettings";

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
	cameraQualityOptions: {
		"1080p": "1080p",
		"1440p": "1440p",
		"2160p": "4K",
	},
	cameraShape: "Camera shape",
	cameraShapeOptions: { default: "Default", square: "Custom" },
	cameraRoundness: "Roundness",
};

function renderPanel(overrides: Partial<Parameters<typeof HudDeviceSettings>[0]> = {}) {
	const onSelectCameraQuality = vi.fn();
	const onChangeCameraRoundness = vi.fn();
	const onSelectCameraShape = vi.fn();
	render(
		// The close button's tooltip needs the provider the app mounts around every window.
		<TooltipProvider>
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
				cameraShape="default"
				onSelectCameraShape={onSelectCameraShape}
				cameraRoundness={0.4}
				onChangeCameraRoundness={onChangeCameraRoundness}
				onSelectMic={vi.fn()}
				onSelectCamera={vi.fn()}
				onCheckForUpdates={vi.fn()}
				onClose={vi.fn()}
				panelRef={() => undefined}
				{...overrides}
			/>
		</TooltipProvider>,
	);
	return { onSelectCameraQuality, onChangeCameraRoundness, onSelectCameraShape };
}

describe("HudDeviceSettings camera shape and roundness", () => {
	it("shows the saved roundness and reports a new one as a fraction", () => {
		const { onChangeCameraRoundness } = renderPanel({ cameraShape: "square" });
		const slider = screen.getByTestId("camera-roundness") as HTMLInputElement;
		expect(slider.value).toBe("40");
		expect(screen.getByText("40%")).toBeTruthy();

		fireEvent.change(slider, { target: { value: "25" } });

		expect(onChangeCameraRoundness).toHaveBeenCalledWith(0.25);
	});

	it("offers Default, checked, and Custom, with no roundness until Custom is picked", () => {
		const { onSelectCameraShape } = renderPanel();
		expect(screen.getByTestId("camera-shape-default").getAttribute("aria-checked")).toBe("true");
		expect(screen.queryByTestId("camera-roundness")).toBeNull();
		expect(screen.getByTestId("camera-shape-square").getAttribute("aria-checked")).toBe("false");

		fireEvent.click(screen.getByTestId("camera-shape-square"));

		expect(onSelectCameraShape).toHaveBeenCalledWith("square");
	});

	it("is not offered without a camera", () => {
		renderPanel({ cameraDevices: [], cameraShape: "square" });
		expect(screen.queryByTestId("camera-roundness")).toBeNull();
		expect(screen.queryByTestId("camera-shape-square")).toBeNull();
	});
});

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
