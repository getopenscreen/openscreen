// @vitest-environment jsdom
/**
 * How the overlay steers the native view while the transport plays.
 *
 * The view runs its own clock and crosses clip boundaries by itself. The overlay used to
 * re-send the clip at every cut anyway, which made the view seek back to a place it had just
 * left, or drop the next clip it had preloaded: a hitch at every cut of an edited take. Now it
 * reads where the view is from the position each frame reports, and only steps in when the
 * view is somewhere else.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { publishNativePosition } from "@/native/nativeSync";

const native = vi.hoisted(() => ({
	setActiveClip: vi.fn(async () => ({ ok: true })),
	setNativePlaying: vi.fn(),
	setNativeScene: vi.fn(),
}));
const i18n = vi.hoisted(() => ({ locale: "en" }));

vi.mock("@/native", () => ({
	pushAllNativeParams: vi.fn(),
	setActiveClip: native.setActiveClip,
	setCurrentNativeViewId: vi.fn(),
	setNativePlaying: native.setNativePlaying,
	setNativeScene: native.setNativeScene,
	subscribeNativeCompositor: () => () => undefined,
	useIsCpuCompositor: () => false,
	useNativeCompositorView: () => ({ viewId: 7, error: null }),
}));

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: i18n.locale }),
	useScopedT: () => (key: string) => key,
}));

import { NativeCompositorOverlay } from "./NativeCompositorOverlay";

/** One take cut in two: source 0-5 s, then 7-12 s after a 2 s cut. */
const FIRST: AxcutClip = {
	id: "clip_a",
	assetId: "asset_take",
	sourceStartSec: 0,
	sourceEndSec: 5,
	timelineStartSec: 0,
	timelineEndSec: 5,
	wordRefs: [],
	origin: "system",
	reason: "",
};
const SECOND: AxcutClip = {
	...FIRST,
	id: "clip_b",
	sourceStartSec: 7,
	sourceEndSec: 12,
	timelineStartSec: 5,
	timelineEndSec: 10,
};

function makeDocument(): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_sync",
			title: "Sync",
			createdAt: "2026-10-02T08:00:00.000Z",
			updatedAt: "2026-10-02T08:00:00.000Z",
			primaryAssetId: "asset_take",
		},
		assets: [
			{
				id: "asset_take",
				kind: "video",
				label: "take",
				originalPath: "/take.mp4",
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [FIRST, SECOND],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: null,
	};
}

function setPlayhead(currentTimeSec: number, playing: boolean) {
	act(() => {
		useProjectStore.setState({ currentTimeSec, playing });
	});
}

describe("NativeCompositorOverlay while playing", () => {
	let now = 1000;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(performance, "now").mockImplementation(() => now);
		useProjectStore.setState({
			projectId: "proj_sync",
			document: makeDocument(),
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 12,
			currentTimeSec: 4.9,
			playing: true,
			dirty: false,
			lastSavedAt: new Date(),
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		publishNativePosition(null);
		useProjectStore.getState().clear();
	});

	async function mountAtFirstClip() {
		render(<NativeCompositorOverlay />);
		// The first mount sends the starting clip, and its reply resumes the view: let both
		// settle, so only what follows is under test.
		await act(async () => {
			await Promise.resolve();
		});
		native.setActiveClip.mockClear();
		native.setNativePlaying.mockClear();
	}

	it("lets the view cross a cut by itself", async () => {
		await mountAtFirstClip();
		publishNativePosition({ clipIndex: 0, sourceTimeSec: 4.99 }, now);

		setPlayhead(5.02, true);

		expect(native.setActiveClip).not.toHaveBeenCalled();
		expect(native.setNativePlaying).not.toHaveBeenCalled();
	});

	it("follows a jump to another clip at once, without pausing the view", async () => {
		await mountAtFirstClip();
		publishNativePosition({ clipIndex: 0, sourceTimeSec: 4.9 }, now);

		setPlayhead(8, true);

		expect(native.setActiveClip).toHaveBeenCalledWith(7, "/take.mp4", "", 0, 1, 10);
		expect(native.setNativePlaying).not.toHaveBeenCalledWith(false);
	});

	it("re-anchors a view that stays behind, once the gap holds", async () => {
		await mountAtFirstClip();
		// The view stalled 0.4 s behind the playhead, inside the first clip.
		publishNativePosition({ clipIndex: 0, sourceTimeSec: 2 }, now);
		setPlayhead(2.4, true);
		expect(native.setActiveClip).not.toHaveBeenCalled();

		now += 120;
		publishNativePosition({ clipIndex: 0, sourceTimeSec: 2.12 }, now);
		setPlayhead(2.52, true);

		expect(native.setActiveClip).toHaveBeenCalledTimes(1);
		expect(native.setActiveClip).toHaveBeenCalledWith(7, "/take.mp4", "", 0, 0, 2.52);
	});

	// At 16× a frame that takes 30 ms to arrive shows the playhead 0.48 s of programme ago.
	it("leaves alone a view keeping pace inside a speed region", async () => {
		useProjectStore.setState({
			document: {
				...makeDocument(),
				legacyEditor: { speedRegions: [{ id: "speed_a", startMs: 0, endMs: 12000, speed: 16 }] },
			},
			currentTimeSec: 0.2,
		});
		await mountAtFirstClip();

		for (let frame = 0; frame < 8; frame++) {
			now += 30;
			publishNativePosition({ clipIndex: 0, sourceTimeSec: 0.2 + frame * 0.48 }, now);
			setPlayhead(0.2 + (frame + 1) * 0.48, true);
		}

		expect(native.setActiveClip).not.toHaveBeenCalled();
	});

	// Two copies of one take: only the clip index tells them apart, and the scrub enters the left
	// copy by its end. The view must be sent there, or it keeps the right copy's crop and zoom.
	it("sends the left copy back when scrubbing into it while paused", async () => {
		const left: AxcutClip = {
			...FIRST,
			id: "clip_left",
			sourceStartSec: 0,
			sourceEndSec: 14.5,
			timelineStartSec: 0,
			timelineEndSec: 14.5,
		};
		const right: AxcutClip = {
			...left,
			id: "clip_right",
			timelineStartSec: 14.5,
			timelineEndSec: 29,
		};
		const document = makeDocument();
		useProjectStore.setState({
			document: { ...document, timeline: { ...document.timeline, clips: [left, right] } },
			sourceDurationSec: 14.5,
			currentTimeSec: 20,
			playing: false,
		});
		await mountAtFirstClip();
		publishNativePosition({ clipIndex: 1, sourceTimeSec: 5.5 }, now);

		for (const time of [16, 15, 14.6, 14.4, 12, 9]) {
			now += 16;
			setPlayhead(time, false);
		}

		expect(native.setActiveClip).toHaveBeenCalledWith(7, "/take.mp4", "", 0, 0, 14.4);
		expect(native.setActiveClip).toHaveBeenLastCalledWith(7, "/take.mp4", "", 0, 0, 14.4);
	});

	it("still sends the clip on a change while paused", async () => {
		useProjectStore.setState({ playing: false });
		await mountAtFirstClip();
		publishNativePosition({ clipIndex: 0, sourceTimeSec: 4.9 }, now);

		setPlayhead(6, false);

		expect(native.setActiveClip).toHaveBeenCalledWith(7, "/take.mp4", "", 0, 1, 8);
	});

	// An addon that reports no position cannot be read, so it is driven as before.
	it("pauses the view across the swap when it reports no position", async () => {
		await mountAtFirstClip();

		setPlayhead(5.02, true);

		expect(native.setNativePlaying).toHaveBeenCalledWith(false);
		expect(native.setActiveClip).toHaveBeenCalledTimes(1);
	});
});

// The desk-view label is generated text inside the scene, so the scene is rebuilt when the
// user switches language — otherwise the preview keeps the old label until the next edit.
describe("NativeCompositorOverlay on a language change", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		i18n.locale = "en";
		useProjectStore.setState({
			projectId: "proj_sync",
			document: makeDocument(),
			revision: 1,
			status: "ready",
			error: null,
			sourceDurationSec: 12,
			currentTimeSec: 1,
			playing: false,
			dirty: false,
			lastSavedAt: new Date(),
		});
	});

	afterEach(() => {
		cleanup();
		i18n.locale = "en";
		useProjectStore.getState().clear();
	});

	it("pushes the scene again when the locale changes", async () => {
		const { rerender } = render(<NativeCompositorOverlay />);
		await act(async () => {
			await Promise.resolve();
		});
		native.setNativeScene.mockClear();

		i18n.locale = "de";
		rerender(<NativeCompositorOverlay />);

		expect(native.setNativeScene).toHaveBeenCalledTimes(1);
	});
});
