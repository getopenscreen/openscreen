// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import type { SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

// The rAF tick is the whole subject here, so it is driven by hand rather than by the
// browser: `tick()` runs exactly one frame, which is what makes "what did the loop decide
// at 9.96 s?" an assertion instead of a race.
let frameCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
	frameCallbacks = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		frameCallbacks.push(cb);
		return frameCallbacks.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		// Frames are drained by `tick()`, never scheduled, so there is nothing to cancel —
		// the stub only exists so the effect's cleanup has something to call.
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function tick() {
	const pending = frameCallbacks;
	frameCallbacks = [];
	act(() => {
		for (const cb of pending) cb(0);
	});
}

function clip(
	id: string,
	assetId: string,
	sourceStartSec: number,
	sourceEndSec: number,
	timelineStartSec: number,
): AxcutClip {
	return {
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

/** A `<video>` jsdom will not drive: its clock is set by the test, and play/pause are
 *  recorded rather than performed (jsdom implements neither). */
function driveVideo(element: HTMLVideoElement) {
	let currentTime = 0;
	let paused = true;
	const pauseCalls: number[] = [];
	Object.defineProperty(element, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
		},
	});
	Object.defineProperty(element, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 });
	Object.defineProperty(element, "duration", { configurable: true, get: () => 10 });
	element.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	element.pause = vi.fn(() => {
		paused = true;
		pauseCalls.push(currentTime);
	});
	return {
		pauseCalls,
		play: () => {
			paused = false;
		},
		seekTo: (next: number) => {
			currentTime = next;
		},
		get currentTime() {
			return currentTime;
		},
	};
}

function mount(clips: AxcutClip[], trimRanges: AxcutTrimRange[] = []) {
	const onTimeChange = vi.fn();
	const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
	const { container } = render(
		<VirtualPreview
			videoSources={sources}
			clips={clips}
			trimRanges={trimRanges}
			onTimeChange={onTimeChange}
		/>,
	);
	const element = container.querySelector("video");
	if (!element) throw new Error("no <video> rendered");
	const video = driveVideo(element as HTMLVideoElement);
	// How the real app resolves its first clip: metadata arrives, the component seeks to
	// its current virtual time, and that seek is what names the active clip.
	act(() => {
		fireEvent.loadedMetadata(element);
	});
	return { onTimeChange, video, element: element as HTMLVideoElement };
}

const reportedTimes = (onTimeChange: ReturnType<typeof vi.fn>) =>
	onTimeChange.mock.calls.map((call) => call[0] as number);

describe("VirtualPreview playback across a clip boundary", () => {
	// The reported bug: with two clips over ONE recording, playback stopped on reaching
	// the second clip and the playhead landed at the end of the timeline.
	it("crosses into the second clip of the same recording instead of stopping", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const { onTimeChange, video } = mount(clips);

		video.play();
		// Play out clip_1 up to the frame where the boundary advance fires.
		for (const t of [1, 5, 9, 9.96]) {
			video.seekTo(t);
			tick();
		}

		expect(video.pauseCalls).toHaveLength(0);
		// The playhead must never have been reported inside clip_2's span, let alone at the
		// end of the timeline (20), while clip_1 was still playing.
		expect(Math.max(...reportedTimes(onTimeChange))).toBeLessThanOrEqual(10.001);
		// …and the advance rewound the media to clip_2's source in-point and kept playing.
		expect(video.currentTime).toBe(0);
		expect(reportedTimes(onTimeChange).at(-1)).toBeCloseTo(10, 5);

		// Now play clip_2 out; only NOW may playback stop, at the end of the timeline.
		for (const t of [1, 5, 9.96]) {
			video.seekTo(t);
			tick();
		}
		expect(video.pauseCalls).toHaveLength(1);
		expect(reportedTimes(onTimeChange).at(-1)).toBeCloseTo(20, 5);
	});

	it("crosses the boundary the same way whatever order the clips are laid in", () => {
		// The layout that used to escape the bug (a foreign clip last) and the ones that did
		// not must now behave identically.
		const layouts: Array<[string, AxcutClip[]]> = [
			[
				"twins then a foreign clip",
				[clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
			],
			[
				"a foreign clip between the twins",
				[
					clip("clip_1", "a1", 0, 10, 0),
					clip("clip_3", "c1", 0, 10, 10),
					clip("clip_2", "a1", 0, 10, 20),
				],
			],
		];
		for (const [label, clips] of layouts) {
			const { onTimeChange, video } = mount(clips);
			video.play();
			for (const t of [5, 9.96]) {
				video.seekTo(t);
				tick();
			}
			expect(video.pauseCalls, label).toHaveLength(0);
			expect(Math.max(...reportedTimes(onTimeChange)), label).toBeLessThanOrEqual(10.001);
			cleanup();
		}
	});

	it("skips a cut authored on the playing clip even when its twin keeps that stretch", () => {
		// clip_1 cuts source 4–6; clip_2 is the same recording, uncut. The cut must apply
		// while clip_1 plays — the twin keeping the stretch used to answer for it.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const trims: AxcutTrimRange[] = [
			{
				id: "trim_1",
				assetId: "a1",
				clipId: "clip_1",
				startSec: 4,
				endSec: 6,
				origin: "user",
				reason: "",
			},
		];
		const { video } = mount(clips, trims);

		video.play();
		video.seekTo(3);
		tick();
		expect(video.currentTime).toBe(3); // before the cut: untouched

		video.seekTo(5); // inside clip_1's cut
		tick();
		expect(video.currentTime).toBe(6); // jumped to where clip_1's content resumes
		expect(video.pauseCalls).toHaveLength(0);
	});
});

// Issue #350 — imported audio tracks follow the RAW virtual playhead. The
// decision math is unit-tested in VirtualPreview.audio.test.ts; here we prove the
// rAF loop applies it to the mounted <audio> element (seek + play/pause).
function driveAudioEl(el: HTMLAudioElement) {
	let currentTime = 0;
	let paused = true;
	Object.defineProperty(el, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
		},
	});
	Object.defineProperty(el, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(el, "duration", { configurable: true, get: () => 10 });
	el.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	el.pause = vi.fn(() => {
		paused = true;
	});
	return {
		get currentTime() {
			return currentTime;
		},
	};
}

describe("VirtualPreview imported audio tracks", () => {
	// A 2s span at raw 2..4, playing the source from 1s in → source 1..3.
	const track = {
		id: "trk",
		assetId: "aud",
		kind: "music" as const,
		startMs: 2000,
		endMs: 4000,
		durationSec: 10,
		offsetMs: 1000,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		label: "",
		origin: "user" as const,
	};

	function mountWithAudio() {
		const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
		const audioSources: VideoSource[] = [{ id: "aud", src: "file:///tmp/vo.mp3", label: "vo" }];
		const { container } = render(
			<VirtualPreview
				videoSources={sources}
				audioTracks={[track]}
				audioSources={audioSources}
				clips={[clip("c1", "a1", 0, 10, 0)]}
				onTimeChange={vi.fn()}
			/>,
		);
		const videoEl = container.querySelector("video");
		if (!videoEl) throw new Error("no <video>");
		const video = driveVideo(videoEl as HTMLVideoElement);
		act(() => fireEvent.loadedMetadata(videoEl));
		const audioEl = container.querySelector<HTMLAudioElement>(
			'[data-testid="preview-audio-track-trk"]',
		);
		if (!audioEl) throw new Error("no track <audio>");
		return { video, audioEl, audio: driveAudioEl(audioEl) };
	}

	it("mounts one <audio> per track with the asset's URL", () => {
		const { audioEl } = mountWithAudio();
		expect(audioEl.getAttribute("src")).toBe("file:///tmp/vo.mp3");
	});

	it("plays inside the window at the trim-offset source time, pauses outside", () => {
		const { video, audioEl, audio } = mountWithAudio();
		video.play();
		// virtualTime lands one tick after the video seek, and the audio loop reads
		// last frame's virtualTime, so two ticks settle the decision.
		video.seekTo(3); // virtual 3 → 1s into the 2..4 span
		tick();
		tick();
		expect(audioEl.play).toHaveBeenCalled();
		expect(audio.currentTime).toBeCloseTo(2, 1); // trimStart 1 + 1s in

		video.seekTo(5); // virtual 5 → past the window end (4)
		tick();
		tick();
		expect(audioEl.pause).toHaveBeenCalled();
	});
});

// Issue #350 — a track boosted past 0 dB must sound boosted in the preview too, not just
// in the export. `element.volume` caps at 1, so the boost has to ride a WebAudio gain node.
// jsdom has no WebAudio, so install a minimal fake context and watch the nodes it mints.
class FakeAudioNode {
	connect = vi.fn();
	disconnect = vi.fn();
}
class FakeGainNode extends FakeAudioNode {
	gain = { value: 1 };
}
let createdGains: FakeGainNode[] = [];
let createdShapers: Array<FakeAudioNode & { curve: Float32Array | null }> = [];
class FakeAudioContext {
	state = "running";
	destination = new FakeAudioNode();
	resume = vi.fn(() => Promise.resolve());
	close = vi.fn(() => Promise.resolve());
	createMediaElementSource = vi.fn(() => new FakeAudioNode());
	createGain = vi.fn(() => {
		const node = new FakeGainNode();
		createdGains.push(node);
		return node;
	});
	// The music ducker listens to the voice; silence here, so nothing ducks.
	createAnalyser = vi.fn(() =>
		Object.assign(new FakeAudioNode(), { fftSize: 2048, getFloatTimeDomainData: vi.fn() }),
	);
	createWaveShaper = vi.fn(() => {
		const node = Object.assign(new FakeAudioNode(), { curve: null });
		createdShapers.push(node);
		return node;
	});
}

describe("VirtualPreview imported audio track boost", () => {
	beforeEach(() => {
		createdGains = [];
		createdShapers = [];
		vi.stubGlobal("AudioContext", FakeAudioContext);
	});

	// +6.0206 dB is exactly ×2 in linear gain — a boost `element.volume` (max 1) could never
	// reach. The graph mints the output gain first, then one gain per track, so the track's
	// node is the last one created.
	const boosted = {
		id: "trk",
		assetId: "aud",
		kind: "music" as const,
		startMs: 2000,
		endMs: 4000,
		durationSec: 10,
		offsetMs: 1000,
		gainDb: 6.0206,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		label: "",
		origin: "user" as const,
	};

	it("drives a per-track gain node past unity instead of capping element.volume", () => {
		const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
		const audioSources: VideoSource[] = [{ id: "aud", src: "file:///tmp/vo.mp3", label: "vo" }];
		const { container } = render(
			<VirtualPreview
				videoSources={sources}
				audioTracks={[boosted]}
				audioSources={audioSources}
				clips={[clip("c1", "a1", 0, 10, 0)]}
				onTimeChange={vi.fn()}
			/>,
		);
		const videoEl = container.querySelector("video");
		if (!videoEl) throw new Error("no <video>");
		driveVideo(videoEl as HTMLVideoElement);
		act(() => fireEvent.loadedMetadata(videoEl));
		const audioEl = container.querySelector<HTMLAudioElement>(
			'[data-testid="preview-audio-track-trk"]',
		);
		if (!audioEl) throw new Error("no track <audio>");
		driveAudioEl(audioEl);

		tick(); // let the rAF stamp the live gain onto the node
		const trackGain = createdGains.at(-1);
		expect(trackGain?.gain.value).toBeCloseTo(2, 3); // boosted, NOT clamped to 1
		expect(audioEl.volume).toBe(1); // volume left at unity so it doesn't double-attenuate
	});

	// The loudness boost and the trim can push a loud take past full scale; only the ceiling
	// keeps the audio device from clipping it (#911). Nothing may bypass it on the way out.
	it("reaches the speakers only through the ceiling", () => {
		const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
		const { container } = render(
			<VirtualPreview
				videoSources={sources}
				clips={[clip("c1", "a1", 0, 10, 0)]}
				onTimeChange={vi.fn()}
			/>,
		);
		const videoEl = container.querySelector("video");
		if (!videoEl) throw new Error("no <video>");
		driveVideo(videoEl as HTMLVideoElement);
		act(() => fireEvent.loadedMetadata(videoEl));

		const ceiling = createdShapers.at(-1);
		expect(ceiling?.curve).toBeInstanceOf(Float32Array);
		const speakers = ceiling?.connect.mock.calls[0]?.[0];
		expect(speakers).toBeDefined();
		for (const gain of createdGains) {
			expect(gain.connect).not.toHaveBeenCalledWith(speakers);
		}
	});
});

// The recording's sound is a second element over the same file: a muted <video> is the clock
// and a separate <audio> is what is heard. Two clocks, so the rAF loop has to keep them
// together, and it has to do it without seeking the audio: every `currentTime` write flushes
// its pipeline, which is the stutter #898 measured (157 `seeking` events in 20 s).
//
// What follows runs that loop against a small model of the elements. Real time passes between
// frames (`frame(gapSec)`), each element advances at its own `playbackRate`, and an audio seek
// stalls the element for `seekLatencySec`, so it lands that far behind the picture, the way the
// shipped editor was measured (~0.1 s). Ticks land 100-150 ms apart, which is what a main
// thread ~44 % blocked does to requestAnimationFrame.
function driveAudioClock(
	el: HTMLAudioElement,
	{ seekLatencySec, skew }: { seekLatencySec: number; skew: number },
) {
	let currentTime = 0;
	let paused = true;
	let stallLeftSec = 0;
	const writes: number[] = [];
	Object.defineProperty(el, "currentTime", {
		configurable: true,
		get: () => currentTime,
		set: (next: number) => {
			currentTime = next;
			stallLeftSec = seekLatencySec;
			writes.push(next);
		},
	});
	Object.defineProperty(el, "seeking", { configurable: true, get: () => stallLeftSec > 0 });
	Object.defineProperty(el, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(el, "duration", { configurable: true, get: () => 60 });
	el.play = vi.fn(() => {
		paused = false;
		return Promise.resolve();
	});
	el.pause = vi.fn(() => {
		paused = true;
	});
	return {
		writes,
		get currentTime() {
			return currentTime;
		},
		/** Put the element somewhere without a seek: how a stretch already in sync starts. */
		place: (next: number) => {
			currentTime = next;
		},
		/** Real time passing. `skew` is how much faster this element's own clock runs. */
		advance: (dtSec: number) => {
			const stalledSec = Math.min(dtSec, stallLeftSec);
			stallLeftSec -= stalledSec;
			if (!paused && stallLeftSec === 0) {
				currentTime += (dtSec - stalledSec) * el.playbackRate * (1 + skew);
			}
		},
	};
}

const LOADED_GAPS_SEC = [0.1, 0.15, 0.12, 0.1, 0.14];

function mountSynced({
	trims = [],
	speedRegions = [],
	seekLatencySec = 0.1,
	skew = 0,
}: {
	trims?: AxcutTrimRange[];
	speedRegions?: SpeedRegion[];
	seekLatencySec?: number;
	skew?: number;
} = {}) {
	const clips = [clip("c1", "a1", 0, 60, 0)];
	const sources: VideoSource[] = [{ id: "a1", src: "file:///tmp/a1.mp4", label: "a1" }];
	const onTimeChange = vi.fn();
	let requestId = 0;
	const tree = (seekTarget: { timeSec: number; requestId: number } | null) => (
		<VirtualPreview
			videoSources={sources}
			clips={clips}
			trimRanges={trims}
			speedRegions={speedRegions}
			seekTarget={seekTarget}
			onTimeChange={onTimeChange}
		/>
	);
	const view = render(tree(null));
	const videoEl = view.container.querySelector("video") as HTMLVideoElement;
	const audioEl = view.container.querySelector(
		'[data-testid="preview-audio-primary"]',
	) as HTMLAudioElement;
	const video = driveVideo(videoEl);
	const audio = driveAudioClock(audioEl, { seekLatencySec, skew });
	act(() => {
		fireEvent.loadedMetadata(videoEl);
	});
	/** Real time passes, then one rAF frame runs. */
	const frame = (gapSec: number) => {
		if (!videoEl.paused) video.seekTo(video.currentTime + gapSec * videoEl.playbackRate);
		audio.advance(gapSec);
		tick();
	};
	return {
		video,
		videoEl,
		audio,
		audioEl,
		frame,
		/** Frames until `seconds` of real time have passed, sampling after each one. */
		run: (seconds: number, gaps = LOADED_GAPS_SEC, onFrame?: () => void) => {
			let elapsedSec = 0;
			for (let i = 0; elapsedSec < seconds; i++) {
				const gap = gaps[i % gaps.length];
				elapsedSec += gap;
				frame(gap);
				onFrame?.();
			}
		},
		/** The audio's offset from the picture, in media seconds; negative is behind it. */
		offset: () => audio.currentTime - video.currentTime,
		/** One explicit seek published by the shell, the way a click on the ruler is. */
		seekTo: (timeSec: number) =>
			act(() => {
				requestId += 1;
				view.rerender(tree({ timeSec, requestId }));
			}),
		/** Playing, with the audio already in step, as it is a few seconds into a take. */
		playInSync: (atSec: number) => {
			video.seekTo(atSec);
			audio.place(atSec);
			video.play();
			tick(); // the loop starts the audio; nothing to correct
			audio.writes.length = 0;
		},
	};
}

describe("VirtualPreview primary audio keeps to the picture", () => {
	// Every offset here is media time, which is what a lip-sync mismatch is measured in and is
	// never smaller than the wall-clock one, so a bound on it holds for both.
	const TOLERANCE_SEC = 0.04;

	it("does not re-seek the audio under load and brings its offset inside 40 ms", () => {
		const world = mountSynced();
		world.video.seekTo(1);
		world.video.play();

		const offsets: number[] = [];
		world.run(30, LOADED_GAPS_SEC, () => offsets.push(world.offset()));

		// The audio is placed once, when playback starts, and never touched again: a hard seek
		// on a playing element is what stuttered. It lands behind the picture by its own seek
		// latency, and the loop closes that by nudging its rate.
		expect(world.audio.writes).toHaveLength(1);
		expect(offsets[1]).toBeLessThan(-0.05);
		// Some 2 s to close 100 ms at a few percent of rate; from there it holds.
		const settled = offsets.slice(30);
		expect(Math.max(...settled.map(Math.abs))).toBeLessThan(TOLERANCE_SEC);
	});

	it("absorbs a free-running clock skew in either direction without a seek", () => {
		for (const skew of [0.005, -0.005]) {
			const world = mountSynced({ skew });
			world.playInSync(1);

			// Nearly a minute at 0.5 % is 275 ms of drift if nothing intervenes, past every
			// threshold in this file, so holding it inside 40 ms is the loop's doing.
			const offsets: number[] = [];
			world.run(55, LOADED_GAPS_SEC, () => offsets.push(world.offset()));

			expect(world.audio.writes, `skew ${skew}`).toHaveLength(0);
			expect(Math.max(...offsets.map(Math.abs)), `skew ${skew}`).toBeLessThan(TOLERANCE_SEC);
			cleanup();
		}
	});

	it("pulls an audio that is AHEAD of the picture back, not only one behind it", () => {
		const world = mountSynced();
		world.playInSync(1);
		// Ahead is what is noticed first, from about 45 ms.
		world.audio.place(world.video.currentTime + 0.1);

		const offsets: number[] = [];
		world.run(10, LOADED_GAPS_SEC, () => offsets.push(world.offset()));

		expect(world.audio.writes).toHaveLength(0);
		expect(Math.max(...offsets.slice(30).map(Math.abs))).toBeLessThan(TOLERANCE_SEC);
	});

	it("resyncs on a small explicit seek during playback, whatever the drift", () => {
		const world = mountSynced();
		world.playInSync(5);
		world.run(1, [0.016]);
		expect(world.audio.writes).toHaveLength(0);

		// 100 ms back: a click on the ruler next to the playhead. The audio's 100 ms lead is
		// inside any leash the storm fix can afford, so only a resync on the seek itself moves it.
		world.seekTo(world.video.currentTime - 0.1);
		world.frame(0.016);

		expect(world.audio.writes).toHaveLength(1);
		expect(world.audio.writes[0]).toBeCloseTo(world.video.currentTime, 1);
		world.run(3, [0.016]);
		expect(Math.abs(world.offset())).toBeLessThan(TOLERANCE_SEC);
		expect(world.audio.writes).toHaveLength(1);
	});

	it("resyncs across a skipped interval shorter than the leash", () => {
		// A cut of 5.00 -> 5.11. The preview only calls a frame cut once it is 50 ms inside
		// (`locateSourcePosition` gives each edge that much slack), so the picture jumps from
		// ~5.05 to 5.11 and the audio, still playing the cut material, would sit ~60 ms off
		// from then on.
		const trim: AxcutTrimRange = {
			id: "cut",
			assetId: "a1",
			clipId: "c1",
			startSec: 5,
			endSec: 5.11,
			origin: "user",
			reason: "",
		};
		const world = mountSynced({ trims: [trim] });
		world.playInSync(4.9);
		// Small steps, because the slack leaves only ~10 ms of the cut where a frame is
		// recognised as inside it.
		world.run(0.5, [0.004]);

		expect(world.audio.writes).toHaveLength(1);
		expect(world.audio.writes[0]).toBeGreaterThanOrEqual(5.11);
		world.run(3, [0.016]);
		expect(Math.abs(world.offset())).toBeLessThan(TOLERANCE_SEC);
		expect(world.audio.writes).toHaveLength(1);
	});

	it("does not seek an audio element that is still seeking, and follows once it is done", () => {
		const world = mountSynced({ seekLatencySec: 0.2 });
		world.playInSync(5);

		world.seekTo(4.9);
		world.frame(0.016); // the first resync: the audio starts a 0.2 s seek
		world.seekTo(6);
		world.frame(0.016); // still seeking: this one waits instead of restarting it
		expect(world.audio.writes).toHaveLength(1);

		world.run(1, [0.1]); // the seek ends, and the loop goes where the picture went
		expect(world.audio.writes).toHaveLength(2);
		expect(world.audio.writes[1]).toBeGreaterThan(6);
	});

	it("keeps in step through a 2x region, entering and leaving it under load", () => {
		const region: SpeedRegion = { id: "s", startMs: 10_000, endMs: 14_000, speed: 2 };
		const world = mountSynced({ speedRegions: [region] });
		world.video.seekTo(1);
		world.video.play();
		world.run(8); // settled before the region

		// The video's rate changes at the END of a tick, so the audio's has to change with it
		// and not at the top of the next one: over a 150 ms gap that lag alone leaves the audio
		// 150 ms behind on the way in and 150 ms ahead on the way out.
		const rates: number[] = [];
		const offsets: number[] = [];
		world.run(30, LOADED_GAPS_SEC, () => {
			rates.push(world.audioEl.playbackRate);
			offsets.push(world.offset());
		});

		expect(rates).toContain(2);
		expect(world.audioEl.playbackRate).toBe(1);
		expect(world.audio.writes).toHaveLength(1);
		expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(TOLERANCE_SEC);
	});

	it("never asks the audio for a rate the browser refuses", () => {
		// Chromium throws on a playbackRate above 16, from inside the rAF tick. A nudge on top
		// of a video already at that cap must stop at it.
		const region: SpeedRegion = { id: "s", startMs: 0, endMs: 60_000, speed: 16 };
		const world = mountSynced({ speedRegions: [region] });
		world.playInSync(1);
		world.frame(0.016); // the region's rate reaches the video
		world.audio.place(world.video.currentTime - 0.1); // behind: the nudge goes UP

		const rates: number[] = [];
		world.run(1, [0.016], () => rates.push(world.audioEl.playbackRate));

		expect(world.videoEl.playbackRate).toBe(16);
		expect(Math.max(...rates)).toBeLessThanOrEqual(16);
	});

	it("goes back to the video's own rate once playback pauses", () => {
		const world = mountSynced();
		world.playInSync(1);
		world.audio.place(world.video.currentTime + 0.1); // a nudge is under way
		world.frame(0.016);
		expect(world.audioEl.playbackRate).toBeLessThan(1);

		world.videoEl.pause();
		world.frame(0.016);

		expect(world.audioEl.playbackRate).toBe(1);
	});
});
