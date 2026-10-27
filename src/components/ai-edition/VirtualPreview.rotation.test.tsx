// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CropRegion } from "@/components/video-editor/types";
import type { ClipRotation } from "@/lib/ai-edition/clipRotation";
import { VirtualPreview } from "./VirtualPreview";

beforeEach(() => {
	// No playback here: the frames are never run.
	vi.stubGlobal("requestAnimationFrame", () => 0);
	vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function videoStyle(cropRegion: CropRegion | null, rotation?: ClipRotation) {
	const view = render(
		<VirtualPreview
			videoSources={[{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }]}
			clips={[
				{
					id: "clip_1",
					assetId: "a1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			]}
			onTimeChange={vi.fn()}
			cropRegion={cropRegion}
			rotation={rotation}
		/>,
	);
	const video = view.container.querySelector("video");
	if (!video) throw new Error("no <video> rendered");
	return video.style;
}

describe("VirtualPreview rotation", () => {
	const CROP = { x: 0.125, y: 0.25, width: 0.5, height: 0.25 };

	it("positions an upright clip by its crop, unturned", () => {
		const style = videoStyle(CROP);
		expect([style.left, style.top, style.transform]).toEqual(["-25%", "-100%", ""]);
	});

	it("positions a turned clip by the mirrored crop and turns it", () => {
		// Mirrored crop: x 0.375, y 0.5. Turned about its centre, the element then shows the
		// stored crop.
		const style = videoStyle(CROP, 180);
		expect([style.width, style.height]).toEqual(["200%", "400%"]);
		expect([style.left, style.top, style.transform]).toEqual(["-75%", "-200%", "rotate(180deg)"]);
	});

	it("only turns an uncropped clip", () => {
		const style = videoStyle(null, 180);
		expect([style.position, style.left, style.transform]).toEqual(["", "", "rotate(180deg)"]);
	});
});
