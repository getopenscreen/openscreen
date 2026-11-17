import { describe, expect, it } from "vitest";
import { timelineAudioFadeAt } from "@/components/ai-edition/VirtualPreview";
import { buildSceneDescription } from "@/native/sceneDescription";
import {
	type AxcutAudioTrack,
	type AxcutDocument,
	createAudioTrack,
	createEmptyDocument,
	parseDocumentFile,
} from "../schema";
import {
	collapseTracksToPills,
	placeAudioTrackInDocument,
	reanchorAudioTracks,
} from "./audioTracks";
import { setClipSourceRange } from "./timeline";

function project(lengthSec = 10): AxcutDocument {
	const doc = createEmptyDocument({ projectId: "qa", title: "Audio overhang" });
	return {
		...doc,
		assets: [
			{
				id: "video",
				kind: "video",
				label: "Silent picture",
				originalPath: "/video.mp4",
				durationSec: lengthSec,
				video: { codec: "h264", width: 1280, height: 720, fps: 30 },
				cameraTrack: null,
			},
			{
				id: "music",
				kind: "audio",
				label: "Music",
				originalPath: "/tone.wav",
				durationSec: 20,
				cameraTrack: null,
			},
		],
		timeline: {
			...doc.timeline,
			clips: [
				{
					id: "clip",
					assetId: "video",
					sourceStartSec: 0,
					sourceEndSec: lengthSec,
					timelineStartSec: 0,
					timelineEndSec: lengthSec,
					wordRefs: [],
					origin: "user",
					reason: "QA",
				},
			],
		},
	};
}

const music = (startSec = 0): AxcutAudioTrack => ({
	...createAudioTrack({
		assetId: "music",
		durationSec: 20,
		timelineStartSec: startSec,
		spanSec: 20,
	}),
	kind: "music",
	fadeInMs: 0,
	fadeOutMs: 2000,
});
let sequence = 0;
const makeId = () => `audio-${++sequence}`;

describe("music placement beyond the programme", () => {
	it("keeps ordinary interior clip cropping scoped to that clip", () => {
		const doc = project(40);
		doc.timeline.clips = [
			{ ...doc.timeline.clips[0], sourceEndSec: 20, timelineEndSec: 20 },
			{ ...doc.timeline.clips[0], id: "clip2", sourceStartSec: 20, timelineStartSec: 20 },
		];
		const placed = placeAudioTrackInDocument(doc, music(), makeId, "create");
		const shortened = setClipSourceRange(placed, "clip", 0, 10);
		expect(buildSceneDescription(shortened).audioTracks[0]?.trimEndSec).toBe(10);
	});

	it("queues another music take after the whole requested window", () => {
		const placed = placeAudioTrackInDocument(project(), music(), makeId, "create");
		const next = placeAudioTrackInDocument(placed, { ...music(), id: "second" }, makeId, "create");
		expect(collapseTracksToPills(next.audioTracks).map((track) => track.startMs)).toEqual([
			0, 20_000,
		]);
	});
	it.each([0, 2])("keeps its tail when the video is shortened from source %ss to 10s", (head) => {
		const placed = placeAudioTrackInDocument(project(20), music(), makeId, "create");
		const shortened = setClipSourceRange(placed, "clip", head, 10);
		expect(buildSceneDescription(shortened).audioTracks[0]).toMatchObject({
			trimStartSec: head,
			trimEndSec: 20,
		});
	});
	it("keeps its fade at the requested end when import is automatically capped", () => {
		const placed = placeAudioTrackInDocument(project(), music(), makeId, "create");
		const pill = collapseTracksToPills(placed.audioTracks)[0];
		expect(pill.endMs).toBe(10_000);
		expect(buildSceneDescription(placed).audioTracks[0]).toMatchObject({
			trimEndSec: 20,
			fadeOutSec: 2,
		});
		expect(timelineAudioFadeAt(pill, 9.8, 10)).toBe(1);
	});

	it("retains that envelope through persistence and re-anchoring", () => {
		const placed = placeAudioTrackInDocument(project(), music(), makeId, "create");
		const loaded = parseDocumentFile(JSON.parse(JSON.stringify(placed)));
		const anchored = {
			...loaded,
			audioTracks: reanchorAudioTracks(loaded.audioTracks, loaded.timeline.clips, makeId),
		};
		expect(buildSceneDescription(anchored).audioTracks[0]?.trimEndSec).toBe(20);
	});

	it("keeps the part of a fade that genuinely starts before the programme ends", () => {
		const placed = placeAudioTrackInDocument(
			project(),
			{ ...music(), endMs: 11_000 },
			makeId,
			"create",
		);
		const pill = collapseTracksToPills(placed.audioTracks)[0];
		expect(buildSceneDescription(placed).audioTracks[0]?.trimEndSec).toBe(11);
		expect(timelineAudioFadeAt(pill, 9.8, 10)).toBeCloseTo(0.6);
	});

	it("lets an explicit trim at the same visible edge restore the fade there", () => {
		const placed = placeAudioTrackInDocument(project(), music(), makeId, "create");
		const pill = collapseTracksToPills(placed.audioTracks)[0];
		const resized = placeAudioTrackInDocument(placed, pill, makeId, "resize");
		expect(buildSceneDescription(resized).audioTracks[0]?.trimEndSec).toBe(10);
		expect(timelineAudioFadeAt(collapseTracksToPills(resized.audioTracks)[0], 9.8, 10)).toBeCloseTo(
			0.1,
		);
	});

	it("lets an explicit right-edge resize choose a new fade edge", () => {
		const placed = placeAudioTrackInDocument(project(), music(), makeId, "create");
		const pill = collapseTracksToPills(placed.audioTracks)[0];
		const resized = placeAudioTrackInDocument(placed, { ...pill, endMs: 8000 }, makeId, "resize");
		const result = collapseTracksToPills(resized.audioTracks)[0];
		expect(buildSceneDescription(resized).audioTracks[0]?.trimEndSec).toBe(8);
		expect(timelineAudioFadeAt(result, 7.5, 8)).toBeCloseTo(0.25);
	});

	it("keeps the original tail when only the left edge is trimmed", () => {
		const placed = placeAudioTrackInDocument(project(), music(), makeId, "create");
		const pill = collapseTracksToPills(placed.audioTracks)[0];
		const resized = placeAudioTrackInDocument(
			placed,
			{ ...pill, startMs: 2000, offsetMs: 2000 },
			makeId,
			"resize-start",
		);
		expect(buildSceneDescription(resized).audioTracks[0]).toMatchObject({
			startSec: 2,
			trimStartSec: 2,
			trimEndSec: 20,
		});
		expect(collapseTracksToPills(resized.audioTracks)[0]).toMatchObject({
			endMs: 10_000,
			endOverflowMs: 10_000,
		});
	});

	it("restores the whole requested length when a capped pill is moved", () => {
		const placed = placeAudioTrackInDocument(project(), music(5), makeId, "create");
		const pill = collapseTracksToPills(placed.audioTracks)[0];
		const moved = placeAudioTrackInDocument(
			placed,
			{ ...pill, startMs: 0, endMs: 5000 },
			makeId,
			"move",
		);
		expect(buildSceneDescription(moved).audioTracks[0]).toMatchObject({
			startSec: 0,
			trimEndSec: 20,
		});
	});

	it("reveals the remainder if the programme is extended afterwards", () => {
		const placed = placeAudioTrackInDocument(project(), music(), makeId, "create");
		const extended = project(30);
		extended.audioTracks = reanchorAudioTracks(placed.audioTracks, extended.timeline.clips, makeId);
		expect(collapseTracksToPills(extended.audioTracks)[0].endMs).toBe(20_000);
		expect(buildSceneDescription(extended).audioTracks[0]?.trimEndSec).toBe(20);
	});

	it("keeps the clipped tail on the last fragment of a multi-clip take", () => {
		const doc = project(20);
		doc.timeline.clips = [
			{ ...doc.timeline.clips[0], sourceEndSec: 10, timelineEndSec: 10 },
			{ ...doc.timeline.clips[0], id: "clip2", sourceStartSec: 10, timelineStartSec: 10 },
		];
		const placed = placeAudioTrackInDocument(doc, music(5), makeId, "create");
		expect(placed.audioTracks.map((track) => track.endOverflowMs)).toEqual([undefined, 5000]);
		expect(buildSceneDescription(placed).audioTracks).toHaveLength(1);
		expect(buildSceneDescription(placed).audioTracks[0]).toMatchObject({
			startSec: 5,
			trimEndSec: 20,
		});
	});

	it("does not change voiceover placement", () => {
		const placed = placeAudioTrackInDocument(
			project(),
			{ ...music(), kind: "voiceover" },
			makeId,
			"create",
		);
		expect(placed.audioTracks[0].endOverflowMs).toBeUndefined();
		expect(buildSceneDescription(placed).audioTracks[0]?.trimEndSec).toBe(10);
	});
});
