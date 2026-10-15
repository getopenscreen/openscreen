import { describe, expect, it } from "vitest";
import { ANNOTATION_REFERENCE_HEIGHT } from "../annotationScale";
import { fitTextBox, type MeasureText } from "../annotations/placement";
import { resolveAspectRatioValue } from "../document/outputFormat";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { getEditorSettings } from "./editorSettings";
import { applySettingsPatch } from "./settingsPatch";

type Annotation = AxcutDocument["annotations"][number];

// A fixed advance, so the box the test expects does not depend on a canvas.
const measure: MeasureText = (content, style) => ({
	width: content.length * 0.6 * style.fontSize,
	height: 1.25 * style.fontSize,
});

const title: Annotation = {
	id: "ann1",
	startMs: 0,
	endMs: 1000,
	type: "text",
	content: "Release notes",
	space: "frame",
	position: { x: 0, y: 0 },
	size: { width: 0, height: 0 },
	style: {
		color: "#ffffff",
		backgroundColor: "transparent",
		fontSize: 48,
		fontFamily: "Inter",
		fontWeight: "bold",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign: "center",
	},
	zIndex: 1,
};

function project(annotations: Annotation[]): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj",
			title: "P",
			createdAt: "2026-10-15T10:00:00.000Z",
			updatedAt: "2026-10-15T10:00:00.000Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.mp4",
				originalPath: "/tmp/screen.mp4",
				durationSec: 10,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
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
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations,
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: { aspectRatio: "auto", frame: "none", padding: 10 },
	};
}

const aspectOf = (doc: AxcutDocument) =>
	resolveAspectRatioValue(doc, getEditorSettings(doc).aspectRatio);

/** The width of the box in px at the reference height, against the width of its words. */
function holdsItsWords(annotation: Annotation, frameAspect: number): boolean {
	const boxPx = (annotation.size.width / 100) * ANNOTATION_REFERENCE_HEIGHT * frameAspect;
	return boxPx >= measure(annotation.content ?? "", annotation.style).width;
}

describe("applySettingsPatch", () => {
	// Under Auto the frame is shaped around the recording, its device frame and its padding, so
	// a Frame style or a padding change reshapes it as surely as a format pick does. A text box
	// is stored as a share of the frame's width: left as it was, it held fewer px than its words
	// and the compositor wrapped them out of it (v2.1.0-rc.1 Windows pass).
	it.each([
		["a device frame", { frame: "monitor" as const }],
		["a padding change", { padding: 100 }],
	])("refits a frame text to its words when %s reshapes the Auto frame", (_label, patch) => {
		const before = project([]);
		const fitted = { ...title, ...fitTextBox(title, aspectOf(before), measure) };
		const doc = { ...before, annotations: [fitted] };

		const next = applySettingsPatch(doc, patch, measure);

		expect(aspectOf(next)).toBeLessThan(aspectOf(doc));
		expect(holdsItsWords(next.annotations[0], aspectOf(next))).toBe(true);
	});

	it("leaves the annotations alone when the frame keeps its shape", () => {
		const doc = project([title]);
		const next = applySettingsPatch(
			{ ...doc, legacyEditor: { ...doc.legacyEditor, aspectRatio: "16:9" } },
			{ frame: "phone" },
			measure,
		);
		expect(next.annotations[0]).toBe(title);
	});
});
