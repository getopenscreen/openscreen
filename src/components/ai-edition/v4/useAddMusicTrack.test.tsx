// @vitest-environment jsdom
// Placing a bundled track. The defaults are the feature (see the hook's header), so what
// this pins is that a pick turns into the RIGHT bed, not merely into one.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutAsset } from "@/lib/ai-edition/schema";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import type { MusicTrack } from "@/lib/music";
import { useAddMusicTrack } from "./useAddMusicTrack";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const store = {
	document: null as null | {
		assets: Array<Partial<AxcutAsset>>;
		timeline: { clips: Array<{ timelineEndSec: number }> };
	},
	currentTimeSec: 0,
	addAudioAsset: vi.fn(),
};
vi.mock("@/lib/ai-edition/store/projectStore", () => ({
	useProjectStore: { getState: () => store },
}));

const BED_PATH = "/Applications/Openscreen.app/Contents/Resources/music/sleepy-clouds.ogg";

const TRACK: MusicTrack = {
	id: "sleepy-clouds",
	file: "sleepy-clouds.ogg",
	title: "Sleepy Clouds",
	author: "fupi",
	durationSec: 76.3,
	mood: ["ambient"],
	license: "CC0-1.0",
	licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
	sourceUrl: "https://opengameart.org/content/sleepy-clouds",
};

const resolveMusicTrack = vi.fn();
const addAudioTrack = vi.fn();

function hook() {
	const tl = { addAudioTrack } as unknown as ReturnType<typeof useTimeline>;
	return renderHook(() => useAddMusicTrack(tl)).result.current;
}

beforeEach(() => {
	store.document = { assets: [], timeline: { clips: [{ timelineEndSec: 300 }] } };
	store.currentTimeSec = 0;
	store.addAudioAsset.mockResolvedValue({ id: "asset_new", kind: "audio", originalPath: BED_PATH });
	resolveMusicTrack.mockResolvedValue({ success: true, path: BED_PATH });
	addAudioTrack.mockResolvedValue("audio_1");
	(window as unknown as { electronAPI?: unknown }).electronAPI = { resolveMusicTrack };
});

afterEach(() => {
	vi.clearAllMocks();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("useAddMusicTrack", () => {
	// Picking the same bed twice is one file under two tracks. A second import of the path
	// would leave two assets on it, and `addAudioAsset` finds the one it just added BY PATH,
	// so its duration probe would patch the first.
	it("reuses the asset already imported for that track", async () => {
		store.document?.assets.push({ id: "asset_existing", kind: "audio", originalPath: BED_PATH });
		await hook()(TRACK);
		expect(store.addAudioAsset).not.toHaveBeenCalled();
		expect(addAudioTrack).toHaveBeenCalledWith("asset_existing", 0, expect.anything());
		expect(toastError).not.toHaveBeenCalled();
	});

	// The placement and every default are one write, so one undo step, and a failed save
	// cannot leave a half-configured bed at unity gain behind.
	it("places the bed with its defaults in a single timeline call", async () => {
		await hook()(TRACK);
		expect(addAudioTrack).toHaveBeenCalledTimes(1);
		expect(addAudioTrack.mock.calls[0][2]).toMatchObject({
			kind: "music",
			initial: { gainDb: -18, fadeInMs: 500, fadeOutMs: 500 },
		});
	});

	// Null covers a failed save; the user still has to learn the pick did not land.
	it("says so when the track could not be placed", async () => {
		addAudioTrack.mockResolvedValue(null);
		await hook()(TRACK);
		expect(toastError).toHaveBeenCalledWith("audio.musicAddFailed");
	});

	describe("when the track cannot be had", () => {
		it("reports a refused resolve with the main process's reason, and adds nothing", async () => {
			resolveMusicTrack.mockResolvedValue({ success: false, message: "Unknown catalogue track" });
			await hook()(TRACK);
			expect(toastError).toHaveBeenCalledWith("audio.musicAddFailed", {
				description: "Unknown catalogue track",
			});
			expect(store.addAudioAsset).not.toHaveBeenCalled();
			expect(addAudioTrack).not.toHaveBeenCalled();
		});

		it("reports a rejected IPC call instead of letting it escape", async () => {
			resolveMusicTrack.mockRejectedValue(new Error("channel closed"));
			await expect(hook()(TRACK)).resolves.toBeUndefined();
			expect(toastError).toHaveBeenCalledWith("audio.musicAddFailed", {
				description: "channel closed",
			});
			expect(addAudioTrack).not.toHaveBeenCalled();
		});

		it("reports a failed import, and places nothing", async () => {
			store.addAudioAsset.mockResolvedValue(null);
			await hook()(TRACK);
			expect(toastError).toHaveBeenCalledWith("audio.musicAddFailed");
			expect(addAudioTrack).not.toHaveBeenCalled();
		});
	});

	describe("placement", () => {
		// 300 s programme, 76.3 s bed.
		it("lays the bed at the playhead", async () => {
			store.currentTimeSec = 42;
			await hook()(TRACK);
			expect(addAudioTrack).toHaveBeenCalledWith("asset_new", 42, expect.anything());
		});

		// Never more of the ruler than the file has: looping, not the span, fills the rest.
		it("spans the file's own length when more of the programme is left than that", async () => {
			store.currentTimeSec = 10;
			await hook()(TRACK);
			expect(addAudioTrack.mock.calls[0][2]).toMatchObject({ durationSec: 76.3, spanSec: 76.3 });
		});

		it("spans only what is left of the programme when that is shorter", async () => {
			store.currentTimeSec = 280;
			await hook()(TRACK);
			expect(addAudioTrack.mock.calls[0][2]).toMatchObject({ durationSec: 76.3, spanSec: 20 });
		});

		// Past the end there is nothing to cover; the bed still gets a real span to grab.
		it("falls back to the file's length at or past the end of the programme", async () => {
			store.currentTimeSec = 300;
			await hook()(TRACK);
			expect(addAudioTrack.mock.calls[0][2]).toMatchObject({ spanSec: 76.3 });
		});
	});

	describe("defaults", () => {
		// The defaults ARE the feature: a bed at unity gain with no fades buries the voice.
		it("sits the bed at -18 dB with 500 ms fades on each edge", async () => {
			await hook()(TRACK);
			expect(addAudioTrack.mock.calls[0][2].initial).toMatchObject({
				gainDb: -18,
				fadeInMs: 500,
				fadeOutMs: 500,
			});
		});

		it("loops a bed that is shorter than what is left of the programme", async () => {
			store.currentTimeSec = 0; // 300 s left for a 76.3 s bed
			await hook()(TRACK);
			expect(addAudioTrack.mock.calls[0][2].initial.loop).toBe(true);
		});

		it("does not loop a bed that already reaches the end", async () => {
			store.currentTimeSec = 250; // 50 s left
			await hook()(TRACK);
			expect(addAudioTrack.mock.calls[0][2].initial.loop).toBe(false);
		});

		// A track a frame or two short of the end is covering it, not falling short.
		it("loops only when the bed falls more than 0.05 s short", async () => {
			const remaining = (sec: number) => {
				store.currentTimeSec = 300 - sec;
			};
			const loopFor = async (leftSec: number) => {
				addAudioTrack.mockClear();
				remaining(leftSec);
				await hook()(TRACK);
				return addAudioTrack.mock.calls[0][2].initial.loop;
			};
			// Either side of the threshold by a margin float rounding cannot cross.
			expect(await loopFor(76.3 + 0.07)).toBe(true);
			expect(await loopFor(76.3 + 0.03)).toBe(false);
			expect(await loopFor(76.3)).toBe(false);
		});
	});

	it("imports the track when the project does not hold it yet", async () => {
		await hook()(TRACK);
		expect(store.addAudioAsset).toHaveBeenCalledWith(BED_PATH, "Sleepy Clouds");
		expect(addAudioTrack).toHaveBeenCalledWith("asset_new", 0, expect.anything());
	});
});
