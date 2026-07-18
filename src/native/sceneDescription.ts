/**
 * Scene contract — the flat description the app hands the native D3D compositor so it can
 * compute the composed frame itself (preview AND export) with **no POC-fixture logic**.
 *
 * Division of labour:
 *  - App (TS, this file): *serialize* the document + editor settings into this flat shape.
 *    Pure data mapping, no per-frame math.
 *  - Native (Rust, separate): owns the per-frame math (layout geometry, zoom easing, effect
 *    application) — it reads this description + the current time and composes.
 *
 * This replaces the hardcoded fixture `timeline()` (A↔B layout animation + 6s zoom schedule)
 * that used to drive the compositor.
 *
 * NOTE (worker): implement `buildSceneDescription` below. Everything else here is the frozen
 * contract — do not change the exported types.
 */

import type { AxcutDocument } from "@/lib/ai-edition/schema";
import type { CompositorClipInput } from "./contracts";

/** Background behind the screen. Parsed from `settings.wallpaper`. */
export type SceneBackground =
	| { kind: "color"; color: string } // "#rrggbb"
	| { kind: "gradient"; angleDeg: number; stops: string[] } // linear-gradient(deg, c1, c2, …)
	| { kind: "image"; path: string }; // "/wallpapers/…" or a data: URL

/** A timeline zoom region (from `document.zoomRanges`). Times in seconds. */
export interface SceneZoomRegion {
	startSec: number;
	endSec: number;
	/** Target scale (>1 zooms in). Derived from `depth` (or `customScale` when present). */
	scale: number;
	/** Focus point, 0..1 of the frame. */
	focusX: number;
	focusY: number;
	/** Optional rotation preset for the zoom. */
	rotation: "iso" | "left" | "right" | null;
}

/** Webcam layout, from the editor settings. */
export interface SceneLayout {
	preset: "picture-in-picture" | "dual-frame" | "vertical-stack" | "no-webcam";
	/** Native size scale (1 = the compositor's default PiP webcam). */
	webcamSize: number;
	webcamShape: "rectangle" | "circle" | "square" | "rounded";
	webcamMirror: boolean;
	/** Normalized position (0..1) for the webcam centre, or null to use the preset default. */
	webcamPosition: { cx: number; cy: number } | null;
	/** Webcam shrinks while a zoom region is active. */
	webcamReactiveZoom: boolean;
}

/** Frame-styling effects, from the editor settings. */
export interface SceneEffects {
	/** 0..1 extra inset of the screen (padding). */
	padding: number;
	/** Blur the background (screen used as bg). */
	blur: boolean;
	/** 0..1 drop-shadow strength. */
	shadow: number;
	/** Corner radius in output px. */
	roundnessPx: number;
	/** 0..1 motion blur. */
	motionBlur: number;
}

/** Cursor rendering, from the editor settings. */
export interface SceneCursor {
	show: boolean;
	/** Direct scale (1 = default). */
	size: number;
	smoothing: number;
	/** 0..1. */
	motionBlur: number;
	clickBounce: number;
	clipToBounds: boolean;
	/** Cursor theme id (sprite set). */
	theme: string;
}

/** Everything native needs to compose the scene, serialized from one document. */
export interface SceneDescription {
	/** Ordered clips (multiclip) with source trims — same shape the export already uses. */
	clips: CompositorClipInput[];
	layout: SceneLayout;
	effects: SceneEffects;
	background: SceneBackground;
	zoomRegions: SceneZoomRegion[];
	cursor: SceneCursor;
	/** Screen source crop (fractions of the frame), or null for the full frame. */
	crop: { x: number; y: number; width: number; height: number } | null;
	/** Output frame. `fps` null = use the first clip's source fps. */
	output: { width: number; height: number; fps: number | null };
}

/**
 * Serialize a document into a {@link SceneDescription}. Pure — no per-frame math.
 *
 * WORKER: implement this. See the task spec for the exact derivation rules and which existing
 * helpers to reuse (`getEditorSettings`, the clip-list mapping, wallpaper/zoom conventions).
 */
export function buildSceneDescription(_document: AxcutDocument): SceneDescription {
	throw new Error("buildSceneDescription not implemented");
}
