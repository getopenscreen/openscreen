// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
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
		);
	});
});

describe("EditClipModal preview transport", () => {
	// jsdom has no media pipeline: stand in a clock the modal can seek, and a rAF the test
	// steps by hand.
	let videoTime = 0;
	let frame: FrameRequestCallback | null = null;
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
			get: () => 1,
		});
		HTMLMediaElement.prototype.play = () => Promise.resolve();
		HTMLMediaElement.prototype.pause = vi.fn();
	});
	beforeEach(() => {
		videoTime = 0;
		frame = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			frame = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
	});
	afterEach(() => vi.unstubAllGlobals());

	const renderWithVideo = () =>
		renderWithI18n(
			<EditClipModal
				open
				onClose={vi.fn()}
				clip={CLIP}
				assetMeta={ASSET}
				videoSources={[{ id: "asset_1", src: "file:///rec.mp4", label: "rec" }]}
				onApply={vi.fn()}
			/>,
		);
	// 1550px track over 155s: 10px a second.
	const playheadPct = () => screen.getByTestId("edit-clip-playhead").style.left;
	const pct = (sec: number) => `${(sec / 155) * 100}%`;

	it("scrubs on a click or drag of the track, held inside the kept range", () => {
		renderWithVideo();
		const track = screen.getByTestId("edit-clip-trim-track");

		fireEvent.pointerDown(track, { clientX: 500 });
		expect(playheadPct()).toBe(pct(50));
		expect(videoTime).toBe(50);

		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 1500 }));
		});
		expect(playheadPct()).toBe(pct(105));
		act(() => {
			window.dispatchEvent(new MouseEvent("pointerup"));
		});
		fireEvent.pointerDown(track, { clientX: 50 });
		expect(playheadPct()).toBe(pct(20));
	});

	it("plays and pauses on Space, and steps on the arrows", () => {
		renderWithVideo();
		const play = screen.getByTestId("edit-clip-play");

		fireEvent.keyDown(document.body, { key: " " });
		expect(play).toHaveAttribute("aria-pressed", "true");
		videoTime = 30;
		act(() => frame?.(0));
		expect(playheadPct()).toBe(pct(30));
		fireEvent.keyDown(document.body, { key: " " });
		expect(play).toHaveAttribute("aria-pressed", "false");

		fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
		expect(playheadPct()).toBe(pct(31));
		expect(videoTime).toBe(31);
	});

	it("stops at the out-point, and plays again from the in-point", () => {
		renderWithVideo();
		const play = screen.getByTestId("edit-clip-play");

		fireEvent.click(play);
		videoTime = 106;
		act(() => frame?.(0));
		expect(play).toHaveAttribute("aria-pressed", "false");
		expect(playheadPct()).toBe(pct(105));

		fireEvent.click(play);
		expect(videoTime).toBe(20);
	});

	it("shows the held trim handle's frame, then goes back to the playhead", () => {
		renderWithVideo();
		fireEvent.pointerDown(screen.getByTestId("edit-clip-trim-track"), { clientX: 500 });
		act(() => {
			window.dispatchEvent(new MouseEvent("pointerup"));
		});

		fireEvent.pointerDown(screen.getByRole("button", { name: "Adjust clip end" }), {
			clientX: 0,
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: -100 }));
		});
		expect(videoTime).toBe(95);

		act(() => {
			window.dispatchEvent(new MouseEvent("pointerup"));
		});
		expect(videoTime).toBe(50);
	});
});
