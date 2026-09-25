// @vitest-environment jsdom
// The layout preset is a global setting but the camera is per clip, so a project can
// hold no camera at all (#248). These pin what the pane shows in that case: the
// controls go dead, the preset reads "No webcam", and — the part that is easy to break —
// the saved preference is left untouched on disk and the help popover says so.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { LayoutPane } from "./RightPanes";

function seedProject(hasCamera: boolean): AxcutDocument {
	const base = createEmptyDocument({ projectId: "project_layout", title: "Layout" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.webm",
				originalPath: "/tmp/screen.webm",
				durationSec: 10,
				video: { codec: "unknown", width: 1920, height: 1080, fps: 30 },
				cameraTrack: hasCamera
					? { sourcePath: "/tmp/camera.webm", startMs: 0, offsetMs: 0, visible: true }
					: null,
			},
		],
		project: { ...base.project, primaryAssetId: "asset_1" },
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "test",
				},
			],
		},
		legacyEditor: { webcamLayoutPreset: "picture-in-picture" },
	};
}

// `doc` rather than `document`: this is a jsdom file, and shadowing the global would
// silently redirect any `document.querySelector` a later test adds.
function renderLayout(doc: AxcutDocument) {
	useProjectStore.setState({
		projectId: doc.project.id,
		document: doc,
		revision: 1,
		status: "ready",
	});
	return render(
		<I18nProvider>
			<LayoutPane />
		</I18nProvider>,
	);
}

beforeEach(() => {
	// The assertions below are on English copy; without pinning they would ride on
	// jsdom's implicit en-US and pass vacuously if the fallback ever changed.
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	useProjectStore.getState().clear();
});

describe("LayoutPane camera availability", () => {
	it("shows No webcam without overwriting the saved camera preset", () => {
		renderLayout(seedProject(false));

		const preset = screen.getByRole("group", { name: "Preset" });
		for (const tile of within(preset).getAllByRole("button")) {
			expect(tile).toBeDisabled();
		}
		expect(within(preset).getByRole("button", { name: "No webcam" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			webcamLayoutPreset: "picture-in-picture",
		});
		expect(screen.queryByText("Camera shape")).not.toBeInTheDocument();
		expect(screen.queryByText("Shrink on zoom")).not.toBeInTheDocument();
		expect(screen.queryByText("Webcam size")).not.toBeInTheDocument();
		const mirrorRow = screen.getByText("Mirror webcam").closest("div");
		expect(mirrorRow).not.toBeNull();
		expect(within(mirrorRow as HTMLElement).getByRole("button")).toBeDisabled();
	});

	it("tells the user the saved preset was kept rather than thrown away", async () => {
		const user = userEvent.setup();
		renderLayout(seedProject(false));

		await user.click(screen.getByRole("button", { name: "Help" }));
		expect(screen.getByRole("note")).toHaveTextContent(/saved layout is kept/i);
	});

	it("keeps the saved preset active when a timeline clip has a camera", async () => {
		const user = userEvent.setup();
		renderLayout(seedProject(true));

		const preset = screen.getByRole("group", { name: "Preset" });
		for (const tile of within(preset).getAllByRole("button")) {
			expect(tile).toBeEnabled();
		}
		expect(within(preset).getByRole("button", { name: "Picture in picture" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByText("Camera shape")).toBeInTheDocument();
		expect(screen.getByText("Shrink on zoom")).toBeInTheDocument();
		expect(screen.getByText("Webcam size")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Square" })).toBeEnabled();
		// Named, because the pane holds several sliders. This one is the size slider the
		// line above just found.
		expect(screen.getByRole("slider", { name: "Webcam size" })).toBeEnabled();

		// The camera-less hint must not leak into the normal case.
		await user.click(screen.getByRole("button", { name: "Help" }));
		expect(screen.getByRole("note")).not.toHaveTextContent(/saved layout is kept/i);
	});
});

describe("LayoutPane webcam framing picture", () => {
	// Shown in the camera's own shape only: before its metadata the box is a 16:9 guess, and a
	// picture drawn in it would be stretched.
	it("shows the camera once its own shape is known", () => {
		renderLayout(seedProject(true));
		const video = document.querySelector('[class*="framingVideo"]') as HTMLVideoElement;
		expect(video.style.visibility).toBe("hidden");

		Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
		Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
		fireEvent.loadedMetadata(video);

		expect(video.style.visibility).toBe("visible");
	});
});

describe("LayoutPane picture-in-picture camera", () => {
	const stored = () => useProjectStore.getState().document?.legacyEditor as Record<string, unknown>;

	it("sets the shape and its roundness as two separate settings", () => {
		renderLayout(seedProject(true));
		const shapes = within(screen.getByRole("group", { name: "Camera shape" })).getAllByRole(
			"button",
		);
		expect(shapes.map((b) => b.textContent)).toEqual(["Rectangle", "Square"]);
		fireEvent.click(screen.getByRole("button", { name: "Square" }));
		expect(stored()).toMatchObject({ webcamMaskShape: "square" });
		fireEvent.change(screen.getByRole("slider", { name: "Roundness" }), {
			target: { value: "100" },
		});
		// Each control moves its own axis only: full roundness leaves the shape a square.
		expect(stored()).toMatchObject({ webcamMaskShape: "square", webcamRoundness: 1 });
	});

	it("places the camera on one of eight anchors, bottom right by default", () => {
		renderLayout(seedProject(true));
		const grid = screen.getByRole("group", { name: "Position" });
		expect(within(grid).getAllByRole("button")).toHaveLength(8);
		expect(within(grid).getByRole("button", { name: "Bottom right" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		fireEvent.click(within(grid).getByRole("button", { name: "Top left" }));
		expect(stored()).toMatchObject({ webcamAnchor: "top-left" });
	});

	// The middle of the frame is a hole in the grid, not a ninth place to land.
	it("steps over the middle of the grid with the arrow keys", () => {
		renderLayout(seedProject(true));
		const grid = screen.getByRole("group", { name: "Position" });
		const left = within(grid).getByRole("button", { name: "Left" });
		left.focus();
		fireEvent.keyDown(left, { key: "ArrowRight" });
		expect(within(grid).getByRole("button", { name: "Right" })).toHaveFocus();
		expect(stored()).toMatchObject({ webcamAnchor: "right" });
	});

	it("keeps the camera under 35% of the frame", () => {
		renderLayout(seedProject(true));
		expect(screen.getByRole("slider", { name: "Webcam size" })).toHaveAttribute("max", "35");
	});
});

// #412. The pan used to be read back out of the crop rect, which cannot hold it: at 100%
// zoom the crop IS the frame, so its offset is 0 for every pan the user could have chosen.
// A trip down to 100% therefore erased the framing rather than suspending it.
describe("LayoutPane webcam crop pan", () => {
	const zoom = () => screen.getByRole("slider", { name: "Zoom" });
	// The frame on the camera picture: dragged by pointer, moved 5% a step by the arrows.
	const frame = () => screen.getByRole("slider", { name: "Webcam crop" });
	const set = (slider: HTMLElement, value: number) =>
		fireEvent.change(slider, { target: { value: String(value) } });
	const press = (key: string, times: number) => {
		for (let i = 0; i < times; i++) fireEvent.keyDown(frame(), { key });
	};
	const storedCrop = () =>
		useProjectStore.getState().document?.legacyEditor as unknown as {
			webcamCropRegion: { x: number; y: number; width: number; height: number };
			webcamCropPan: { x: number; y: number };
		};

	it("keeps the pan across a round trip through 100% zoom", () => {
		renderLayout(seedProject(true));

		set(zoom(), 200);
		press("ArrowRight", 5);
		expect(frame()).toHaveAttribute("aria-valuetext", "75%, 50%");

		set(zoom(), 100);
		// Nowhere to pan at full frame, so the frame is correctly out of reach, and says why...
		expect(frame()).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByText(/zoom in, then drag the frame/i)).toBeInTheDocument();
		press("ArrowLeft", 3);
		expect(storedCrop().webcamCropPan.x).toBeCloseTo(0.75);

		set(zoom(), 200);
		// ...but the intent survived the trip.
		expect(frame()).toHaveAttribute("aria-valuetext", "75%, 50%");
	});

	it("does not move the pan while the zoom slider is dragged", () => {
		// The old clamp squeezed the rect's offset toward the near edge as the window grew,
		// so the pan crept on its own while the picture stayed put.
		renderLayout(seedProject(true));

		set(zoom(), 200);
		press("ArrowRight", 5);

		for (const pct of [180, 150, 120, 110, 101]) {
			set(zoom(), pct);
			expect(frame()).toHaveAttribute("aria-valuetext", "75%, 50%");
		}
	});

	it("moves the frame on the axis each arrow names", () => {
		// Up/down and left/right differ by one character in the handler. Without this, a
		// vertical arrow wired to x would pass every other test in this block.
		renderLayout(seedProject(true));

		set(zoom(), 200);
		press("ArrowDown", 6);

		expect(storedCrop().webcamCropPan.y).toBeCloseTo(0.8);
		expect(storedCrop().webcamCropRegion.y).toBeCloseTo(0.4);
		// ...and it left the horizontal axis alone.
		expect(storedCrop().webcamCropPan.x).toBeCloseTo(0.5);
		expect(storedCrop().webcamCropRegion.x).toBeCloseTo(0.25);
	});

	it("puts the crop where the pan says, at any zoom", () => {
		renderLayout(seedProject(true));

		set(zoom(), 200);
		press("ArrowRight", 20);
		// Hard against the right edge: a half-width window starts halfway across.
		let crop = storedCrop().webcamCropRegion;
		expect(crop.width).toBeCloseTo(0.5);
		expect(crop.x).toBeCloseTo(0.5);

		set(zoom(), 400);
		// Clamped to the slider's 300% ceiling, so a third of the frame, still hard right.
		crop = storedCrop().webcamCropRegion;
		expect(crop.x).toBeCloseTo(1 - crop.width);
	});
});
