// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutClip, clipCropRegionSchema } from "@/lib/ai-edition/schema";
import { EditClipModal } from "./Modals";

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

/** Issue #558's example: original 2:35, keep 0:20–1:45, final 1:25. */
const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 20,
	sourceEndSec: 105,
	timelineStartSec: 0,
	timelineEndSec: 85,
	wordRefs: [],
	origin: "user",
	reason: "",
};

const ASSET = { label: "rec", durationSec: 155 };

beforeAll(() => {
	// The trim-handle drag converts pointer delta against the track width into
	// seconds. jsdom reports 0, which would make every drag a no-op.
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get() {
			return this.getAttribute?.("data-testid") === "edit-clip-trim-track" ? 1550 : 0;
		},
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderModal(clip: AxcutClip = CLIP) {
	return renderWithI18n(
		<EditClipModal
			open
			onClose={vi.fn()}
			clip={clip}
			assetMeta={ASSET}
			videoSources={[]}
			onApply={vi.fn()}
		/>,
	);
}

describe("EditClipModal trim duration readout (#558)", () => {
	it("shows original duration, trim range, and final duration for the selected range", () => {
		renderModal();

		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent("2:35.0");
		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent(
			"Original duration",
		);
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:20.0–1:45.0");
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("Trim range");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:25.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("Final duration");
	});

	it("updates the final duration as the start handle is dragged", () => {
		renderModal();

		fireEvent.pointerDown(screen.getByRole("button", { name: "Adjust clip start" }), {
			clientX: 0,
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100 }));
		});

		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent("2:35.0");
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:30.0–1:45.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:15.0");
	});

	it("will not pass the out-point off as the source length", () => {
		// `durationSec` is optional in the asset schema, so a document can reach
		// this dialog without one. The track still has to be drawn against
		// something that contains the selection (the out-point), but calling that
		// the original duration would claim a 2:35 source was 1:45 long.
		renderWithI18n(
			<EditClipModal
				open
				onClose={vi.fn()}
				clip={CLIP}
				assetMeta={{ label: "rec" }}
				videoSources={[]}
				onApply={vi.fn()}
			/>,
		);

		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent("—");
		expect(screen.getByTestId("edit-clip-original-duration")).not.toHaveTextContent("1:45.0");
		// The kept range and its length are still known, and still shown.
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:20.0–1:45.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:25.0");
	});

	it("states the kept range once, in the stats row", () => {
		renderModal();

		// The range used to be printed a second time inside the selection bar, 40px
		// under the stat that now carries it. One reading of a number is enough.
		expect(screen.getAllByText("0:20.0–1:45.0")).toHaveLength(1);
	});

	it("updates the final duration as the end handle is dragged", () => {
		renderModal();

		fireEvent.pointerDown(screen.getByRole("button", { name: "Adjust clip end" }), {
			clientX: 0,
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: -50 }));
		});

		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:20.0–1:40.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:20.0");
	});
});

describe("EditClipModal in a short window (#1005)", () => {
	// The actions used to sit at the end of the scrolling body. In a window too short for the
	// card, Apply was clipped out of view, and a click where it should have been landed on the
	// backdrop, which closed the dialog and dropped the new trim and crop without a word.
	function renderWithSpies() {
		const onClose = vi.fn();
		const onApply = vi.fn();
		renderWithI18n(
			<EditClipModal
				open
				onClose={onClose}
				clip={CLIP}
				assetMeta={ASSET}
				videoSources={[]}
				onApply={onApply}
			/>,
		);
		return { onClose, onApply };
	}

	function clickBackdrop() {
		const backdrop = document.querySelector('[class*="modalBackdrop"]');
		if (!backdrop) throw new Error("no modal backdrop rendered");
		fireEvent.click(backdrop);
	}

	it("keeps the actions out of the scrolling body", () => {
		renderWithSpies();
		const apply = screen.getByRole("button", { name: "Apply" });

		expect(apply.closest('[class*="modalBody"]')).toBeNull();
		expect(apply.closest('[class*="modalFoot"]')).not.toBeNull();
	});

	it("closes on a backdrop click while there is nothing to lose", () => {
		const { onClose } = renderWithSpies();

		clickBackdrop();

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"a trim",
			() => {
				fireEvent.pointerDown(screen.getByRole("button", { name: "Adjust clip start" }), {
					clientX: 0,
				});
				act(() => {
					window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100 }));
					window.dispatchEvent(new MouseEvent("pointerup"));
				});
			},
		],
		["a crop", () => fireEvent.click(screen.getByRole("button", { name: "1:1" }))],
	])("keeps %s through a backdrop click, and drops it on Escape or Cancel", (_, edit) => {
		const { onClose, onApply } = renderWithSpies();
		edit();

		clickBackdrop();
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();

		// Those two say "discard"; a click beside the card does not.
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onApply).not.toHaveBeenCalled();
	});
});

describe("EditClipModal crop from the keyboard", () => {
	it("moves the crop with the arrows and resizes it with Shift + the arrows", () => {
		const onApply = vi.fn();
		renderWithI18n(
			<EditClipModal
				open
				onClose={vi.fn()}
				clip={CLIP}
				assetMeta={ASSET}
				videoSources={[]}
				onApply={onApply}
			/>,
		);
		// The editor shell seeks on the arrows from window: the crop must keep them.
		const seek = vi.fn();
		window.addEventListener("keydown", seek);
		try {
			const crop = screen.getByRole("slider", { name: "Crop" });
			fireEvent.keyDown(crop, { key: "ArrowLeft", shiftKey: true });
			fireEvent.keyDown(crop, { key: "ArrowRight" });
			expect(seek).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("keydown", seek);
		}
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(onApply).toHaveBeenCalledWith(
			20,
			105,
			expect.objectContaining({ x: 0.01, y: 0, width: 0.99 }),
			undefined,
		);
	});
});

describe("EditClipModal playhead for framing the crop", () => {
	// jsdom has no media pipeline: stand in a clock the modal can seek.
	let videoTime = 0;
	let readyState = 1;
	afterEach(() => {
		readyState = 1;
	});
	beforeAll(() => {
		Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
			configurable: true,
			get: () => videoTime,
			set: (v: number) => {
				videoTime = v;
			},
		});
		Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
			configurable: true,
			get: () => readyState,
		});
		HTMLMediaElement.prototype.pause = vi.fn();
	});

	function renderWithVideo() {
		const onClose = vi.fn();
		renderWithI18n(
			<EditClipModal
				open
				onClose={onClose}
				clip={CLIP}
				assetMeta={ASSET}
				videoSources={[{ id: "asset_1", src: "file:///rec.mp4", label: "rec" }]}
				onApply={vi.fn()}
			/>,
		);
		return { onClose };
	}
	// 1550px track over 155s: 10px a second.
	const playheadPct = () => screen.getByTestId("edit-clip-playhead").style.left;
	const pct = (sec: number) => `${(sec / 155) * 100}%`;
	const drag = (target: HTMLElement, fromX: number, toX: number) => {
		fireEvent.pointerDown(target, { clientX: fromX });
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: toX }));
			window.dispatchEvent(new MouseEvent("pointerup"));
		});
	};

	it("opens on the in-point and shows the frame under a click or drag of the track", () => {
		renderWithVideo();
		expect(playheadPct()).toBe(pct(20));
		expect(videoTime).toBe(20);
		const track = screen.getByTestId("edit-clip-trim-track");

		fireEvent.pointerDown(track, { clientX: 500 });
		expect(playheadPct()).toBe(pct(50));
		expect(videoTime).toBe(50);
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 700 }));
		});
		expect(playheadPct()).toBe(pct(70));
		expect(videoTime).toBe(70);
	});

	it("holds the playhead inside the kept range", () => {
		renderWithVideo();
		const track = screen.getByTestId("edit-clip-trim-track");

		drag(track, 500, 1500);
		expect(playheadPct()).toBe(pct(105));
		expect(videoTime).toBe(105);
		drag(track, 50, 50);
		expect(playheadPct()).toBe(pct(20));
		expect(videoTime).toBe(20);
	});

	it("is pushed along by a trim that crosses it, and stays there", () => {
		renderWithVideo();
		drag(screen.getByTestId("edit-clip-trim-track"), 500, 500);
		const end = screen.getByRole("button", { name: "Adjust clip end" });

		drag(end, 0, -600);
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:20.0–0:45.0");
		expect(playheadPct()).toBe(pct(45));
		expect(videoTime).toBe(45);

		drag(end, 0, 300);
		expect(playheadPct()).toBe(pct(45));
		expect(videoTime).toBe(45);

		drag(screen.getByRole("button", { name: "Adjust clip start" }), 0, 400);
		expect(playheadPct()).toBe(pct(60));
		expect(videoTime).toBe(60);
	});

	it("keeps a scrub made before the video's metadata loads", () => {
		readyState = 0;
		videoTime = 0;
		renderWithVideo();
		drag(screen.getByTestId("edit-clip-trim-track"), 500, 500);
		expect(videoTime).toBe(0);

		readyState = 1;
		const video = document.querySelector("video");
		if (!video) throw new Error("no preview video rendered");
		act(() => {
			video.dispatchEvent(new Event("loadedmetadata"));
		});
		expect(videoTime).toBe(50);
	});

	it("is not an edit: Apply stays off and the backdrop still closes", () => {
		const { onClose } = renderWithVideo();
		drag(screen.getByTestId("edit-clip-trim-track"), 500, 800);

		expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
		const backdrop = document.querySelector('[class*="modalBackdrop"]');
		if (!backdrop) throw new Error("no modal backdrop rendered");
		fireEvent.click(backdrop);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("EditClipModal rotation", () => {
	// Stored in source coordinates; on the turned picture this crop sits at 40%, 50%.
	const TURNED: AxcutClip = {
		...CLIP,
		cropRegion: { x: 0.1, y: 0.2, width: 0.5, height: 0.3 },
		rotation: 180,
	};

	function renderTurned(clip: AxcutClip = TURNED) {
		const onApply = vi.fn();
		renderWithI18n(
			<EditClipModal
				open
				onClose={vi.fn()}
				clip={clip}
				assetMeta={ASSET}
				videoSources={[]}
				onApply={onApply}
			/>,
		);
		return { onApply };
	}
	const cropText = () =>
		screen.getByRole("slider", { name: "Crop" }).getAttribute("aria-valuetext");
	const rotationButton = (name: string) =>
		within(screen.getByRole("group", { name: "Rotation" })).getByRole("button", { name });

	it("shows a turned clip's crop mirrored, and opens with nothing to apply", () => {
		renderTurned();

		expect(cropText()).toBe("40%, 50%, 50% × 30%");
		expect(rotationButton("180°")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
	});

	it("keeps the stored crop when the rotation is toggled", () => {
		const { onApply } = renderTurned();

		fireEvent.click(rotationButton("0°"));
		// The frame jumps with the picture: upright, the stored crop shows as stored.
		expect(cropText()).toBe("10%, 20%, 50% × 30%");
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		expect(onApply).toHaveBeenCalledWith(20, 105, undefined, 0);
	});

	it("turns an upright clip, keeping its crop", () => {
		const { onApply } = renderTurned({ ...TURNED, rotation: undefined });

		expect(cropText()).toBe("10%, 20%, 50% × 30%");
		fireEvent.click(rotationButton("180°"));
		expect(cropText()).toBe("40%, 50%, 50% × 30%");
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		expect(onApply).toHaveBeenCalledWith(20, 105, undefined, 180);
	});

	it("Reset restores the stored rotation", () => {
		renderTurned();

		fireEvent.click(rotationButton("0°"));
		expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));

		expect(rotationButton("180°")).toHaveAttribute("aria-pressed", "true");
		expect(cropText()).toBe("40%, 50%, 50% × 30%");
		expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
	});

	it("Apply converts a crop moved on the turned picture back to source coordinates", () => {
		const { onApply } = renderTurned();

		// One step right and one down on the turned picture is one left and one up in the source.
		const crop = screen.getByRole("slider", { name: "Crop" });
		fireEvent.keyDown(crop, { key: "ArrowRight" });
		fireEvent.keyDown(crop, { key: "ArrowDown" });
		expect(cropText()).toBe("41%, 51%, 50% × 30%");
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		expect(onApply).toHaveBeenCalledWith(
			20,
			105,
			{
				x: expect.closeTo(0.09, 9),
				y: expect.closeTo(0.19, 9),
				width: expect.closeTo(0.5, 9),
				height: expect.closeTo(0.3, 9),
			},
			undefined,
		);
	});

	it("saves a crop moved flush against the turned picture's edge", () => {
		// 1 - 0.9 - 0.1 is -2.8e-17 in floating point, which the schema rejects as below 0.
		const { onApply } = renderTurned({
			...TURNED,
			cropRegion: { x: 0.01, y: 0.01, width: 0.1, height: 0.1 },
		});

		const crop = screen.getByRole("slider", { name: "Crop" });
		fireEvent.keyDown(crop, { key: "ArrowRight" });
		fireEvent.keyDown(crop, { key: "ArrowDown" });
		expect(cropText()).toBe("90%, 90%, 10% × 10%");
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));

		const saved = onApply.mock.calls[0][2];
		expect(saved.x).toBeGreaterThanOrEqual(0);
		expect(saved.y).toBeGreaterThanOrEqual(0);
		expect(clipCropRegionSchema.safeParse(saved).success).toBe(true);
	});

	it("turns the crop preview's picture, not the frame drawn over it", () => {
		renderWithI18n(
			<EditClipModal
				open
				onClose={vi.fn()}
				clip={TURNED}
				assetMeta={ASSET}
				videoSources={[{ id: "asset_1", src: "file:///rec.mp4", label: "rec" }]}
				onApply={vi.fn()}
			/>,
		);
		const video = document.querySelector("video");
		if (!video) throw new Error("no preview video rendered");
		expect(video.style.transform).toBe("rotate(180deg)");

		fireEvent.click(rotationButton("0°"));
		expect(video.style.transform).toBe("");
	});
});
