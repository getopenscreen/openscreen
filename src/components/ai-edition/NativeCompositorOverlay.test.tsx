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
}));

vi.mock("@/native", () => ({
	pushAllNativeParams: vi.fn(),
	setActiveClip: native.setActiveClip,
	setCurrentNativeViewId: vi.fn(),
	setNativePlaying: native.setNativePlaying,
	setNativeScene: vi.fn(),
	subscribeNativeCompositor: () => () => undefined,
	useIsCpuCompositor: () => false,
	useNativeCompositorView: () => ({ viewId: 7, error: null }),
}));

vi.mock("@/contexts/I18nContext", () => ({
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
