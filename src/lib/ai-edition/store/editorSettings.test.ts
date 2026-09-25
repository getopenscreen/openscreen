import { describe, expect, it } from "vitest";
import {
	DEFAULT_CROP_REGION,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_WEBCAM_LAYOUT_PRESET,
	DEFAULT_WEBCAM_MASK_SHAPE,
} from "@/components/video-editor/types";
import { DEFAULT_CURSOR_THEME_ID } from "@/lib/cursor/cursorThemes";
import { SETTING_BOUNDS } from "@/lib/projectDefaults";
import { ROUNDNESS_SLIDER_MAX_PX } from "@/native/paramUnits";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { DEFAULT_EDITOR_SETTINGS, getEditorSettings, patchEditorSettings } from "./editorSettings";

const baseDoc: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "p1",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "a1",
	},
	assets: [{ id: "a1", kind: "video", label: "clip", originalPath: "/x.mp4", cameraTrack: null }],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	audioTracks: [],
	transcripts: [],
	transcript: null,
	legacyEditor: null,
};

describe("getEditorSettings", () => {
	it("returns the defaults when the document has no legacyEditor", () => {
		const snap = getEditorSettings(baseDoc);
		expect(snap.wallpaper).toBe(DEFAULT_EDITOR_SETTINGS.wallpaper);
		// A new project stores no ratio and reads Auto; older documents had 16:9 pinned by v8.
		expect(snap.aspectRatio).toBe("auto");
		expect(snap.shadowIntensity).toBe(DEFAULT_EDITOR_SETTINGS.shadowIntensity);
		expect(snap.showBlur).toBe(false);
		expect(snap.webcamLayoutPreset).toBe(DEFAULT_WEBCAM_LAYOUT_PRESET);
		expect(snap.webcamMaskShape).toBe(DEFAULT_WEBCAM_MASK_SHAPE);
		expect(snap.cursor.size).toBe(DEFAULT_CURSOR_SIZE);
	});

	it("reads every appearance number into its bound, whatever wrote it", () => {
		const snap = getEditorSettings({
			...baseDoc,
			legacyEditor: {
				cursorSize: 10,
				cursorClickBounce: 5,
				cursorSmoothing: -1,
				shadowIntensity: 5,
				padding: -3,
				borderRadius: 999,
				motionBlurAmount: "a lot",
			},
		});
		expect([snap.cursor.size, snap.cursor.clickBounce, snap.cursor.smoothing]).toEqual([3, 2, 0]);
		expect([snap.shadowIntensity, snap.padding, snap.borderRadius]).toEqual([1, 0, 64]);
		expect(snap.motionBlurAmount).toBe(DEFAULT_EDITOR_SETTINGS.motionBlurAmount);
	});

	it("keeps the roundness bound on the slider's own maximum", () => {
		expect(SETTING_BOUNDS.borderRadius[1]).toBe(ROUNDNESS_SLIDER_MAX_PX);
	});

	it("returns the defaults when the document is null", () => {
		const snap = getEditorSettings(null);
		expect(snap).toEqual(DEFAULT_EDITOR_SETTINGS);
	});

	it("reads overrides from legacyEditor", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				wallpaper: "linear-gradient(red, blue)",
				aspectRatio: "9:16",
				shadowIntensity: 0.5,
				showBlur: true,
				webcamLayoutPreset: "side-by-side",
				webcamMaskShape: "circle",
				cursorSize: 2.5,
				cursorSmoothing: 0.8,
			},
		};
		const snap = getEditorSettings(doc);
		expect(snap.wallpaper).toBe("linear-gradient(red, blue)");
		expect(snap.aspectRatio).toBe("9:16");
		expect(snap.shadowIntensity).toBe(0.5);
		expect(snap.showBlur).toBe(true);
		expect(snap.webcamLayoutPreset).toBe("side-by-side");
		// An old circle: a square camera, fully round.
		expect(snap.webcamMaskShape).toBe("square");
		expect(snap.webcamRoundness).toBe(1);
		expect(snap.cursor.size).toBe(2.5);
		expect(snap.cursor.smoothing).toBe(0.8);
	});

	it("falls back to defaults for unknown or wrong-type values", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { showBlur: "not-a-bool" as unknown as boolean },
		};
		const snap = getEditorSettings(doc);
		expect(snap.showBlur).toBe(false);
	});

	it("keeps depth of field on unless the project stored a boolean off", () => {
		expect(getEditorSettings(baseDoc).depthOfField).toBe(true);
		const junk: AxcutDocument = {
			...baseDoc,
			legacyEditor: { depthOfField: "no" as unknown as boolean },
		};
		expect(getEditorSettings(junk).depthOfField).toBe(true);
		const off = patchEditorSettings(baseDoc, { depthOfField: false });
		expect(getEditorSettings(off).depthOfField).toBe(false);
	});

	it("reads a cursor pack the app no longer ships as the default art", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { cursorTheme: "hello-kitty-watermelon" },
		};
		expect(getEditorSettings(doc).cursorTheme).toBe(DEFAULT_CURSOR_THEME_ID);
	});
});

describe("patchEditorSettings", () => {
	it("writes a single field and leaves others intact", () => {
		const next = patchEditorSettings(baseDoc, { showBlur: true });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(DEFAULT_EDITOR_SETTINGS.shadowIntensity);
		expect(snap.cropRegion).toEqual(DEFAULT_CROP_REGION);
	});

	it("merges into an existing legacyEditor envelope", () => {
		const seed = patchEditorSettings(baseDoc, { showBlur: true });
		const next = patchEditorSettings(seed, { shadowIntensity: 0.7 });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(0.7);
	});

	it("treats an explicitly undefined key as absent, not as a clear", () => {
		const seed = patchEditorSettings(baseDoc, { showBlur: true, shadowIntensity: 0.7 });
		const next = patchEditorSettings(seed, { showBlur: undefined, padding: 12 });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(0.7);
		expect(snap.padding).toBe(12);
	});

	it("patches nested cursor settings without clobbering siblings", () => {
		const seed = patchEditorSettings(baseDoc, { cursor: { size: 2 } });
		const next = patchEditorSettings(seed, { cursor: { smoothing: 0.9 } });
		const snap = getEditorSettings(next);
		expect(snap.cursor.size).toBe(2);
		expect(snap.cursor.smoothing).toBe(0.9);
	});

	it("switches the 3D cursor without clobbering its siblings, off by default", () => {
		expect(getEditorSettings(baseDoc).cursor.model3d).toBe(false);
		const seed = patchEditorSettings(baseDoc, { cursor: { size: 2 } });
		const on = getEditorSettings(patchEditorSettings(seed, { cursor: { model3d: true } }));
		expect(on.cursor.model3d).toBe(true);
		expect(on.cursor.size).toBe(2);
	});

	it("toggles cursorAutoHide on and off via patch", () => {
		const enabled = patchEditorSettings(baseDoc, { cursorAutoHide: true });
		expect(getEditorSettings(enabled).cursorAutoHide).toBe(true);
		expect(getEditorSettings(enabled).cursor.autoHide).toBe(true);

		const disabled = patchEditorSettings(enabled, { cursorAutoHide: false });
		expect(getEditorSettings(disabled).cursorAutoHide).toBe(false);
		expect(getEditorSettings(disabled).cursor.autoHide).toBe(false);

		// Also verify via nested cursor.autoHide patch
		const nestedEnabled = patchEditorSettings(disabled, { cursor: { autoHide: true } });
		expect(getEditorSettings(nestedEnabled).cursorAutoHide).toBe(true);
		expect(getEditorSettings(nestedEnabled).cursor.autoHide).toBe(true);
	});

	it("does not mutate the source document", () => {
		const before = getEditorSettings(baseDoc);
		patchEditorSettings(baseDoc, { showBlur: true });
		const after = getEditorSettings(baseDoc);
		expect(after).toEqual(before);
	});

	it("round-trips webcamAnchor through legacyEditor", () => {
		const dragged = patchEditorSettings(baseDoc, { webcamAnchor: "top-left" });
		expect(getEditorSettings(dragged).webcamAnchor).toBe("top-left");
	});

	// Older builds let the camera be dropped anywhere and stored its centre.
	it("reads a free position stored by an older build as the nearest anchor", () => {
		const anchorOf = (cx: number, cy: number) =>
			getEditorSettings({ ...baseDoc, legacyEditor: { webcamPosition: { cx, cy } } }).webcamAnchor;
		expect(anchorOf(0.1, 0.9)).toBe("bottom-left");
		expect(anchorOf(0.5, 0.1)).toBe("top");
		expect(anchorOf(1.7, -0.4)).toBe("top-right");
		// From the middle of the frame, the nearer edge.
		expect(anchorOf(0.52, 0.6)).toBe("bottom");
		expect(anchorOf(0.4, 0.48)).toBe("left");
		expect(getEditorSettings(baseDoc).webcamAnchor).toBe("bottom-right");
	});

	it("splits the old circle and rounded shapes into a proportion and a roundness", () => {
		const read = (legacyEditor: Record<string, unknown>) => {
			const snap = getEditorSettings({ ...baseDoc, legacyEditor });
			return [snap.webcamMaskShape, snap.webcamRoundness];
		};
		expect(read({ webcamMaskShape: "circle" })).toEqual(["square", 1]);
		expect(read({ webcamMaskShape: "rounded" })).toEqual(["rectangle", 0.6]);
		expect(read({ webcamMaskShape: "square" })).toEqual(["square", 0.3]);
		// A stored roundness wins over the one the shape implied, and stays in 0..1.
		expect(read({ webcamMaskShape: "circle", webcamRoundness: 0.2 })).toEqual(["square", 0.2]);
		expect(read({ webcamRoundness: 4 })).toEqual(["rectangle", 1]);
	});

	it("reads a camera size past the slider's 35% as 35%", () => {
		const doc: AxcutDocument = { ...baseDoc, legacyEditor: { webcamSizePreset: 50 } };
		expect(getEditorSettings(doc).webcamSizePreset).toBe(35);
	});

	it("preserves a non-zero crop at the bottom-right edge", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamCropRegion: { x: 1, y: 1, width: 0.5, height: 0.5 } },
		};

		const crop = getEditorSettings(doc).webcamCropRegion;
		expect(crop.x).toBeCloseTo(0.99);
		expect(crop.y).toBeCloseTo(0.99);
		expect(crop.width).toBeCloseTo(0.01);
		expect(crop.height).toBeCloseTo(0.01);
	});

	// Every project on disk today carries a crop rect and no pan, because the pan did not
	// exist when they were saved. Recovering it from the rect is what keeps opening one a
	// no-op; defaulting to centred would quietly reframe all of them.
	it("recovers the pan of a crop authored before the pan was stored", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamCropRegion: { x: 0.375, y: 0, width: 0.5, height: 0.5 } },
		};

		const snap = getEditorSettings(doc);
		// 0.375 of the 0.5 the crop leaves free is three quarters of the way across.
		expect(snap.webcamCropPan.x).toBeCloseTo(0.75);
		expect(snap.webcamCropPan.y).toBeCloseTo(0);
		// And the rect comes back exactly as it went in — this is the identity that makes
		// the change invisible to an existing document.
		expect(snap.webcamCropRegion.x).toBeCloseTo(0.375);
		expect(snap.webcamCropRegion.y).toBeCloseTo(0);
	});

	it("reads a full-frame crop as centred, since it has no room to sit in", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamCropRegion: { x: 0, y: 0, width: 1, height: 1 } },
		};

		expect(getEditorSettings(doc).webcamCropPan).toEqual({ x: 0.5, y: 0.5 });
	});

	it("rebuilds the crop's offset from the pan when the two disagree on disk", () => {
		// The pan is authoritative: a rect whose offset contradicts it is a half-written
		// pair, and the pan is the half that carries intent.
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
				webcamCropPan: { x: 1, y: 0.5 },
			},
		};

		const crop = getEditorSettings(doc).webcamCropRegion;
		expect(crop.x).toBeCloseTo(0.5);
		expect(crop.y).toBeCloseTo(0.25);
		expect(crop.width).toBeCloseTo(0.5);
	});

	it("clamps a stored pan that is out of range", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
				webcamCropPan: { x: 5, y: -2 },
			},
		};

		const snap = getEditorSettings(doc);
		expect(snap.webcamCropPan).toEqual({ x: 1, y: 0 });
		// And the rect that follows from it still sits inside the frame.
		expect(snap.webcamCropRegion.x).toBeCloseTo(0.5);
		expect(snap.webcamCropRegion.y).toBeCloseTo(0);
	});

	it("falls back per axis when only one of the pan's coordinates is usable", () => {
		// A half-written or hand-edited pan must not drag the good axis down with it: each
		// coordinate recovers from the rect on its own.
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				webcamCropRegion: { x: 0.375, y: 0.125, width: 0.5, height: 0.5 },
				webcamCropPan: { x: "left", y: 0.9 } as unknown as { x: number; y: number },
			},
		};

		const snap = getEditorSettings(doc);
		// x is unusable, so it comes back from the rect: 0.375 of the 0.5 free is 0.75.
		expect(snap.webcamCropPan.x).toBeCloseTo(0.75);
		// y is a number, so it is kept — and 0.9 is deliberately NOT what the rect implies
		// (0.125 of 0.5 free would be 0.25), so this fails if the axes are not independent.
		expect(snap.webcamCropPan.y).toBeCloseTo(0.9);
		// The rect then follows each axis from its own resolved pan.
		expect(snap.webcamCropRegion.x).toBeCloseTo(0.375);
		expect(snap.webcamCropRegion.y).toBeCloseTo(0.45);
	});

	it("round-trips webcam background settings through legacyEditor", () => {
		const patched = patchEditorSettings(baseDoc, {
			webcamBackgroundMode: "custom",
			webcamWallpaper: "#ff0080",
			webcamBlurIntensity: 0.8,
		});
		const snap = getEditorSettings(patched);
		expect(snap.webcamBackgroundMode).toBe("custom");
		expect(snap.webcamWallpaper).toBe("#ff0080");
		expect(snap.webcamBlurIntensity).toBe(0.8);
	});

	// `legacyEditor` is user-writable JSON. An unknown mode used to flow straight through
	// as a WebcamBackgroundMode, so the export pre-render ran and `renderSegmentedWebcam`
	// matched no branch — encoding a blank webcam track.
	it("falls back to the default when the stored webcam background mode is unknown", () => {
		const doc = {
			...baseDoc,
			legacyEditor: { webcamBackgroundMode: "hologram" },
		} as typeof baseDoc;
		expect(getEditorSettings(doc).webcamBackgroundMode).toBe("none");
	});

	it("round-trips the wallpaper motion and rejects an unknown one", () => {
		expect(getEditorSettings(baseDoc).wallpaperMotion).toBe("none");
		const patched = patchEditorSettings(baseDoc, { wallpaperMotion: "aurora" });
		expect(getEditorSettings(patched).wallpaperMotion).toBe("aurora");
		const doc = { ...baseDoc, legacyEditor: { wallpaperMotion: "plasma" } } as typeof baseDoc;
		expect(getEditorSettings(doc).wallpaperMotion).toBe("none");
	});

	it("round-trips the recording frame and reads an unknown one as no frame", () => {
		expect(getEditorSettings(baseDoc).frame).toBe("none");
		for (const frame of ["window", "laptop", "phone", "monitor"] as const) {
			const patched = patchEditorSettings(baseDoc, { frame });
			expect(getEditorSettings(patched).frame).toBe(frame);
		}
		const unknown = { ...baseDoc, legacyEditor: { frame: "holo-visor" } } as typeof baseDoc;
		expect(getEditorSettings(unknown).frame).toBe("none");
	});

	// The migration: the theme used to be baked into the frame, and a project written then must
	// open with BOTH the frame and the theme it had — without the document being rewritten.
	it("splits the old window-light / window-dark into a frame and a theme", () => {
		expect(getEditorSettings(baseDoc).frameTheme).toBe("light");
		for (const [stored, theme] of [
			["window-light", "light"],
			["window-dark", "dark"],
		] as const) {
			const doc = { ...baseDoc, legacyEditor: { frame: stored } } as typeof baseDoc;
			expect(getEditorSettings(doc).frame).toBe("window");
			expect(getEditorSettings(doc).frameTheme).toBe(theme);
		}
		// And the theme is its own setting from here on, for every frame.
		for (const frameTheme of ["light", "dark"] as const) {
			const patched = patchEditorSettings(baseDoc, { frame: "laptop", frameTheme });
			expect(getEditorSettings(patched).frameTheme).toBe(frameTheme);
		}
		// An explicit theme wins over the one an old value implies.
		const both = {
			...baseDoc,
			legacyEditor: { frame: "window-light", frameTheme: "dark" },
		} as typeof baseDoc;
		expect(getEditorSettings(both).frameTheme).toBe("dark");
	});

	it("clamps a stored webcam blur intensity into 0..1", () => {
		const tooHigh = { ...baseDoc, legacyEditor: { webcamBlurIntensity: 1000 } } as typeof baseDoc;
		expect(getEditorSettings(tooHigh).webcamBlurIntensity).toBe(1);
		const negative = { ...baseDoc, legacyEditor: { webcamBlurIntensity: -3 } } as typeof baseDoc;
		expect(getEditorSettings(negative).webcamBlurIntensity).toBe(0);
	});
});
