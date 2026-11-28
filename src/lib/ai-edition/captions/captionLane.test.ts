// Issue #560, step 5. The lane the captions are read from is a DOCUMENT fact, because it
// decides the text burnt into the exported file — and the path that burns it never runs
// React. These pin that, and the fallback that keeps the pane and the exporter from
// disagreeing about which lane a project even has.

import { describe, expect, it } from "vitest";
import { projectRawTimelineSecToPlayback, readSpeedRegions } from "../document/timeline";
import type { AxcutAudioTrack, AxcutClip, AxcutDocument, AxcutTranscript } from "../schema";
import { screenTimeMs } from "../timeline/speed";
import { deriveCaptionCues } from "./cues";
import {
	DEFAULT_CAPTION_SETTINGS,
	getCaptionSettings,
	patchCaptionSettings,
	resolveCaptionLane,
} from "./settings";

const CLIPS: AxcutClip[] = [
	{
		id: "c1",
		assetId: "rec",
		sourceStartSec: 0,
		sourceEndSec: 6,
		timelineStartSec: 0,
		timelineEndSec: 6,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

const VOICE = {
	id: "vo",
	trackId: "vo",
	assetId: "aud",
	kind: "voiceover",
	startMs: 0,
	endMs: 6000,
	durationSec: 6,
	offsetMs: 0,
	gainDb: 0,
	loop: false,
	fadeInMs: 0,
	fadeOutMs: 0,
	muted: false,
	label: "",
	origin: "user",
} as unknown as AxcutAudioTrack;

function words(assetId: string, texts: string[]): AxcutTranscript {
	return {
		assetId,
		language: "en",
		segments: [],
		words: texts.map((text, i) => ({
			id: `${assetId}_w${i}`,
			segmentId: "s",
			text,
			startSec: i,
			endSec: i + 0.9,
		})),
	} as unknown as AxcutTranscript;
}

function doc(over: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: 9,
		project: {
			id: "p",
			title: "T",
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
			primaryAssetId: "rec",
		},
		assets: [],
		transcript: null,
		transcripts: [words("rec", ["filmed", "words"]), words("aud", ["narrated", "words"])],
		timeline: {
			clips: CLIPS,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [VOICE],
		legacyEditor: null,
		...over,
	} as unknown as AxcutDocument;
}

const on = (lane: "recording" | "voiceover") => ({
	...DEFAULT_CAPTION_SETTINGS,
	enabled: true,
	captionLane: lane,
});

const texts = (d: AxcutDocument, lane: "recording" | "voiceover") =>
	deriveCaptionCues(d, on(lane), {}).map((c) => c.text);

describe("captionLane", () => {
	it("defaults to the recording, and survives a round trip through the document", () => {
		expect(DEFAULT_CAPTION_SETTINGS.captionLane).toBe("recording");
		const next = patchCaptionSettings(doc(), { captionLane: "voiceover" });
		expect(getCaptionSettings(next).captionLane).toBe("voiceover");
	});

	it("refuses a lane the placements would not recognise", () => {
		// A hand-edited passthrough blob cannot inject one: `legacyEditor` is untyped.
		const poisoned = patchCaptionSettings(doc(), {
			captionLane: "sideways" as unknown as "recording",
		});
		expect(getCaptionSettings(poisoned).captionLane).toBe("recording");
	});

	it("reads the chosen lane's own words", () => {
		expect(texts(doc(), "recording")).toContain("filmed words");
		expect(texts(doc(), "voiceover")).toContain("narrated words");
	});

	it("leaves the recording lane's cues untouched by the change", () => {
		// The default path is byte-identical: a project that never opts in sees nothing.
		const withoutAudio = doc({ audioTracks: [] });
		expect(texts(withoutAudio, "recording")).toEqual(texts(doc(), "recording"));
	});

	it("falls back to the recording when the stored lane no longer names anything", () => {
		// The pane used to carry this fallback in React state, and the export path never
		// runs React: this project would have exported ZERO captions while the pane showed
		// the recording's.
		const orphaned = doc({ audioTracks: [] });
		expect(resolveCaptionLane(orphaned, on("voiceover"))).toBe("recording");
		expect(texts(orphaned, "voiceover")).toContain("filmed words");
		// And it is not a blanket fallback: with a take present the choice stands.
		expect(resolveCaptionLane(doc(), on("voiceover"))).toBe("voiceover");
	});

	it("carries a corrected word into the caption", () => {
		const corrected = doc({
			transcripts: [words("rec", ["filmed", "words"]), words("aud", ["Kubernetes", "words"])],
		});
		expect(texts(corrected, "voiceover")).toContain("Kubernetes words");
	});
});

describe("captions under a speed region (#1657)", () => {
	// A voiceover from 0 s that speaks at source 4–6 s, under a 2x region over ruler 0–6 s.
	const speech: AxcutTranscript = {
		assetId: "aud",
		language: "en",
		segments: [],
		words: [{ id: "w", segmentId: "s", text: "spoken", startSec: 4, endSec: 6 }],
	} as unknown as AxcutTranscript;
	const SPEED = [{ id: "sp", startMs: 0, endMs: 6000, speed: 2 }];
	const sped = doc({
		transcripts: [{ ...speech, assetId: "rec" }, speech],
		legacyEditor: {
			speedRegions: SPEED,
		} as unknown as AxcutDocument["legacyEditor"],
	});
	// What the viewer sees: the ruler cue projected through the speed region.
	const onScreen = (lane: "recording" | "voiceover") =>
		deriveCaptionCues(sped, on(lane), {}).map((c) => ({
			startMs: screenTimeMs(SPEED, c.startMs),
			endMs: screenTimeMs(SPEED, c.endMs),
		}));

	it("shows a voiceover cue while its 1x speech plays, not compressed to 2–3 s", () => {
		expect(onScreen("voiceover")).toEqual([{ startMs: 4000, endMs: 6000 }]);
	});

	it("still projects a recording-lane cue with the sped-up picture", () => {
		expect(onScreen("recording")).toEqual([{ startMs: 2000, endMs: 3000 }]);
	});
});

describe("voiceover captions under a cut and a speed region (#1657)", () => {
	// A 12 s film with a cut at ruler 4–6 s, and a voiceover from 0 s.
	const FILM: AxcutClip[] = [{ ...CLIPS[0], sourceEndSec: 12, timelineEndSec: 12 }];
	const CUT = [{ id: "t", assetId: "rec", clipId: "c1", startSec: 4, endSec: 6 }];
	const said = (startSec: number, endSec: number): AxcutTranscript =>
		({
			assetId: "aud",
			language: "en",
			segments: [],
			words: [{ id: "w", segmentId: "s", text: "spoken", startSec, endSec }],
		}) as unknown as AxcutTranscript;
	const film = (speech: AxcutTranscript, speed: unknown[], voiceEndMs: number) =>
		doc({
			transcripts: [speech],
			timeline: { ...doc().timeline, clips: FILM, trimRanges: CUT as never },
			audioTracks: [{ ...VOICE, endMs: voiceEndMs, durationSec: voiceEndMs / 1000 }],
			legacyEditor: { speedRegions: speed } as unknown as AxcutDocument["legacyEditor"],
		});
	// Where the viewer sees each cue: the ruler cue through the cut and the speed region.
	const heard = (d: AxcutDocument) =>
		deriveCaptionCues(d, on("voiceover"), {}).map((c) => {
			const out = (ms: number) =>
				Math.round(
					projectRawTimelineSecToPlayback(
						d.timeline.clips,
						d.timeline.trimRanges,
						ms / 1000,
						readSpeedRegions(d),
					) * 1000,
				);
			return { startMs: out(c.startMs), endMs: out(c.endMs) };
		});

	it("keeps a cue on the speech when the 1x speech runs past the cut", () => {
		// 2x over 0–4 s: source 3–3.5 s is heard at output 3–3.5 s, which is past the cut.
		const d = film(said(3, 3.5), [{ id: "sp", startMs: 0, endMs: 4000, speed: 2 }], 4000);
		expect(heard(d)).toEqual([{ startMs: 3000, endMs: 3500 }]);
	});

	it("drops the speech a non-final piece never plays", () => {
		// 2x over 0–10 s: the first piece stops at output 2 s, where the second one starts.
		const speed = [{ id: "sp", startMs: 0, endMs: 10000, speed: 2 }];
		expect(heard(film(said(3, 3.5), speed, 10000))).toEqual([]);
		// Speech straddling that stop keeps only what is heard.
		expect(heard(film(said(1.5, 2.5), speed, 10000))).toEqual([{ startMs: 1500, endMs: 2000 }]);
	});

	it("never stops a take at the head of another take of the same file", () => {
		// Take A plays source 0–4 from 0 s, take B source 3–5 from 3 s: same file, same shift.
		// Nothing stops A at B's head, so A's word at source 2 s is heard at output 2 s.
		const d = film(said(2, 2.4), [{ id: "sp", startMs: 0, endMs: 4000, speed: 2 }], 4000);
		d.audioTracks = [
			...d.audioTracks,
			{
				...d.audioTracks[0],
				id: "vo2",
				trackId: "vo2",
				startMs: 3000,
				endMs: 5000,
				offsetMs: 3000,
			},
		];
		expect(heard(d)).toEqual([{ startMs: 2000, endMs: 2400 }]);
	});
});
