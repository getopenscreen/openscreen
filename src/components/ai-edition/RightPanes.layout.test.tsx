// @vitest-environment jsdom
// The layout preset is a global setting but the camera is per clip, so a project can
// hold no camera at all (#248). These pin what the pane shows in that case: the
// controls go dead, the preset reads "No webcam", and — the part that is easy to break —
// the saved preference is left untouched on disk and the help popover says so.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { LayoutPane } from "./RightPanes";

const segmentation = vi.hoisted(() => ({ supported: false, segmentCameraFrame: vi.fn() }));
vi.mock("@/native/hooks/useSegmentationSupport", () => ({
	useCanSegmentCamera: () => segmentation.supported,
}));
vi.mock("@/native/compositorViewClient", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/native/compositorViewClient")>()),
	segmentCameraFrame: segmentation.segmentCameraFrame,
}));

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

// The thumbnail shows the camera background the preview draws. The promise that makes it
// cheap: nothing runs while the background is the camera's own, and the frame is segmented
// once, every later change of mode, blur or wallpaper being CSS over the same mask.
describe("LayoutPane webcam framing background", () => {
	beforeEach(() => {
		segmentation.supported = true;
		segmentation.segmentCameraFrame.mockResolvedValue(new Uint8Array(256 * 144).fill(255));
		// jsdom has no 2D canvas; the thumbnail only draws into one and reads it back.
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: vi.fn(),
			getImageData: (_x: number, _y: number, w: number, h: number) => ({
				data: new Uint8ClampedArray(w * h * 4),
			}),
			createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
			putImageData: vi.fn(),
		} as unknown as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA");
	});
	afterEach(() => {
		segmentation.supported = false;
		segmentation.segmentCameraFrame.mockReset();
		vi.restoreAllMocks();
	});

	const withBackground = (webcamBackgroundMode: string) => {
		const doc = seedProject(true);
		return { ...doc, legacyEditor: { ...doc.legacyEditor, webcamBackgroundMode } };
	};
	/** Loads the thumbnail's frame the way the browser would: metadata, then the seek. */
	const showFrame = () => {
		const video = document.querySelector('[class*="framingVideo"]') as HTMLVideoElement;
		Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
		Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
		fireEvent.loadedMetadata(video);
		fireEvent.seeked(video);
		return video;
	};
	const backdrop = () =>
		document.querySelector('[class*="framingBox"] > div[aria-hidden="true"]') as HTMLElement | null;

	it("segments nothing while the camera keeps its own background", () => {
		renderLayout(withBackground("none"));
		const video = showFrame();

		expect(segmentation.segmentCameraFrame).not.toHaveBeenCalled();
		expect(video.style.maskImage).toBe("");
		expect(backdrop()).toBeNull();
	});

	it("cuts the subject out once, then restyles the background around it", async () => {
		renderLayout(withBackground("blur"));
		const video = showFrame();

		await waitFor(() => expect(video.style.maskImage).toContain("data:image/png"));
		expect(backdrop()?.style.filter).toMatch(/^blur\(/);

		fireEvent.click(screen.getByRole("button", { name: "Custom" }));
		expect(backdrop()?.style.filter).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "Cutout" }));
		expect(backdrop()).toBeNull();
		expect(video.style.maskImage).toContain("data:image/png");

		expect(segmentation.segmentCameraFrame).toHaveBeenCalledTimes(1);
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
	// The frame on the camera picture: dragged by pointer, moved 5% a step by the arrows,
	// zoomed 10% a step by + and -, and by its corners.
	const frame = () => screen.getByRole("slider", { name: "Webcam crop" });
	const press = (key: string, times: number) => {
		for (let i = 0; i < times; i++) fireEvent.keyDown(frame(), { key });
	};
	const storedCrop = () =>
		useProjectStore.getState().document?.legacyEditor as unknown as {
			webcamCropRegion: { x: number; y: number; width: number; height: number };
			webcamCropPan: { x: number; y: number };
		};
	/** A project already framed at 200%, centred. */
	const at200 = () => {
		const doc = seedProject(true);
		return {
			...doc,
			legacyEditor: {
				...doc.legacyEditor,
				webcamCropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
				webcamCropPan: { x: 0.5, y: 0.5 },
			},
		};
	};

	it("keeps the pan across a round trip through 100% zoom", () => {
		renderLayout(at200());

		press("ArrowRight", 5);
		expect(frame()).toHaveAttribute("aria-valuetext", "75%, 50%");

		press("-", 10);
		expect(storedCrop().webcamCropRegion.width).toBe(1);
		// Nowhere to pan at full frame, so the arrows do nothing there...
		press("ArrowLeft", 3);
		expect(storedCrop().webcamCropPan.x).toBeCloseTo(0.75);

		press("+", 8);
		// ...but the intent survived the trip.
		expect(frame()).toHaveAttribute("aria-valuetext", "75%, 50%");
	});

	it("does not move the pan while zooming", () => {
		// The old clamp squeezed the rect's offset toward the near edge as the window grew,
		// so the pan crept on its own while the picture stayed put.
		renderLayout(at200());
		press("ArrowRight", 5);

		for (let i = 0; i < 6; i++) {
			press("-", 1);
			expect(frame()).toHaveAttribute("aria-valuetext", "75%, 50%");
		}
	});

	it("moves the frame on the axis each arrow names", () => {
		// Up/down and left/right differ by one character in the handler. Without this, a
		// vertical arrow wired to x would pass every other test in this block.
		renderLayout(at200());
		press("ArrowDown", 6);

		expect(storedCrop().webcamCropPan.y).toBeCloseTo(0.8);
		expect(storedCrop().webcamCropRegion.y).toBeCloseTo(0.4);
		// ...and it left the horizontal axis alone.
		expect(storedCrop().webcamCropPan.x).toBeCloseTo(0.5);
		expect(storedCrop().webcamCropRegion.x).toBeCloseTo(0.25);
	});

	it("puts the crop where the pan says, at any zoom", () => {
		renderLayout(at200());
		press("ArrowRight", 20);
		// Hard against the right edge: a half-width window starts halfway across.
		let crop = storedCrop().webcamCropRegion;
		expect(crop.width).toBeCloseTo(0.5);
		expect(crop.x).toBeCloseTo(0.5);

		press("+", 20);
		// Held at 300%, so a third of the frame, still hard right.
		crop = storedCrop().webcamCropRegion;
		expect(crop.width).toBeCloseTo(1 / 3);
		expect(crop.x).toBeCloseTo(1 - crop.width);
	});

	// A crop tool's contract: the corner you pull moves, the one across stays, and the frame
	// keeps the camera's shape, so its size is the only thing a corner changes.
	it("zooms by a corner, keeping the opposite corner and the shape", () => {
		const box = { left: 0, top: 0, right: 200, bottom: 112.5, width: 200, height: 112.5 };
		const spy = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockReturnValue({ ...box, x: 0, y: 0, toJSON: () => box } as DOMRect);
		try {
			renderLayout(at200());
			const corner = document.querySelector('[data-corner="se"]') as HTMLElement;
			fireEvent.pointerDown(corner, { clientX: 150, clientY: 84 });
			fireEvent.pointerMove(corner, { clientX: 190, clientY: 84 });
			fireEvent.pointerUp(corner, { clientX: 190, clientY: 84 });

			const crop = storedCrop().webcamCropRegion;
			expect(crop.x).toBeCloseTo(0.25);
			expect(crop.y).toBeCloseTo(0.25);
			expect(crop.width).toBeCloseTo(0.7);
			expect(crop.height).toBeCloseTo(0.7);
			expect(screen.getByText("143%")).toBeInTheDocument();
		} finally {
			spy.mockRestore();
		}
	});
});
