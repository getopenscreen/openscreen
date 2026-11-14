// Shared request/response contracts between the CLI entry in the Electron main
// process (electron/cli/) and the hidden renderer runners (src/cli/). Keep this
// file dependency-free so both build targets can import it.

import type { ExportQuality, GifFrameRate, GifSizePreset, Mp4FrameRate } from "./exporter/types";

export type CliCursorCaptureMode = "editable-overlay" | "system";

export type AudioExportFormat = "wav" | "m4a";

export function isAudioExportFormat(format: string | null): format is AudioExportFormat {
	return format === "wav" || format === "m4a";
}

/** Where an export without --out lands: beside the project, with the format's extension. */
export function defaultExportPath(projectPath: string, format: string): string {
	return `${projectPath.replace(/\.(openscreen|json)$/i, "")}.${format}`;
}

/** Where the audio export renders its MP4 before taking the audio out: beside the output. */
export function audioRenderPath(outPath: string): string {
	return `${outPath}.render.mp4`;
}

/** A file of its own export the runner reads through the main process: the MP4 an audio
 *  export renders, or the export's output. */
export type CliExportFile = "render" | "output";

export interface CliExportRequest {
	kind: "export";
	/** Absolute path to the .openscreen project file. */
	projectPath: string;
	/**
	 * Set by the MCP server: the project of the projects folder that `projectPath` is the file
	 * of, read by id as the editor opens a project. Unlike a project file opened by path, that
	 * leaves the main process's current project and recording session alone, which the app's
	 * editor relies on while an export runs beside it.
	 */
	projectId?: string;
	/** Absolute output path; null = derive from projectPath + format. */
	outPath: string | null;
	/** null = use the format stored in the project. wav and m4a write the project's audio only. */
	format: "mp4" | "gif" | "wav" | "m4a" | null;
	/** null = use the quality stored in the project. */
	quality: ExportQuality | null;
	/** MP4 frame rate, as the Export dialog offers it. */
	mp4FrameRate: Mp4FrameRate;
	gifFrameRate: GifFrameRate | null;
	gifSizePreset: GifSizePreset | null;
	/** null = use the loop setting stored in the project. */
	gifLoop: boolean | null;
	/**
	 * Reference preview box used to scale annotation text and border radii the
	 * same way the editor's on-screen preview does. The composition is fitted
	 * into this box, mirroring the editor layout. Defaults to 1280x720.
	 */
	/**
	 * Add automatic zoom regions planned from the clicks in the cursor telemetry
	 * (same planner as the editor's magic wand) before rendering. Existing
	 * zoom regions are preserved; suggestions never overlap them.
	 */
	autoZoom: boolean;
	/** Absolute path to a voiceover audio file to mix into the export (MP4 only). */
	audioPath: string | null;
	/** "mix" layers the voiceover over the recording's audio; "replace" drops the original. */
	audioMode: "mix" | "replace";
	/** Delay before the voiceover starts, in seconds. */
	audioOffsetSec: number;
	/**
	 * wav/m4a only: write this imported track alone (its `audioId`), as the export mixes it,
	 * instead of the whole programme. Absent or null = the programme audio.
	 */
	audioTrackId?: string | null;
}

export interface CliRecordRequest {
	kind: "record";
	/** Index into the available screen sources (0 = primary display). */
	displayIndex: number;
	/** Case-insensitive substring match against window titles; overrides displayIndex. */
	windowTitle: string | null;
	mic: boolean;
	/** Microphone device label substring; null = system default. */
	micDevice: string | null;
	systemAudio: boolean;
	/** Record the webcam beside the screen, as the HUD's camera toggle does. */
	camera: boolean;
	/** Camera device label substring; null = system default. */
	cameraDevice: string | null;
	cursorMode: CliCursorCaptureMode;
	/** Auto-stop after this many milliseconds; null = stop via signal/stdin. */
	durationMs: number | null;
	/** When set, write a ready-to-export .openscreen project here after recording. */
	projectOut: string | null;
}

export interface CliSourcesRequest {
	kind: "sources";
}

export interface CliCaptionsRequest {
	kind: "captions";
	/** Absolute path to the .openscreen project file (updated in place). */
	projectPath: string;
	minWordsPerCaption: number;
	maxWordsPerCaption: number;
}

export type CliRequest =
	| CliExportRequest
	| CliRecordRequest
	| CliSourcesRequest
	| CliCaptionsRequest;

export interface CliSourcesResult {
	displays: { index: number; id: string; name: string }[];
	windows: { id: string; name: string }[];
	/** `deviceId`: the renderer's id for it, as the HUD records with it beside the label. */
	microphones: { label: string; deviceId?: string }[];
	/** True when microphone labels required a permission the user hasn't granted. */
	microphoneLabelsUnavailable: boolean;
	/** `deviceId`: the renderer's id for it, as the HUD records with it beside the label. */
	cameras: { label: string; deviceId?: string }[];
	/** True when camera labels required a permission the user hasn't granted. */
	cameraLabelsUnavailable: boolean;
}

export interface CliProgressEvent {
	percentage: number;
	currentFrame?: number;
	totalFrames?: number;
	estimatedTimeRemaining?: number;
	phase?: string;
}

export interface CliDoneResult {
	success: boolean;
	error?: string;
	warnings?: string[];
	/** Export: the written output file. */
	outputPath?: string;
	format?: string;
	width?: number;
	height?: number;
	/** Record: produced artifacts. */
	screenVideoPath?: string;
	webcamVideoPath?: string;
	/** Record: the webcam's shift against the screen, as `ProjectMedia.webcamOffsetMs`. */
	webcamOffsetMs?: number;
	cursorDataPath?: string;
	projectPath?: string;
	durationMs?: number;
	/**
	 * Record: a ready-to-save .openscreen project object built by the runner.
	 * The main process writes it to the --project path (renderer has no fs).
	 */
	projectData?: unknown;
	/** Sources: enumeration payload printed by the main process. */
	sources?: CliSourcesResult;
	/** Captions: how many captions the transcript now shows. */
	captionCount?: number;
}
