import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import { executeAgentTool } from "./agent-tools";

function fixture(options: { camera?: boolean; width?: number; height?: number } = {}) {
	const base = createEmptyDocument({
		title: "Test",
		projectId: "proj_1",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "/tmp/rec.mp4",
				durationSec: 30,
				...(options.width ? { video: { width: options.width, height: options.height } } : {}),
				...(options.camera ? { cameraTrack: { sourcePath: "/tmp/cam.mp4" } } : {}),
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

function set(document: AxcutDocument, args: unknown, segmentation?: "ready" | "no-runtime") {
	return executeAgentTool(document, "setEditorSettings", JSON.stringify(args), {
		cameraSegmentation: segmentation ? () => segmentation : undefined,
	});
}

function read(document: AxcutDocument, segmentation?: "ready" | "no-runtime") {
	return JSON.parse(
		executeAgentTool(document, "getCurrentDocument", "", {
			cameraSegmentation: segmentation ? () => segmentation : undefined,
		}).resultJson,
	);
}

describe("setEditorSettings", () => {
	it("writes the look through the editor's patch, and reads it back in the same shape", () => {
		const result = set(fixture(), {
			wallpaper: "/wallpapers/wallpaper3.jpg",
			padding: 20,
			borderRadius: 12,
			frame: "laptop",
			audioGainDb: -3,
			recordingAudioMuted: true,
			autoFocusAll: true,
			cursor: { size: 2, theme: "glass-lens", show: true, asArrow: ["text"] },
		});
		expect(result.ok).toBe(true);
		const document = result.document as AxcutDocument;
		const settings = getEditorSettings(document);
		expect(settings).toMatchObject({
			wallpaper: "/wallpapers/wallpaper3.jpg",
			padding: 20,
			borderRadius: 12,
			frame: "laptop",
			audioGainDb: -3,
			recordingAudioMuted: true,
			autoFocusAll: true,
			cursorTheme: "glass-lens",
		});
		expect(settings.cursor.size).toBe(2);
		expect(settings.cursor.asArrow).toEqual(["text"]);

		const snapshot = read(document);
		expect(snapshot.settings).toMatchObject({ padding: 20, aspectRatio: "auto" });
		expect(snapshot.settings.cursor).toMatchObject({ size: 2, theme: "glass-lens" });
		// What is read is what the tool takes: the whole block goes back in unchanged.
		expect(set(document, snapshot.settings).ok).toBe(true);
	});

	it("refuses a wallpaper that reaches outside the project, a value out of range and an unknown key", () => {
		const document = fixture();
		for (const args of [
			{ wallpaper: "file:///C:/Users/me/secret.png" },
			{ wallpaper: "https://example.com/bg.jpg" },
			{ webcamWallpaper: "url(https://example.com/a.png)" },
			{ padding: 101 },
			{ cursor: { size: 10 } },
			{ audioGainDb: 13 },
			{ cursorSize: 2 },
			{ cursor: { colour: "red" } },
			{},
		]) {
			const result = set(document, args);
			expect(result.ok, JSON.stringify(args)).toBe(false);
			expect(result.document).toBeUndefined();
		}
	});

	it("offers the presets, auto and the clips' own shapes, and fills a first fixed format", () => {
		const document = fixture({ width: 1366, height: 768 });
		expect(read(document).settingsContext.originalAspectRatios).toEqual([
			{ token: "683:384", width: 1366, height: 768, clipCount: 1 },
		]);
		expect(set(document, { aspectRatio: "7:3" }).ok).toBe(false);
		const original = set(document, { aspectRatio: "683:384" });
		expect(original.ok).toBe(true);
		const vertical = set(document, { aspectRatio: "9:16" });
		expect(JSON.parse(vertical.resultJson).applied).toEqual(["aspectRatio", "formatFollowCursor"]);
		expect(getEditorSettings(vertical.document as AxcutDocument).formatFollowCursor).toBe(true);
		// Two shapes on the timeline: auto is not offered, as in the picker.
		const mixed = documentSchema.parse({
			...document,
			assets: [
				...document.assets,
				{ ...document.assets[0], id: "asset_2", video: { width: 1080, height: 1920 } },
			],
			timeline: {
				...document.timeline,
				clips: [
					...document.timeline.clips,
					{
						...document.timeline.clips[0],
						id: "clip_2",
						assetId: "asset_2",
						timelineStartSec: 30,
						timelineEndSec: 60,
					},
				],
			},
		});
		expect(
			set(set(mixed, { aspectRatio: "9:16" }).document as AxcutDocument, { aspectRatio: "auto" })
				.ok,
		).toBe(false);
		// The alias takes the same shapes.
		expect(
			executeAgentTool(document, "setAspectRatio", JSON.stringify({ aspectRatio: "683:384" })).ok,
		).toBe(true);
	});

	it("moves an untouched camera roundness with its shape, and stores the framing as size and pan", () => {
		const document = fixture({ camera: true });
		const square = set(document, { webcamMaskShape: "rectangle" }).document as AxcutDocument;
		expect(getEditorSettings(square).webcamRoundness).toBe(0.4);
		const tuned = set(document, { webcamRoundness: 0.1 }).document as AxcutDocument;
		expect(
			getEditorSettings(set(tuned, { webcamMaskShape: "rectangle" }).document as AxcutDocument)
				.webcamRoundness,
		).toBe(0.1);

		const framed = set(document, {
			webcamCropRegion: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
		}).document as AxcutDocument;
		expect(getEditorSettings(framed).webcamCropPan).toEqual({ x: 1, y: 0 });
		expect(getEditorSettings(framed).webcamCropRegion).toEqual({
			x: 0.5,
			y: 0,
			width: 0.5,
			height: 0.5,
		});
		const panned = set(framed, { webcamCropPan: { x: 0.5, y: 0.5 } }).document as AxcutDocument;
		expect(getEditorSettings(panned).webcamCropRegion).toEqual({
			x: 0.25,
			y: 0.25,
			width: 0.5,
			height: 0.5,
		});
		expect(set(document, { webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.6 } }).ok).toBe(
			false,
		);
		// A rect and a pan that disagree are refused; at full size any pan agrees.
		expect(
			set(framed, {
				webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
				webcamCropPan: { x: 1, y: 0 },
			}).ok,
		).toBe(false);
		expect(
			set(framed, {
				webcamCropRegion: { x: 0, y: 0, width: 1, height: 1 },
				webcamCropPan: { x: 1, y: 0 },
			}).ok,
		).toBe(true);
	});

	it("says which of the settings it wrote change nothing in the current state", () => {
		const result = JSON.parse(set(fixture(), { frameTheme: "dark", padding: 10 }).resultJson);
		expect(Object.keys(result.inactive)).toEqual(["frameTheme"]);
		expect(set(fixture(), { webcamMirrored: true }).resultJson).toContain(
			"No clip on the timeline has a camera",
		);
	});

	it("is refused while edits are off", () => {
		const result = executeAgentTool(fixture(), "setEditorSettings", '{"padding":10}', {
			editsAllowed: false,
		});
		expect(result.ok).toBe(false);
		expect(result.document).toBeUndefined();
	});
});

describe("getCurrentDocument's settings", () => {
	it("elides an embedded image and gives the context the editor gates its controls on", () => {
		const image = `data:image/png;base64,${"A".repeat(4000)}`;
		const document = set(fixture(), { wallpaper: image }).document as AxcutDocument;
		const snapshot = read(document);
		expect(snapshot.settings.wallpaper).toMatch(/^\[embedded image/);
		expect(JSON.stringify(snapshot)).not.toContain("AAAA");
		expect(snapshot.settingsContext).toMatchObject({
			aspectRatios: ["auto", "16:9", "9:16", "1:1", "4:3", "4:5", "16:10", "10:16"],
			formatFill: "none",
			hasTiltedZoom: false,
			cameraSegmentation: null,
		});
		expect(snapshot.settingsContext.bundledWallpapers).toContain("/wallpapers/wallpaper11.jpg");
		expect(snapshot.settingsContext.cursorThemes).toContainEqual({
			id: "glass-lens",
			name: "Glass Lens",
		});
		expect(Object.keys(snapshot.settingsContext.inactive)).toEqual(
			expect.arrayContaining(["formatFollowCursor", "depthOfField", "webcamLayoutPreset"]),
		);
	});

	it("follows the camera layout, the cutout capability and the hidden cursor", () => {
		const document = fixture({ camera: true });
		const ready = read(document, "ready").settingsContext.inactive;
		expect(ready.webcamBackgroundMode).toBeUndefined();
		expect(ready.webcamBlurIntensity).toMatch(/blur/);
		expect(ready.webcamMaskShape).toBeUndefined();

		const missing = read(document, "no-runtime").settingsContext;
		expect(missing.cameraSegmentation).toBe("no-runtime");
		expect(missing.inactive.webcamBackgroundMode).toMatch(/cannot cut out/);

		const sideBySide = set(document, {
			webcamLayoutPreset: "dual-frame",
			cursor: { show: false },
		}).document as AxcutDocument;
		const inactive = read(sideBySide, "ready").settingsContext.inactive;
		expect(inactive.webcamMaskShape).toMatch(/picture-in-picture/);
		expect(inactive.webcamReactiveZoom).toMatch(/picture-in-picture/);
		expect(inactive["cursor.model3d"]).toMatch(/hidden/);
	});
});
