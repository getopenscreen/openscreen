// What an agent needs around the editing DSL to make a video on its own: record a
// take, have it become a project, export the project, and look at the result.
// Served next to the document tools by both servers, the in-app one and `openscreen
// mcp`, so every edit between the recording and the export goes through the DSL like
// any other client's.
//
// One implementation, two recorders. `openscreen mcp` records in a hidden runner of its
// own process and lays the take out as a project here (`runnerRecorder`). The app
// records through its recording bar, as its own Record button does, and its editor opens
// the take (`app-recorder.ts`): the app never runs a second recorder beside its own.
//
// No `electron` import: the runners, the recorder, the decoder and the documents are
// handed in, so the tools run under plain vitest with stand-ins.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
	CallToolResult,
	ServerNotification,
	ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CursorTelemetryPoint } from "../../src/components/video-editor/types";
import { getCaptionSettings } from "../../src/lib/ai-edition/captions/settings";
import {
	formatSubtitleFile,
	isSubtitleFileFormat,
	subtitleCuesForExport,
} from "../../src/lib/ai-edition/captions/subtitleFile";
import { getCaptionTranslations } from "../../src/lib/ai-edition/captions/translations";
import {
	projectRawTimelineSecToPlayback,
	readSpeedRegions,
} from "../../src/lib/ai-edition/document/timeline";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForDocument,
} from "../../src/lib/ai-edition/timeline/apply-auto-zooms";
import { removedRawSpans, subtractRemoved } from "../../src/lib/ai-edition/timeline/programme-time";
import {
	type CliDoneResult,
	type CliRecordRequest,
	type CliRequest,
	isAudioExportFormat,
} from "../../src/lib/cliContracts";
import { HIDDEN_WINDOWS_NOTE } from "../../src/lib/cliSourcePick";
import {
	GIF_SIZE_PRESETS,
	type GifSizePreset,
	MP4_FRAME_RATES,
	VALID_GIF_FRAME_RATES,
} from "../../src/lib/exporter/types";
import type {
	CompositorClipInput,
	CursorRecordingData,
	CursorRecordingSample,
} from "../../src/native/contracts";
import { buildNativeClipList, buildSceneDescription } from "../../src/native/sceneDescription";
import { runDocumentTool } from "../ai-edition/deep-agent/service";
import type { DocumentService } from "../ai-edition/document-service";
import { writeFileReplacing } from "../atomic-rename";
import type { RunnerHandlers } from "../cli/runnerHost";
import { type AudioReport, measureWav } from "./audio-report";
import {
	changedRegion,
	composeContactSheet,
	type FrameImages,
	type FrameRegion,
	regionRect,
	tileWidthFor,
} from "./contact-sheet";
import type { OpenedVideo } from "./hidden-video";
import {
	MCP_EDITS_SETTING,
	type McpToolRunner,
	type McpTransport,
	READ_CHECKPOINT_TOOL,
	type RunnerEdit,
	textResult as text,
} from "./openscreen-mcp-server";
import { mediaPathProblem } from "./project-tools";

/** What startRecording asks a recorder for. */
export type RecordRequest = Pick<
	CliRecordRequest,
	| "displayIndex"
	| "windowTitle"
	| "mic"
	| "micDevice"
	| "systemAudio"
	| "camera"
	| "cameraDevice"
	| "cursorMode"
>;

/** A take turned into a project, ready for the document tools. */
export interface RecordedTake {
	projectId: string;
	/** The take's video, as the project's asset names it: setPointerTrack's key. */
	videoPath: string;
	durationSec: number;
	autoZooms: number;
	warnings?: string[];
}

export interface RunningTake {
	/** Epoch ms when capture started: the clock setPointerTrack's events are on. */
	startedAt: number;
	/** Stops the take and hands it back as a project; throws, with the whole story, when it cannot. */
	stop(title: string | undefined): Promise<RecordedTake>;
}

export interface TakeRecorder {
	/** Resolves once capture has started; throws why it did not. */
	start(request: RecordRequest): Promise<RunningTake>;
}

export interface MediaToolDeps {
	/** The app may finish a client take from its HUD, without stopRecording. */
	recordingActive?(): boolean;
	/** Observes the app's current take without starting or stopping it. */
	waitForRecording?: (
		timeoutMs: number,
		signal: AbortSignal,
	) => Promise<RecordedTake & { recordingStartedAt: number }>;

	/** The server these tools are served by: their texts say what is true on it. */
	transport: McpTransport;
	/** Whether a client may record and export: the in-app server's "MCP edits". */
	editsAllowed(): boolean;
	/** Records the takes. Default: a hidden record runner, as `openscreen mcp` does. */
	recorder?: TakeRecorder;
	runners: {
		start(
			request: CliRequest,
			handlers?: RunnerHandlers,
		): {
			window: { webContents: { send(channel: string): void } };
			done: Promise<CliDoneResult>;
			close(): void;
		};
	};
	documents: Pick<
		DocumentService,
		"createProject" | "addAsset" | "saveProject" | "filePathFor" | "getProject"
	>;
	openVideo(videoPath: string): Promise<OpenedVideo>;
	/** Frames of a timeline composed as its export would compose them, without exporting: the
	 *  addon's `renderFrames` (`frames` are indices on the `fps` grid, JPEG at most `maxWidth`
	 *  wide). `null`, or absent, when the addon cannot: getFrames then needs an export. */
	renderFrames?(
		clips: CompositorClipInput[],
		sceneJson: string,
		fps: number,
		frames: number[],
		maxWidth: number,
	): Promise<Array<{ index: number; width: number; height: number; jpeg: Buffer }> | null>;
	/** Crops frames and lays them out as a contact sheet (frame-images.ts). Absent, a region
	 *  and a sheet are refused. */
	images?: FrameImages;
	/** The pointer samples recorded with a video; empty when there are none. */
	readCursor(videoPath: string): Promise<CursorTelemetryPoint[]>;
	/** The document tools' runner: a fresh project's checkpoint and every edit go through it. */
	runTool: McpToolRunner;
	now?(): number;
}

/** A take that asked for the webcam and came out without one: said, never left to be noticed. */
export const NO_WEBCAM_PICTURE =
	"The webcam delivered no picture, so the take has no camera. Call listSources and pass startRecording part of the name of a camera that works.";

export const MAX_FRAMES = 12;
/** The most a contact sheet holds: six rows of six. */
export const MAX_SHEET_FRAMES = 36;
/** The most moments getBeforeAfter pairs up: six rows of two make a sheet a client still reads. */
export const MAX_PAIRS = 6;
// Wide enough to read UI text, small enough that a dozen frames stay cheap.
const FRAME_WIDTH = 1280;
/** Wider than any render or video: a frame asked for at this width comes at its own size. */
const FULL_WIDTH = 16_384;
/** exportVideo's frame rate when none is asked: the grid getFrames renders on without an export. */
const EXPORT_FPS = 60;
// A seek to the exact end shows no frame in Chromium; stop one frame short of it.
const END_MARGIN_SEC = 1 / 60;

/** The stretch of a video a client asks to see frames of; an open end is the video's own. */
interface FrameSpan {
	startSec?: number;
	endSec?: number;
}

/**
 * The times to grab: `atSec` clamped inside the video, else `count` of them. Over a `span`
 * they run from one of its ends to the other, both shown: a transition is read from its first
 * frame to its last. Over the whole video they sit centred in equal slices, clear of a black
 * first frame.
 */
export function frameTimes(
	durationSec: number,
	atSec: number[] | null,
	count: number,
	span: FrameSpan = {},
): number[] {
	const last = Math.max(0, durationSec - END_MARGIN_SEC);
	if (atSec) return atSec.map((t) => Math.min(t, last));
	if (span.startSec === undefined && span.endSec === undefined) {
		return Array.from({ length: count }, (_, i) =>
			Math.min(((i + 0.5) * durationSec) / count, last),
		);
	}
	const from = Math.min(span.startSec ?? 0, last);
	const to = Math.max(from, Math.min(span.endSec ?? last, last));
	if (count === 1) return [(from + to) / 2];
	return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

/** The moments a client asks to see, of a project or of a video file. */
interface FrameQuery extends FrameSpan {
	projectId?: string;
	path?: string;
	atSec?: number[];
	count?: number;
}

/** One moment looked at: what is said before its picture, and the picture when there is one. */
interface Shot {
	caption: string;
	/** The moment, in the seconds the client asked in. */
	sec: number;
	jpeg: Buffer | null;
	/** The picture's size in pixels, when the renderer says it. */
	size?: { width: number; height: number };
}

interface Shots {
	intro: string;
	shots: Shot[];
}

/** A frame query answered with its frames, not with why it could not be. A tool result takes
 *  any key, so the type alone does not tell the two apart. */
function isShots(found: Shots | CallToolResult): found is Shots {
	return Array.isArray(found.shots);
}

/** Why a frame query cannot be answered as asked, or `null`. */
function frameQueryProblem(query: FrameQuery): string | null {
	if ((query.projectId === undefined) === (query.path === undefined)) {
		return "Pass either projectId or path.";
	}
	if (query.atSec && (query.startSec !== undefined || query.endSec !== undefined)) {
		return "Pass atSec, or startSec and endSec with count, not both.";
	}
	if (
		query.startSec !== undefined &&
		query.endSec !== undefined &&
		query.endSec <= query.startSec
	) {
		return "endSec must be after startSec.";
	}
	return null;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

const NO_FRAME_HERE = "No frame here: the rendered video ends before it.";
const NO_IMAGE_WORK = "This OpenScreen cannot crop frames or lay them out on a sheet.";

const REGION_SCHEMA: z.ZodType<FrameRegion> = z
	.object({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		width: z.number().gt(0).max(1),
		height: z.number().gt(0).max(1),
	})
	.describe(
		"Only this part of each frame, as fractions of the frame from its top-left corner: x 0.5, y 0, width 0.5, height 0.5 is the top-right quarter.",
	);

/** What getFrames and getContactSheet both take, to say which moments of what. */
function frameQueryShape(transport: McpTransport, maxFrames: number, defaultCount: number) {
	return {
		projectId: z
			.string()
			.optional()
			.describe("Look at this project: its last export, or the frames an export would show."),
		path: z
			.string()
			.optional()
			.describe(
				transport === "http"
					? "Or look at this video file, by its absolute path."
					: "Or look at this video file.",
			),
		atSec: z
			.array(z.number().nonnegative())
			.max(maxFrames)
			.optional()
			.describe("Times in seconds: ruler seconds with projectId, the file's own with path."),
		count: z
			.number()
			.int()
			.min(1)
			.max(maxFrames)
			.optional()
			.describe(
				`How many frames, when atSec is not given. Default ${defaultCount}. Spread evenly over the whole video, or from startSec to endSec when either is given.`,
			),
		startSec: z
			.number()
			.nonnegative()
			.optional()
			.describe("With count: the first frame's time. Default: the start of the video."),
		endSec: z
			.number()
			.nonnegative()
			.optional()
			.describe("With count: the last frame's time. Default: the end of the video."),
		region: REGION_SCHEMA.optional(),
	};
}

export interface PointerEvent {
	/** Epoch milliseconds, from the clock the take's `recordingStartedAt` came from. */
	at: number;
	/** Fractions of the recorded window (or display), as OpenScreen records a real pointer. */
	x: number;
	y: number;
	click?: boolean;
}

// The rate OpenScreen's own pointer sampler records at.
const POINTER_STEP_MS = 33;
// A hand reaches for the next control in about this long, then the click lands.
const POINTER_TRAVEL_MS = 600;
const CLICK_HOLD_MS = 80;

/**
 * A pointer track as a real mouse would have left it: at rest, then a short eased
 * glide that arrives on each event when it happened, then at rest until the end.
 * Times are milliseconds into the take; sampled until `durationMs`, because the
 * zoom planner discards a click that comes with the last sample (the click on Stop).
 */
export function pointerSamples(
	events: readonly PointerEvent[],
	startedAt: number,
	durationMs: number,
): CursorRecordingSample[] {
	const sorted = [...events].sort((a, b) => a.at - b.at);
	if (sorted.length === 0) return [];
	const sample = (
		timeMs: number,
		cx: number,
		cy: number,
		interactionType: CursorRecordingSample["interactionType"] = "move",
	): CursorRecordingSample => ({
		timeMs: Math.round(timeMs),
		cx,
		cy,
		visible: true,
		assetId: null,
		cursorType: null,
		interactionType,
	});
	const samples: CursorRecordingSample[] = [];
	let from = { t: 0, x: sorted[0].x, y: sorted[0].y };
	for (const event of sorted) {
		const t = Math.min(Math.max(event.at - startedAt, from.t), durationMs);
		const glideStart = Math.max(from.t, t - POINTER_TRAVEL_MS);
		for (let s = from.t; s < glideStart; s += POINTER_STEP_MS)
			samples.push(sample(s, from.x, from.y));
		for (let s = glideStart; s < t; s += POINTER_STEP_MS) {
			const k = (s - glideStart) / (t - glideStart);
			const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
			samples.push(
				sample(s, from.x + (event.x - from.x) * eased, from.y + (event.y - from.y) * eased),
			);
		}
		samples.push(sample(t, event.x, event.y, event.click ? "click" : "move"));
		if (event.click) samples.push(sample(t + CLICK_HOLD_MS, event.x, event.y, "mouseup"));
		from = { t: event.click ? t + CLICK_HOLD_MS : t, x: event.x, y: event.y };
	}
	for (let s = from.t + POINTER_STEP_MS; s <= durationMs; s += POINTER_STEP_MS) {
		samples.push(sample(s, from.x, from.y));
	}
	return samples;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const GIF_SIZES = Object.keys(GIF_SIZE_PRESETS) as [GifSizePreset, ...GifSizePreset[]];
const MP4_OPTIONS = ["quality", "fps"] as const;
const GIF_OPTIONS = ["gifFrameRate", "gifSize", "gifLoop"] as const;

/** Where a take is made and where it lands, on each server. */
const TAKE_NOTES: Record<McpTransport, string> = {
	http: "Recording is the app's own: startRecording hands over to OpenScreen's recording bar, as the editor's Record button does, so the editor closes for the take, and stopRecording opens the take in the editor, where the user sees each edit land and can undo it. Its zooms on the clicks follow Record mode's Auto-zoom after recording, as for any take.",
	stdio:
		"These projects are in the OpenScreen app's project list, so the user can open one in its editor.",
};

/** The media tools' capability block, placed before the projects-and-checkpoints rules
 *  (`mcpInstructions`) on the server that registers them. */
export function mediaPreamble(transport: McpTransport): string {
	return [
		"OpenScreen records the screen, turns each take into a project you edit with the document tools, and exports it as a video.",
		"A demo goes: listSources, then startRecording, then drive the app, then stopRecording. To observe a take the user controls on the in-app HTTP server, call waitForRecording while it is recording or saving; the user stops it. It returns the projectId and a checkpointId. Edit with the document tools, always passing that projectId: every edit is saved to the project straight away, and restoreCheckpoint with the checkpointId takes the project back to the raw take in one step. Then exportVideo, and getFrames with the projectId to check the export before you hand it over: it takes the same ruler seconds as the document tools, so a trim or a speed region never shifts what you look at. getContactSheet shows many moments as one image, to read the rhythm of the whole film or a transition frame by frame, getBeforeAfter shows what your edits changed since a checkpoint, and getAudioReport measures the sound, which no frame shows.",
		"To edit a video you already have instead, createProject with its videoPath; importMedia adds a video, an audio file or an image to a project, an image as a silent clip of it.",
		"Drive the app with the real mouse when you can: OpenScreen records the pointer, draws a clean cursor and zooms on the clicks as the editor does: clicks close in time and on screen share one zoom, and the first seconds and the end stay on the whole screen. If you drive it from a script instead (Playwright, CDP), the screen pointer never moves: log each action as the script runs it, then hand the log to setPointerTrack after stopRecording. A video your script captured itself takes one too: createProject with it, then setPointerTrack with recordingStartedAt.",
		TAKE_NOTES[transport],
	].join("\n");
}

/** What a client reads of the media tools: their preamble, and the tools themselves. */
export interface MediaTools {
	preamble: string;
	/** Includes a take's startup and project save, and an export's finalization. */
	isBusy(): boolean;
	/** Adds the tools to a server. Their state (the take, the exports) is shared by every
	 *  server they are added to: the in-app server builds one per request. */
	register(server: McpServer): void;
}

const START_RECORDING_NOTES: Record<McpTransport, string> = {
	http: "It goes through OpenScreen's recording bar, as the editor's Record button does: the editor closes for the take, so this is refused while the editor has unsaved changes, and the bar's countdown applies. On Linux the system's portal asks the user what to record, whatever window or display says. On macOS the take records the window or display named here, even where the bar otherwise asks in Apple's picker (macOS 15.2 or later); that needs OpenScreen's Screen Recording permission, and without it the call is refused. The bar records with these settings, and gets the user's own back once the take ends.",
	stdio: "On Linux the desktop's own picker asks the user which window to record.",
};

const STOP_RECORDING_DESCRIPTIONS: Record<McpTransport, string> = {
	http: "Stop the recording. OpenScreen's editor opens the take as a new project, as it does after any recording: one clip, plus the zooms planned from the recorded clicks when Record mode's Auto-zoom after recording is on, and autoZooms says how many. Returns the projectId to edit, now open in the editor, a checkpointId that restores the take as it opened, and the take's videoPath.",
	stdio:
		"Stop the recording and turn the take into a new project, laid out as the editor lays out a fresh recording: one clip, plus the zooms planned from the recorded clicks. Not one per click: clicks close in time and on screen share one zoom, a click in the first seconds or the one that stopped the take gets none, and autoZooms says how many there are. Returns the projectId to edit, a checkpointId that restores the raw take, and the take's videoPath.",
};

const CREATE_PROJECT_NOTES: Record<McpTransport, string> = {
	http: "The editor keeps the project it has open: the new one is in OpenScreen's project list, for the user to open.",
	stdio: "It is in the OpenScreen app's project list, so the user can open it in its editor.",
};

const EXPORT_PATH_DESCRIPTIONS: Record<McpTransport, string> = {
	http: "Where to write the video: an absolute path ending in .mp4 or .gif. This server runs inside the app, so it has no working directory of yours to resolve a relative one against.",
	stdio:
		"Where to write the video: an absolute path, or one relative to this server's working directory, ending in .mp4 or .gif.",
};

const AUDIO_PATH_DESCRIPTIONS: Record<McpTransport, string> = {
	http: "Where to write the audio: an absolute path ending in .wav or .m4a. This server runs inside the app, so it has no working directory of yours to resolve a relative one against.",
	stdio:
		"Where to write the audio: an absolute path, or one relative to this server's working directory, ending in .wav or .m4a.",
};

const CAPTIONS_PATH_DESCRIPTIONS: Record<McpTransport, string> = {
	http: "Where to write the subtitles: an absolute path ending in .srt or .vtt. This server runs inside the app, so it has no working directory of yours to resolve a relative one against.",
	stdio:
		"Where to write the subtitles: an absolute path, or one relative to this server's working directory, ending in .srt or .vtt.",
};

const GATED_MESSAGE = `Nothing was recorded or exported: OpenScreen lets MCP clients record and export only while the user allows it. Ask the user to turn on ${MCP_EDITS_SETTING}.`;

/** A path a client passed, resolved; `null` for a relative one the in-app server cannot place. */
function clientPath(transport: McpTransport, value: string): string | null {
	if (transport === "http" && !path.isAbsolute(value)) return null;
	return path.resolve(value);
}

export const POINTER_TRACK_TOOL = "setPointerTrack";

const POINTER_EVENTS = z
	.array(
		z.object({
			at: z.number().describe("Milliseconds, from Date.now(): the clock recordingStartedAt is on."),
			x: z.number().min(0).max(1),
			y: z.number().min(0).max(1),
			click: z.boolean().optional().describe("The action clicked here."),
		}),
	)
	.min(1);

/** setPointerTrack as `openscreen mcp` forwards it to the app: with its takes' start times. */
export const FORWARDED_POINTER_TRACK_SCHEMA = z.object({
	projectId: z.string(),
	events: POINTER_EVENTS,
	/** When each take of the session started, by its video path. */
	takes: z.record(z.string(), z.number()),
	/** The client's own start time, for a video no take of the session recorded. */
	recordingStartedAt: z.number().optional(),
});

/**
 * setPointerTrack's change: the new sidecar, and the zooms planned on its clicks. Computed
 * by the runner's process (the app's, when it runs), and written by that runner. The video's
 * start is the client's `recordingStartedAt` when it gave one, else its take's in `takes`.
 */
export async function pointerTrackEdit(
	document: AxcutDocument,
	events: PointerEvent[],
	takes: Readonly<Record<string, number>>,
	recordingStartedAt?: number,
): ReturnType<RunnerEdit> {
	const asset = document.assets.find((a) => a.id === document.project.primaryAssetId);
	if (!asset?.durationSec) {
		return { ok: false, resultJson: "This project has no video to give a pointer to." };
	}
	const startedAt = recordingStartedAt ?? takes[asset.originalPath];
	if (startedAt === undefined) {
		return {
			ok: false,
			resultJson:
				"This project's video was not recorded by this server, so its start time is unknown. Pass recordingStartedAt: when the video's first frame was captured, on the clock of the events' `at`.",
		};
	}
	const samples = pointerSamples(events, startedAt, asset.durationSec * 1000);
	const sidecar: CursorRecordingData = { version: 2, provider: "native", samples, assets: [] };
	// Planned from the new track before it is on disk, as readCursor would read it back.
	const suggestions = await collectAutoZoomSuggestionsForDocument(
		document,
		async () =>
			samples.map(({ timeMs, cx, cy, visible, interactionType }) => ({
				timeMs,
				cx,
				cy,
				visible,
				interactionType,
			})),
		(candidate) => candidate.id === asset.id,
	);
	return {
		ok: true,
		resultJson: JSON.stringify({ samples: samples.length, autoZoomsAdded: suggestions.length }),
		document: appendAutoZoomSuggestions(document, suggestions),
		sidecars: [{ path: `${asset.originalPath}.cursor.json`, content: JSON.stringify(sidecar) }],
	};
}

type Run = ReturnType<MediaToolDeps["runners"]["start"]>;

/** An export's progress, sent to the client when it asked for it. */
function progressNotifier(
	extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): RunnerHandlers["onProgress"] {
	const progressToken = extra._meta?.progressToken;
	return (progress) => {
		if (progressToken === undefined) return;
		void extra
			.sendNotification({
				method: "notifications/progress",
				params: { progressToken, progress: progress.percentage, total: 100 },
			})
			.catch(() => undefined);
	};
}

/** A runner's result, its hidden window closed: the server outlives every runner. */
async function finish(run: Run): Promise<CliDoneResult> {
	try {
		return await run.done;
	} finally {
		run.close();
	}
}

/** The webcam recorded with a take, as the editor links it to the take's asset. */
interface TakeCamera {
	path: string;
	offsetMs: number;
}

/** The take as a project, laid out as the editor lays out a fresh recording. */
async function createProjectFromVideo(
	deps: MediaToolDeps,
	videoPath: string,
	title: string,
	camera: TakeCamera | null,
) {
	const video = await deps.openVideo(videoPath);
	video.close();
	const { durationSec, width, height } = video;
	if (!Number.isFinite(durationSec) || durationSec <= 0) {
		throw new Error(`Could not read the duration of ${videoPath}`);
	}
	const created = await deps.documents.createProject(title);
	let document: AxcutDocument = await deps.documents.addAsset(created.project.id, {
		path: videoPath,
	});
	const assetId = document.project.primaryAssetId;
	// Its size decides the picture-in-picture's box, as the editor stamps it when it links the
	// camera (projectStore.ts). A camera that cannot be read costs the box its size, not the take.
	const cameraSize = camera
		? await deps.openVideo(camera.path).then(
				(opened) => {
					opened.close();
					return opened.width > 0 && opened.height > 0
						? { width: opened.width, height: opened.height }
						: {};
				},
				() => ({}),
			)
		: {};
	document = {
		...document,
		assets: document.assets.map((asset) =>
			asset.id === assetId
				? {
						...asset,
						durationSec,
						video: {
							codec: asset.video?.codec ?? "unknown",
							width,
							height,
							fps: asset.video?.fps ?? 0,
						},
						...(camera
							? {
									cameraTrack: {
										sourcePath: camera.path,
										startMs: 0,
										// An integer, as the schema wants: the native paths measure it in fractions.
										offsetMs: Math.round(camera.offsetMs),
										visible: true,
										...cameraSize,
									},
								}
							: {}),
					}
				: asset,
		),
	};
	const seeded = await runDocumentTool(
		document,
		"replaceTimeline",
		{ intervals: [{ startSec: 0, endSec: durationSec }], reason: "The recorded take" },
		true,
		{},
	);
	if (!seeded.ok || !seeded.document) throw new Error(seeded.resultJson);
	// The zooms a recording made in the app starts with, planned from its clicks (zoom-suggestions.ts).
	const suggestions = await collectAutoZoomSuggestionsForDocument(seeded.document, deps.readCursor);
	const saved = await deps.documents.saveProject(
		appendAutoZoomSuggestions(seeded.document, suggestions),
	);
	return { document: saved, durationSec, autoZooms: suggestions.length };
}

/** `openscreen mcp`'s recorder: a hidden record runner, and the take laid out as a project here. */
function runnerRecorder(deps: MediaToolDeps): TakeRecorder {
	const now = deps.now ?? Date.now;
	return {
		async start(request) {
			let markStarted: () => void = () => undefined;
			const started = new Promise<"started">((resolve) => {
				markStarted = () => resolve("started");
			});
			const run = deps.runners.start(
				{
					kind: "record",
					...request,
					durationMs: null,
					projectOut: null,
				},
				{
					onLog: (_level, message) => {
						if (message === "Recording started") markStarted();
					},
				},
			);
			const outcome = await Promise.race([started, run.done]);
			if (outcome !== "started") {
				run.close();
				throw new Error(outcome.error ?? "unknown error");
			}
			const startedAt = now();
			return {
				startedAt,
				async stop(title) {
					try {
						run.window.webContents.send("cli-stop-recording");
					} catch {
						// The runner already went away; its result says why.
					}
					const result = await finish(run);
					if (!result.success || !result.screenVideoPath) {
						throw new Error(`The recording failed: ${result.error ?? "unknown error"}`);
					}
					const warnings = [
						...(result.warnings ?? []),
						...(request.camera && !result.webcamVideoPath ? [NO_WEBCAM_PICTURE] : []),
					];
					try {
						const project = await createProjectFromVideo(
							deps,
							result.screenVideoPath,
							title || `Recording ${new Date(startedAt).toLocaleString()}`,
							result.webcamVideoPath
								? { path: result.webcamVideoPath, offsetMs: result.webcamOffsetMs ?? 0 }
								: null,
						);
						return {
							projectId: project.document.project.id,
							videoPath: result.screenVideoPath,
							durationSec: project.durationSec,
							autoZooms: project.autoZooms,
							...(warnings.length ? { warnings } : {}),
						};
					} catch (error) {
						// The take is on disk all the same: say where, so it can still be looked at.
						throw new Error(
							`The take was saved to ${result.screenVideoPath}, but it could not be turned into a project: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				},
			};
		},
	};
}

/** The take startRecording claimed: `running` once capture has started. */
interface TakeSlot {
	running: RunningTake | null;
	stopping: boolean;
}

export function createMediaTools(deps: MediaToolDeps): MediaTools {
	const { transport } = deps;
	const recorder = deps.recorder ?? runnerRecorder(deps);
	/** The take being recorded, then saved: held until it is a project. */
	let take: TakeSlot | null = null;
	/** A take runs: this server's own, or one the user started from the HUD, which the in-app
	 *  host reports. An export or a measure would take frames from it either way. */
	const recording = () => take !== null || deps.recordingActive?.() === true;
	// A take and an export never run together: each is a heavy job of its own, and a
	// take's capture must not lose frames to an export.
	let exporting = false;
	// Standalone project creation remains active through asset import and checkpoint save.
	let projectOperations = 0;
	/** When each take of this session started, by its video: setPointerTrack's clock. */
	const startedAtByVideo = new Map<string, number>();
	/** Each project's last export of this session, and when it was made: what getFrames reads. */
	const lastExports = new Map<string, { path: string; at: Date; rendered: AxcutDocument }>();

	/** getFrames when no export shows the project as it is (`docs/shader-effects.md`, E.4): its
	 *  frames composed as its export would compose them, on the export's default frame grid,
	 *  without encoding a video. `null` when the addon cannot render them: the export decides. */
	async function renderProjectShots(
		document: AxcutDocument,
		query: FrameQuery,
		count: number,
		maxWidth: number,
		why: string,
	): Promise<Shots | CallToolResult | null> {
		if (!deps.renderFrames) return null;
		// The frame grid below counts every clip, the render only those with media: past a clip
		// without one, the two would disagree on which frame a moment is.
		const paths = new Map(document.assets.map((asset) => [asset.id, asset.originalPath]));
		if (document.timeline.clips.some((clip) => !paths.get(clip.assetId))) {
			return text("A clip on this timeline has no media file: its frames cannot be placed.", true);
		}
		const clips = buildNativeClipList(document);
		if (clips.length === 0) return text("This project's timeline has no clip to show.", true);
		const rulerEndSec = Math.max(0, ...document.timeline.clips.map((clip) => clip.timelineEndSec));
		// Asked times are kept as asked up to the end: the clamp to the last frame is made on the
		// output's frames below, where a slowed end does not stretch it.
		const times = query.atSec
			? query.atSec.map((sec) => Math.min(sec, rulerEndSec))
			: frameTimes(rulerEndSec, null, count, query);
		const lastIndex = Math.max(
			0,
			Math.ceil(programmeSecOf(document, rulerEndSec) * EXPORT_FPS - 1e-6) - 1,
		);
		// The output frame showing at that moment: the last one that starts at or before it.
		const indices = times.map((sec) =>
			Math.min(Math.floor(programmeSecOf(document, sec) * EXPORT_FPS + 1e-6), lastIndex),
		);
		let frames: Awaited<ReturnType<NonNullable<MediaToolDeps["renderFrames"]>>>;
		try {
			const scene = JSON.stringify(buildSceneDescription(document));
			frames = await deps.renderFrames(clips, scene, EXPORT_FPS, indices, maxWidth);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return text(`The frames could not be rendered: ${message}`, true);
		}
		if (!frames) return null;
		const byIndex = new Map(frames.map((frame) => [frame.index, frame]));
		return {
			intro: `${times.length} frame(s) rendered from the project as its export would show them: ${why}.`,
			shots: times.map((sec, i) => {
				const frame = byIndex.get(indices[i]);
				return {
					caption: `${sec.toFixed(2)}s on the ruler`,
					sec,
					jpeg: frame?.jpeg ?? null,
					...(frame ? { size: { width: frame.width, height: frame.height } } : {}),
				};
			}),
		};
	}

	/**
	 * The frames a query asks for, at most `maxWidth` wide: of a project (its current export,
	 * else rendered from it) or of a video file. An error result when they cannot be had.
	 */
	async function shotsOf(
		query: FrameQuery,
		defaultCount: number,
		maxWidth: number,
	): Promise<Shots | CallToolResult> {
		const problem = frameQueryProblem(query);
		if (problem) return text(problem, true);
		const count = query.count ?? defaultCount;
		let videoPath: string;
		/** Ruler seconds → seconds of the exported file, when looking at a project. */
		let toVideoSec = (sec: number) => sec;
		let rulerEndSec: number | null = null;
		let note = "";
		if (query.projectId !== undefined) {
			const exported = lastExports.get(query.projectId);
			// A project deleted since still left its export on disk: show it, unflagged.
			const current = await deps.documents.getProject(query.projectId).catch(() => null);
			const stale =
				exported !== undefined &&
				current !== null &&
				Date.parse(current.project.updatedAt) > exported.at.getTime();
			// No export shows the project as it is: render its frames as an export would.
			if (current && (!exported || stale)) {
				const why = exported ? "it changed after its last export" : "it has no export yet";
				const rendered = await renderProjectShots(current, query, count, maxWidth, why);
				if (rendered) return rendered;
			}
			if (!exported) {
				return text("This project has no export yet: call exportVideo first.", true);
			}
			// Mapped through the document the export rendered, so a cut made since cannot shift
			// which frame of this video is shown; the current one only says whether it is stale.
			const { rendered } = exported;
			videoPath = exported.path;
			toVideoSec = (sec) => programmeSecOf(rendered, sec);
			rulerEndSec = Math.max(0, ...rendered.timeline.clips.map((clip) => clip.timelineEndSec));
			if (stale) {
				note = " The project changed after this export: export it again to see the changes.";
			}
		} else {
			const resolved = clientPath(transport, query.path ?? "");
			if (!resolved) return text(`The path must be absolute, got "${query.path}".`, true);
			videoPath = resolved;
		}

		const video = await deps.openVideo(videoPath);
		try {
			const asked =
				query.atSec ?? (rulerEndSec === null ? null : frameTimes(rulerEndSec, null, count, query));
			const times = asked
				? asked.map((sec) => ({
						asked: sec,
						at: frameTimes(video.durationSec, [toVideoSec(sec)], 1)[0],
					}))
				: frameTimes(video.durationSec, null, count, query).map((at) => ({ asked: at, at }));
			const shots: Shot[] = [];
			for (const { asked: askedSec, at } of times) {
				const frame = await video.capture(at, maxWidth);
				shots.push({
					caption:
						rulerEndSec === null
							? `${at.toFixed(2)}s`
							: `${askedSec.toFixed(2)}s on the ruler, ${at.toFixed(2)}s into the video`,
					// A file's frame is labelled with the time it was taken at, which a time past the
					// end is not; a project's keeps the ruler second it was asked at.
					sec: rulerEndSec === null ? at : askedSec,
					jpeg: Buffer.from(frame.data, "base64"),
				});
			}
			return {
				intro: `${times.length} frame(s) of a ${video.width}x${video.height} video lasting ${video.durationSec.toFixed(2)}s.${note}`,
				shots,
			};
		} finally {
			video.close();
		}
	}

	/** The request an audio render makes of the export runner: exportAudio's, and the report's. */
	const audioRender = (
		projectId: string,
		outPath: string,
		format: "wav" | "m4a",
		audioId: string | undefined,
	): CliRequest => ({
		kind: "export",
		projectPath: deps.documents.filePathFor(projectId),
		projectId,
		outPath,
		format,
		quality: null,
		// The frame grid exportVideo lays the audio out on by default.
		mp4FrameRate: EXPORT_FPS,
		gifFrameRate: null,
		gifSizePreset: null,
		gifLoop: null,
		autoZoom: false,
		audioPath: null,
		audioMode: "mix",
		audioOffsetSec: 0,
		audioTrackId: audioId ?? null,
	});

	/** A fresh project's checkpoint, so a client can edit it at once and take it back in one step. */
	async function checkpointOf(projectId: string): Promise<string | null> {
		// Never fails the call: the project exists either way, and its id is the answer.
		try {
			const checkpoint = await deps.runTool("createCheckpoint", { projectId });
			const checkpointText =
				checkpoint.content[0]?.type === "text" ? checkpoint.content[0].text : "";
			return checkpoint.isError
				? null
				: ((JSON.parse(checkpointText) as { checkpointId?: string }).checkpointId ?? null);
		} catch {
			return null;
		}
	}

	/** Stops the take, then hands back its project with a checkpoint of it. */
	async function stopTake(
		running: RunningTake,
		requestedTitle: string | undefined,
	): Promise<CallToolResult> {
		let recorded: RecordedTake;
		try {
			recorded = await running.stop(requestedTitle?.trim() || undefined);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
		return recordingResult(recorded, running.startedAt);
	}

	/** Also the one place a take's start is kept, so setPointerTrack finds a waited-for take. */
	async function recordingResult(
		recorded: RecordedTake,
		recordingStartedAt: number,
	): Promise<CallToolResult> {
		startedAtByVideo.set(recorded.videoPath, recordingStartedAt);
		const { projectId } = recorded;
		return text(
			JSON.stringify({
				projectId,
				checkpointId: await checkpointOf(projectId),
				videoPath: recorded.videoPath,
				durationSec: recorded.durationSec,
				recordingStartedAt,
				autoZooms: recorded.autoZooms,
				...(recorded.warnings?.length ? { warnings: recorded.warnings } : {}),
			}),
		);
	}

	function register(server: McpServer): void {
		server.registerTool(
			"listSources",
			{
				description: `List the displays and windows OpenScreen can record, the microphones and the cameras. Pass startRecording a display's index or part of a window's title, and part of a microphone's or a camera's name. microphoneLabelsUnavailable or cameraLabelsUnavailable true means their names need a permission the user has not granted, so the list is empty: ask the user to allow it. ${HIDDEN_WINDOWS_NOTE}`,
				inputSchema: z.object({}),
				annotations: READ_ONLY,
			},
			async () => {
				const result = await finish(deps.runners.start({ kind: "sources" }));
				if (!result.success || !result.sources) {
					return text(`Could not list the sources: ${result.error ?? "unknown error"}`, true);
				}
				const { displays, windows, microphones, cameras } = result.sources;
				return text(
					JSON.stringify({
						displays: displays.map(({ index, name }) => ({ index, name })),
						windows: windows.map((window) => window.name),
						microphones: microphones.map((mic) => mic.label),
						cameras: cameras.map((camera) => camera.label),
						// An empty list is not "none" when the names need a permission: say which.
						microphoneLabelsUnavailable: result.sources.microphoneLabelsUnavailable,
						cameraLabelsUnavailable: result.sources.cameraLabelsUnavailable,
					}),
				);
			},
		);

		server.registerTool(
			"startRecording",
			{
				description: `Start recording one window (preferred: nothing else on the desktop is captured) or one display. Returns once capture has started; then drive the app and call stopRecording. By default the pointer is recorded as data, so the export draws a clean cursor and the zooms planned from the clicks. A webcam recorded with it shows as a picture-in-picture in the project. Hiding the desktop icons follows the user's own Record mode setting. ${START_RECORDING_NOTES[transport]}`,
				inputSchema: z.object({
					window: z
						.string()
						.optional()
						.describe(
							"Part of the title of the window to record, ignoring case. Wins over display.",
						),
					display: z
						.number()
						.int()
						.min(0)
						.optional()
						.describe("Index of the display to record, from listSources. Default 0."),
					systemAudio: z.boolean().optional().describe("Also record the computer's sound."),
					microphone: z
						.union([z.boolean(), z.string()])
						.optional()
						.describe("true for the default microphone, or part of a microphone's name."),
					camera: z
						.union([z.boolean(), z.string()])
						.optional()
						.describe(
							"Also record the webcam: true for the camera the user picked in OpenScreen, or part of a camera's name.",
						),
					cursor: z
						.enum(["editable-overlay", "system"])
						.optional()
						.describe(
							"editable-overlay (default): the pointer is recorded as data, drawn clean by the export, with zooms on its clicks. system: the system's own pointer is burned into the video, with no zooms on clicks and no setPointerTrack.",
						),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args) => {
				if (!deps.editsAllowed()) return text(GATED_MESSAGE, true);
				if (take?.running && !take.stopping && deps.recordingActive?.() === false) take = null;
				if (take?.stopping) {
					return text("The last take is still being saved. Try again in a moment.", true);
				}
				if (take) return text("A recording is already running. Call stopRecording first.", true);
				if (exporting) return text("An export is running. Wait for it, then try again.", true);
				// Claimed before the first await, so a second call cannot start a second take.
				const claimed: TakeSlot = { running: null, stopping: false };
				take = claimed;
				try {
					claimed.running = await recorder.start({
						displayIndex: args.display ?? 0,
						windowTitle: args.window ?? null,
						mic: args.microphone !== undefined && args.microphone !== false,
						micDevice: typeof args.microphone === "string" ? args.microphone : null,
						systemAudio: args.systemAudio === true,
						camera: args.camera !== undefined && args.camera !== false,
						cameraDevice: typeof args.camera === "string" ? args.camera : null,
						cursorMode: args.cursor ?? "editable-overlay",
					});
				} catch (error) {
					take = null;
					return text(
						`The recording did not start: ${error instanceof Error ? error.message : String(error)}`,
						true,
					);
				}
				return text(
					JSON.stringify({ recording: true, startedAt: claimed.running.startedAt }) +
						"\nRecording. Drive the app now, pausing about a second after each result appears, then call stopRecording.",
				);
			},
		);

		server.registerTool(
			"stopRecording",
			{
				description: STOP_RECORDING_DESCRIPTIONS[transport],
				inputSchema: z.object({
					title: z.string().optional().describe("The project's title in OpenScreen."),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args) => {
				const current = take;
				if (!current?.running) {
					return text(
						current ? "The recording is still starting." : "No recording is running.",
						true,
					);
				}
				if (current.stopping) return text("This recording is already being stopped.", true);
				// Claimed before the first await, so a second call cannot save the same take twice.
				current.stopping = true;
				try {
					return await stopTake(current.running, args.title);
				} finally {
					take = null;
				}
			},
		);

		server.registerTool(
			"waitForRecording",
			{
				description:
					"Wait for the current recording in the OpenScreen app to finish and its project to be saved, including a take started by the user at the recording bar. Never starts or stops a recording. Binds to this take only, including while it saves; returns an error immediately if none is active. Returns the same recording fields as stopRecording. Timeout or request cancellation only ends the wait. Available on the in-app HTTP server; openscreen mcp cannot observe the app's recording bar.",
				inputSchema: z.object({
					timeoutSec: z
						.number()
						.int()
						.min(1)
						.max(3600)
						.default(300)
						.describe(
							"Maximum seconds to wait, including saving (1–3600, default 300). Set the client's tool-call timeout longer than this.",
						),
				}),
				annotations: READ_ONLY,
			},
			async ({ timeoutSec }, { signal }) => {
				if (!deps.waitForRecording)
					return text(
						"waitForRecording requires the in-app HTTP MCP server. Connect to it to observe the user's recording.",
						true,
					);
				const observedTake = take;
				try {
					const recorded = await deps.waitForRecording(timeoutSec * 1000, signal);
					return recordingResult(recorded, recorded.recordingStartedAt);
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error), true);
				} finally {
					// A take still starting keeps its claim: only a running one can have finished.
					if (
						take === observedTake &&
						take?.running &&
						!take.stopping &&
						deps.recordingActive?.() === false
					)
						take = null;
				}
			},
		);

		server.registerTool(
			"setPointerTrack",
			{
				description: [
					"For a video driven by a script (Playwright, CDP, a browser extension) rather than the real mouse: the screen pointer never moved, so the video has no cursor and no zoom. Give the pointer's path here and OpenScreen draws it, gliding between your actions, and zooms on its clicks as for a real mouse. It replaces the pointer recorded with the video, saved beside it as <video>.cursor.json, then plans zooms on the new clicks as stopRecording does, clear of the zooms already there; autoZoomsAdded says how many. A take from stopRecording knows when it started; a video given to createProject needs recordingStartedAt. It is an edit like any other: on a project that is not open in the editor it needs a checkpoint (stopRecording and createProject make one), and restoreCheckpoint undoes it, the pointer track included.",
					"events, one per action: `at` is Date.now() when your script did it (log it as it runs; the take's recordingStartedAt is on the same clock). `x` and `y` are fractions (0 to 1) of the recorded window. For a point (clientX, clientY) of a page shown in that window, from inside the page: border = (outerWidth - innerWidth) / 2; x = (border + clientX) / outerWidth; y = (outerHeight - innerHeight - border + clientY) / outerHeight.",
				].join("\n"),
				inputSchema: z.object({
					projectId: z.string(),
					events: POINTER_EVENTS,
					recordingStartedAt: z
						.number()
						.optional()
						.describe(
							"When the video's first frame was captured, on the clock of the events' `at`: needed for a video this server did not record, such as one given to createProject. A take from stopRecording defaults to its own. For a video captured frame by frame, pass 0 and give each `at` as milliseconds into the video.",
						),
				}),
				annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
			},
			// Through the document tools' runner, like any edit: the same queue, the same refusals
			// (edits turned off, a project open in the app's editor, one with no checkpoint) before
			// anything is written, and the sidecar kept by the checkpoints so restoreCheckpoint puts
			// it back. The args carry what the edit needs, so a running app can compute it
			// (app-channel.ts).
			(args) => {
				const takes = Object.fromEntries(startedAtByVideo);
				const { projectId, events, recordingStartedAt } = args;
				return deps.runTool(
					POINTER_TRACK_TOOL,
					{ projectId, events, takes, recordingStartedAt },
					{ edit: (document) => pointerTrackEdit(document, events, takes, recordingStartedAt) },
				);
			},
		);

		server.registerTool(
			"exportVideo",
			{
				description:
					"Render a project to an MP4 (H.264) or a GIF with OpenScreen's compositor: the background, cursor, zooms, cuts, speed changes and annotations as edited. Returns the file's path; call getFrames with the projectId to check it at the ruler seconds you edited with. The video's shape follows the project's format (setAspectRatio). The options are the Export dialog's: quality and fps for an MP4; gifFrameRate, gifSize and gifLoop for a GIF.",
				inputSchema: z.object({
					projectId: z.string(),
					path: z.string().describe(EXPORT_PATH_DESCRIPTIONS[transport]),
					quality: z
						.enum(["medium", "good", "source"])
						.optional()
						.describe(
							"MP4 only. The height: medium is 720 pixels, good is 1080 (default), source keeps the recording's. The width follows the format.",
						),
					fps: z
						.literal(MP4_FRAME_RATES)
						.optional()
						.describe("MP4 only. Frames per second. Default 60."),
					gifFrameRate: z
						.literal(VALID_GIF_FRAME_RATES)
						.optional()
						.describe("GIF only. Frames per second. Default 15."),
					gifSize: z
						.enum(GIF_SIZES)
						.optional()
						.describe(
							`GIF only. The largest height in pixels, never upscaled: ${GIF_SIZES.map((size) => `${size} ${Number.isFinite(GIF_SIZE_PRESETS[size].maxHeight) ? GIF_SIZE_PRESETS[size].maxHeight : "keeps the recording's"}`).join(", ")}. Default medium.`,
						),
					gifLoop: z
						.boolean()
						.optional()
						.describe("GIF only. Loop forever (default) or play once."),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args, extra) => {
				if (!deps.editsAllowed()) return text(GATED_MESSAGE, true);
				if (recording()) return text("A recording is running. Stop it before exporting.", true);
				if (exporting)
					return text("An export is already running. Wait for it, then try again.", true);
				const outPath = clientPath(transport, args.path);
				if (!outPath) return text(`The path must be absolute, got "${args.path}".`, true);
				const extension = path.extname(outPath).toLowerCase();
				if (extension !== ".mp4" && extension !== ".gif") {
					return text(`The path must end in .mp4 or .gif, got "${args.path}".`, true);
				}
				const gif = extension === ".gif";
				// The dialog offers each format its own options only: one for the other would do nothing.
				const misplaced = (gif ? MP4_OPTIONS : GIF_OPTIONS).filter(
					(option) => args[option] !== undefined,
				);
				if (misplaced.length > 0) {
					return text(
						`${misplaced.join(", ")}: not for ${gif ? "a GIF" : "an MP4"}. The path's extension picks the format.`,
						true,
					);
				}
				exporting = true;
				try {
					// The project as the export reads it, and when: getFrames maps ruler seconds through
					// THIS document's cuts and speeds, and calls anything saved after `at` a change the
					// video does not have.
					const at = new Date();
					const rendered = await deps.documents.getProject(args.projectId).catch(() => null);
					if (!rendered) return text(`No project has the id "${args.projectId}".`, true);
					const run = deps.runners.start(
						{
							kind: "export",
							projectPath: deps.documents.filePathFor(args.projectId),
							// Read by id, as the editor opens a project: nothing of the app's own state moves.
							projectId: args.projectId,
							outPath,
							format: gif ? "gif" : "mp4",
							// The Export dialog's defaults, not whatever an older editor stored.
							// A GIF carries no quality: the export runner refuses one, and gifSize sizes it.
							quality: gif ? null : (args.quality ?? "good"),
							mp4FrameRate: args.fps ?? EXPORT_FPS,
							gifFrameRate: args.gifFrameRate ?? 15,
							gifSizePreset: args.gifSize ?? "medium",
							gifLoop: args.gifLoop ?? true,
							// No zooms or voiceover added at export: they are edits of the project
							// (addZoom, setPointerTrack, addAudio), or the video is not what getFrames reads.
							autoZoom: false,
							audioPath: null,
							audioMode: "mix",
							audioOffsetSec: 0,
						},
						{ onProgress: progressNotifier(extra) },
					);
					const result = await finish(run);
					if (!result.success) {
						return text(`The export failed: ${result.error ?? "unknown error"}`, true);
					}
					const written = result.outputPath ?? outPath;
					// The file now holds this video: no other project's record may still point at it.
					for (const [id, record] of lastExports) {
						if (id !== args.projectId && record.path === written) lastExports.delete(id);
					}
					// The runner read the project file itself. Unless nothing was saved since `rendered`
					// was read, it may have rendered another version, so this video gets no record.
					const after = await deps.documents.getProject(args.projectId).catch(() => null);
					if (after?.project.updatedAt !== rendered.project.updatedAt) {
						lastExports.delete(args.projectId);
						return text(
							`${JSON.stringify({ path: result.outputPath, format: result.format, width: result.width, height: result.height })}\nThe project changed while it exported, so this video may not match it: export again before checking it with getFrames.`,
						);
					}
					lastExports.set(args.projectId, { path: written, at, rendered });
					return text(
						JSON.stringify({
							path: result.outputPath,
							format: result.format,
							width: result.width,
							height: result.height,
						}),
					);
				} finally {
					exporting = false;
				}
			},
		);

		server.registerTool(
			"exportAudio",
			{
				description:
					"Write a project's audio to a WAV or an M4A, exactly as exportVideo's MP4 mixes it: the recording's sound, the imported tracks with their offset, trims, gain and fades, through the same cuts and speed regions. With audioId (addAudio's, or an audioTracks entry's trackId, its id when it has no trackId), only that track, alone, placed where it plays in the export: the file lasts as long as the video, silent around the track. It renders the project as an export does, so it takes about as long as exportVideo.",
				inputSchema: z.object({
					projectId: z.string(),
					path: z.string().describe(AUDIO_PATH_DESCRIPTIONS[transport]),
					audioId: z
						.string()
						.optional()
						.describe("Export this imported track alone. Default: the whole programme audio."),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args, extra) => {
				if (!deps.editsAllowed()) return text(GATED_MESSAGE, true);
				if (recording()) return text("A recording is running. Stop it before exporting.", true);
				if (exporting)
					return text("An export is already running. Wait for it, then try again.", true);
				const outPath = clientPath(transport, args.path);
				if (!outPath) return text(`The path must be absolute, got "${args.path}".`, true);
				const format = path.extname(outPath).toLowerCase().slice(1);
				if (!isAudioExportFormat(format)) {
					return text(`The path must end in .wav or .m4a, got "${args.path}".`, true);
				}
				exporting = true;
				try {
					if (!(await deps.documents.getProject(args.projectId).catch(() => null))) {
						return text(`No project has the id "${args.projectId}".`, true);
					}
					const result = await finish(
						deps.runners.start(audioRender(args.projectId, outPath, format, args.audioId), {
							onProgress: progressNotifier(extra),
						}),
					);
					if (!result.success) {
						return text(`The export failed: ${result.error ?? "unknown error"}`, true);
					}
					return text(JSON.stringify({ path: result.outputPath, format: result.format }));
				} finally {
					exporting = false;
				}
			},
		);

		server.registerTool(
			"exportCaptions",
			{
				description:
					"Write a project's captions to a subtitle file, SubRip (.srt) or WebVTT (.vtt), picked by the path's extension. The entries are the lines the burnt-in captions show, with the same words per line, timed in seconds of the exported video: after the trims and the speed regions, so the file plays in sync with exportVideo's MP4. It does not need the captions to be on, and does not turn them on. language picks the words: omitted, the language the captions show (getCaptions' language); null, the transcript's own words; a code, that translation layer (getCaptions lists them under translations). Captions come from the transcript, so a project with none on its caption lane has nothing to write and is refused. Returns the path, the format, the language written and the number of entries. Instant: nothing is rendered.",
				inputSchema: z.object({
					projectId: z.string(),
					path: z.string().describe(CAPTIONS_PATH_DESCRIPTIONS[transport]),
					language: z
						.string()
						.nullable()
						.optional()
						.describe(
							"A translation layer's code, null for the transcript's own words, omitted for what the captions show.",
						),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args) => {
				if (!deps.editsAllowed()) return text(GATED_MESSAGE, true);
				const outPath = clientPath(transport, args.path);
				if (!outPath) return text(`The path must be absolute, got "${args.path}".`, true);
				const format = path.extname(outPath).toLowerCase().slice(1);
				if (!isSubtitleFileFormat(format)) {
					return text(`The path must end in .srt or .vtt, got "${args.path}".`, true);
				}
				const document = await deps.documents.getProject(args.projectId).catch(() => null);
				if (!document) return text(`No project has the id "${args.projectId}".`, true);
				if (typeof args.language === "string") {
					const layers = Object.keys(getCaptionTranslations(document));
					if (!layers.includes(args.language)) {
						return text(
							`The project has no "${args.language}" caption translation. ${
								layers.length
									? `Its layers are: ${layers.join(", ")}.`
									: "It has none: putCaptionTranslation writes one."
							} Pass null for the transcript's own words.`,
							true,
						);
					}
				}
				const cues = subtitleCuesForExport(document, args.language);
				if (cues.length === 0) {
					return text(
						"Nothing was written: the captions have no words to show. They come from the transcript of what the caption lane plays, so transcribe it first (transcribe), or check getCaptions' captionedAssets.",
						true,
					);
				}
				// Staged under a short name, then renamed over the file: a write that fails halfway
				// leaves a subtitle file already there as it was, and a replaced one keeps its mode.
				try {
					await writeFileReplacing(outPath, Buffer.from(formatSubtitleFile(cues, format), "utf8"));
				} catch (error) {
					return text(
						`The subtitles could not be written to "${outPath}": ${error instanceof Error ? error.message : String(error)}`,
						true,
					);
				}
				const language =
					args.language === undefined ? getCaptionSettings(document).language : args.language;
				return text(JSON.stringify({ path: outPath, format, language, entries: cues.length }));
			},
		);

		server.registerTool(
			"getAudioReport",
			{
				description: [
					"Measure a project's sound, exactly as exportVideo's MP4 mixes it: you cannot hear a film, so check its mix with these numbers. Returns integratedLufs, the loudness of the whole film (null when it is silent; video platforms play at about -14 LUFS); truePeakDbtp, its highest peak; durationSec, the exported film's length; and silences, every stretch of half a second or more that stays under -60 dBFS, in the ruler seconds the document tools use.",
					"With audioId (addAudio's, or an audioTracks entry's trackId, its id when it has no trackId), that imported track alone: a music bed and a voice measured apart say how far one sits under the other. It renders the project as an export does, so it takes about as long as exportVideo. Call it again after an edit that moves time (a trim, a speed region, a track's offset).",
				].join("\n"),
				inputSchema: z.object({
					projectId: z.string(),
					audioId: z
						.string()
						.optional()
						.describe("Measure this imported track alone. Default: the whole programme audio."),
				}),
				annotations: READ_ONLY,
			},
			async (args, extra) => {
				if (recording()) {
					return text("A recording is running. Stop it before measuring the sound.", true);
				}
				if (exporting)
					return text("An export is already running. Wait for it, then try again.", true);
				// Rendered beside nothing of the client's: measured, then removed.
				const wavPath = path.join(os.tmpdir(), `openscreen-audio-report-${randomUUID()}.wav`);
				exporting = true;
				try {
					const document = await deps.documents.getProject(args.projectId).catch(() => null);
					if (!document) return text(`No project has the id "${args.projectId}".`, true);
					const result = await finish(
						deps.runners.start(audioRender(args.projectId, wavPath, "wav", args.audioId), {
							onProgress: progressNotifier(extra),
						}),
					);
					if (!result.success) {
						return text(
							`The sound could not be rendered: ${result.error ?? "unknown error"}`,
							true,
						);
					}
					let report: AudioReport;
					try {
						report = await measureWav(result.outputPath ?? wavPath);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return text(`The sound could not be measured: ${message}`, true);
					}
					// The runner read the project file itself: a save since `document` was read may have
					// moved the sound, and the silences would be placed on the wrong ruler seconds.
					const after = await deps.documents.getProject(args.projectId).catch(() => null);
					if (after?.project.updatedAt !== document.project.updatedAt) {
						return text(
							"The project changed while its sound was measured. Measure it again.",
							true,
						);
					}
					const removed = removedRawSpans(document.timeline.clips, document.timeline.trimRanges);
					return text(
						JSON.stringify({
							durationSec: round(report.durationSec, 2),
							integratedLufs:
								report.integratedLufs === null ? null : round(report.integratedLufs, 1),
							truePeakDbtp: report.truePeakDbtp === null ? null : round(report.truePeakDbtp, 1),
							silences: report.silences.flatMap(({ startSec, endSec }) => {
								const from = rulerSecOf(document, startSec, true);
								const to = rulerSecOf(document, endSec, false);
								// A cut inside a silence is not silent, it is not played: the silence
								// is the pieces on either side of it.
								const pieces = subtractRemoved(from, to, removed);
								return (pieces.length > 0 ? pieces : [{ startSec: from, endSec: to }]).map(
									(piece) => ({
										startSec: round(piece.startSec, 2),
										endSec: round(piece.endSec, 2),
									}),
								);
							}),
						}),
					);
				} finally {
					exporting = false;
					await fs.rm(wavPath, { force: true }).catch(() => undefined);
				}
			},
		);

		server.registerTool(
			"getFrames",
			{
				description: [
					`Look at a video as still images, at most ${MAX_FRAMES} per call. Ask for the moments you need to check, such as each zoom and each callout.`,
					"To check an edit, pass projectId: atSec are the ruler seconds the document tools use, mapped through the trims and speed regions to the moment the export plays them. You get the project's last export, or, when it has none or has changed since, the frames its export would show, rendered from the project without exporting it. With path instead, you get any video file (a take's videoPath, say) and atSec are that file's own seconds.",
					"With region, each frame is only that part of the picture, at the video's own resolution, scaled down only when that part is wider than 1280 pixels: the way to read small text, or to check an edge or a corner. To see many moments at once, such as the rhythm of the whole film or a transition frame by frame, use getContactSheet.",
				].join("\n"),
				inputSchema: z.object(frameQueryShape(transport, MAX_FRAMES, 6)),
				annotations: READ_ONLY,
			},
			async (args) => {
				const { region } = args;
				if (region && !deps.images) return text(NO_IMAGE_WORK, true);
				const found = await shotsOf(args, 6, region ? FULL_WIDTH : FRAME_WIDTH);
				if (!isShots(found)) return found;
				const content: CallToolResult["content"] = [{ type: "text", text: found.intro }];
				try {
					for (const shot of found.shots) {
						content.push({ type: "text", text: shot.caption });
						if (!shot.jpeg) {
							content.push({ type: "text", text: NO_FRAME_HERE });
							continue;
						}
						const jpeg =
							region && deps.images ? deps.images.crop(shot.jpeg, region, FRAME_WIDTH) : shot.jpeg;
						content.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return text(`The frames could not be cropped: ${message}`, true);
				}
				return { content };
			},
		);

		server.registerTool(
			"getContactSheet",
			{
				description: [
					`Look at many moments of a video as one image, 1280 pixels wide: a grid of up to ${MAX_SHEET_FRAMES} small frames, each with its time printed in its corner, read left to right then top to bottom. A dozen frames, four across, make an image the size of one frame of getFrames.`,
					"Over the whole film (the default) it shows the rhythm: where the zooms, the callouts and the cuts fall. Over a short span, startSec to endSec, it shows a zoom's move, an effect or a cut frame by frame: 12 frames over one second, say. The frames are too small to read text: use getFrames, with region if need be, for that.",
					"projectId, path and the times mean what they mean for getFrames: ruler seconds with projectId, rendered from the project when it has no current export; the file's own seconds with path.",
				].join("\n"),
				inputSchema: z.object({
					...frameQueryShape(transport, MAX_SHEET_FRAMES, 12),
					columns: z
						.number()
						.int()
						.min(2)
						.max(6)
						.optional()
						.describe(
							"Frames per row. Fewer make each frame larger and the image taller. Default: 4 for up to 12 frames, 5 for up to 24, 6 beyond.",
						),
				}),
				annotations: READ_ONLY,
			},
			async (args) => {
				const { images } = deps;
				if (!images) return text(NO_IMAGE_WORK, true);
				const { region } = args;
				// More frames, more across: the sheet stays about as tall as one frame.
				const wanted = args.atSec?.length ?? args.count ?? 12;
				const columns = args.columns ?? (wanted > 24 ? 6 : wanted > 12 ? 5 : 4);
				const tileWidth = tileWidthFor(columns);
				const found = await shotsOf(args, 12, region ? FULL_WIDTH : tileWidth);
				if (!isShots(found)) return found;
				try {
					const tiles = found.shots.map((shot) => ({
						label: `${shot.sec.toFixed(2)}s`,
						bitmap: shot.jpeg
							? images.decode(
									region ? images.crop(shot.jpeg, region, tileWidth) : shot.jpeg,
									tileWidth,
								)
							: null,
					}));
					// The tallest tile: a file whose resolution changes midway has frames of two heights.
					const tileHeight = Math.max(0, ...tiles.map((tile) => tile.bitmap?.height ?? 0));
					if (tileHeight === 0) {
						return text("No frame to show: the video ends before these times.", true);
					}
					const sheet = composeContactSheet(tiles, columns, tileWidth, tileHeight);
					return {
						content: [
							{
								type: "text",
								text: `${found.intro} On one sheet, ${columns} across, in reading order: ${tiles.map((tile) => tile.label).join(", ")}.`,
							},
							{
								type: "image",
								data: images.encode(sheet).toString("base64"),
								mimeType: "image/jpeg",
							},
						],
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return text(`The sheet could not be made: ${message}`, true);
				}
			},
		);

		const pairShape = frameQueryShape(transport, MAX_PAIRS, 4);
		server.registerTool(
			"getBeforeAfter",
			{
				description: [
					`See what your edits changed: up to ${MAX_PAIRS} moments of a project as one image, 1280 pixels wide, one moment per row. Left, the project as it was at a checkpoint; right, as it is now. Both sides are rendered from the project as its export would show them, without exporting it.`,
					"For each moment the answer also says whether the two frames differ and, when they do, over what share of the picture and inside which region of the frame: pass that region to getFrames to read the change at full resolution. A moment reported unchanged shows no difference this comparison can see: it compares the sheet's tiles and lets through a shift of a few levels, so a faint or very small change can pass unseen. Compare a region when that matters.",
					"checkpointId is one that createCheckpoint, createProject or stopRecording returned for this project. The times are ruler seconds, the same on both sides: past a cut or a speed change made since the checkpoint, the two sides of a moment no longer show the same footage. The pointer is drawn from the track beside the video as it is now, on both sides: what setPointerTrack changed shows through the zooms it added, not through the pointer.",
				].join("\n"),
				inputSchema: z.object({
					projectId: z.string().describe("The project to look at."),
					checkpointId: z.string().describe("The state to compare the project with."),
					atSec: pairShape.atSec,
					count: pairShape.count,
					startSec: pairShape.startSec,
					endSec: pairShape.endSec,
					region: pairShape.region,
				}),
				annotations: READ_ONLY,
			},
			async ({ projectId, checkpointId, region, ...moments }) => {
				const { images } = deps;
				if (!images) return text(NO_IMAGE_WORK, true);
				const problem = frameQueryProblem({ projectId, ...moments });
				if (problem) return text(problem, true);
				const current = await deps.documents.getProject(projectId).catch(() => null);
				if (!current) {
					return text(
						`No project has the id "${projectId}". Call listProjects for the valid ids.`,
						true,
					);
				}
				// Through the runner, which holds the checkpoints: the app's, when it runs.
				const read = await deps.runTool(READ_CHECKPOINT_TOOL, { projectId, checkpointId });
				const readText = read.content[0]?.type === "text" ? read.content[0].text : "";
				if (read.isError) return text(readText, true);
				let before: AxcutDocument;
				try {
					before = documentSchema.parse(JSON.parse(readText));
				} catch {
					return text("The checkpoint could not be read.", true);
				}

				// The same ruler seconds on both sides, each mapped through its own trims and speeds.
				// Times asked are kept as asked; spread ones cover the longer of the two films.
				const rulerEnd = (document: AxcutDocument) =>
					Math.max(0, ...document.timeline.clips.map((clip) => clip.timelineEndSec));
				const times =
					moments.atSec ??
					frameTimes(
						Math.max(rulerEnd(before), rulerEnd(current)),
						null,
						moments.count ?? 4,
						moments,
					);
				const tileWidth = tileWidthFor(2);
				const sides: Array<Array<Shot | null>> = [];
				for (const document of [before, current]) {
					// A side has no frame from its own end on, nor any at all with nothing on its
					// timeline (a checkpoint taken before the first clip): missing there, not an error.
					const end = rulerEnd(document);
					const inRange =
						document.timeline.clips.length === 0 ? [] : times.filter((sec) => sec < end);
					if (inRange.length === 0) {
						sides.push(times.map(() => null));
						continue;
					}
					const rendered = await renderProjectShots(
						document,
						{ atSec: inRange },
						inRange.length,
						region ? FULL_WIDTH : tileWidth,
						"",
					);
					if (!rendered) {
						return text(
							"This OpenScreen cannot render a project's frames without exporting it, so it has no checkpoint to show.",
							true,
						);
					}
					if (!isShots(rendered)) return rendered;
					sides.push(times.map((sec) => (sec < end ? rendered.shots[inRange.indexOf(sec)] : null)));
				}

				try {
					const bitmapOf = (shot: Shot | null) =>
						shot?.jpeg
							? images.decode(
									region ? images.crop(shot.jpeg, region, tileWidth) : shot.jpeg,
									tileWidth,
								)
							: null;
					/** Where a change found in the compared picture sits in the whole frame: through
					 *  the crop actually taken, which stops at the frame's edge. */
					const inFrame = (shot: Shot | null, change: FrameRegion): FrameRegion => {
						if (!region) return change;
						const { width, height } = shot?.size ?? { width: 1, height: 1 };
						const cut = shot?.size
							? regionRect(width, height, region)
							: {
									x: region.x,
									y: region.y,
									width: Math.min(region.width, 1 - region.x),
									height: Math.min(region.height, 1 - region.y),
								};
						return {
							x: (cut.x + change.x * cut.width) / width,
							y: (cut.y + change.y * cut.height) / height,
							width: (change.width * cut.width) / width,
							height: (change.height * cut.height) / height,
						};
					};
					const pairs = times.map((sec, i) => ({
						sec,
						shot: sides[1][i],
						before: bitmapOf(sides[0][i]),
						after: bitmapOf(sides[1][i]),
					}));
					const tiles = pairs.flatMap(({ sec, before, after }) =>
						[before, after].map((bitmap) => ({ bitmap, label: `${sec.toFixed(2)}s` })),
					);
					const tileHeight = Math.max(0, ...tiles.map((tile) => tile.bitmap?.height ?? 0));
					if (tileHeight === 0) {
						return text("No frame to show: the project ends before these times.", true);
					}
					const sheet = composeContactSheet(tiles, 2, tileWidth, tileHeight);
					const report = pairs.map(({ sec, shot, before, after }) => {
						const at = round(sec, 2);
						// A side with no frame at this moment: changed, with nowhere to point at.
						if (!before || !after) {
							const missing = !before && !after ? "both" : !before ? "checkpoint" : "now";
							return { sec: at, changed: missing !== "both", missing };
						}
						// Frames of another size (the output format changed): nowhere to point at either.
						if (before.width !== after.width || before.height !== after.height) {
							return { sec: at, changed: true };
						}
						const change = changedRegion(before, after);
						if (!change) return { sec: at, changed: false };
						const placed = inFrame(shot, change.region);
						return {
							sec: at,
							changed: true,
							changedShare: round(change.share, 4),
							// In fractions of the whole frame, whichever part of it was compared.
							region: {
								x: round(placed.x, 4),
								y: round(placed.y, 4),
								width: round(placed.width, 4),
								height: round(placed.height, 4),
							},
						};
					});
					return {
						content: [
							{
								type: "text",
								text: `${pairs.length} moment(s) of the project, one per row: left, at the checkpoint; right, as it is now. Both rendered as its export would show them. A side marked missing has no frame at that moment: its film ends before it, or had nothing on its timeline.`,
							},
							{ type: "text", text: JSON.stringify({ moments: report }) },
							{
								type: "image",
								data: images.encode(sheet).toString("base64"),
								mimeType: "image/jpeg",
							},
						],
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return text(`The comparison could not be made: ${message}`, true);
				}
			},
		);

		server.registerTool(
			"createProject",
			{
				description: [
					"Create a new project, in the look new projects start with in OpenScreen (the style preset marked for them, else the last edited project's), as the editor's New does. Empty, or from a video file laid out as one clip, as the editor lays out an opened video, with zooms planned from the clicks when the video is an OpenScreen recording with its pointer track; autoZooms says how many.",
					`Returns the projectId to edit and a checkpointId that restores the project as it was created. Fill an empty one with importMedia. ${CREATE_PROJECT_NOTES[transport]}`,
				].join("\n"),
				inputSchema: z.object({
					title: z
						.string()
						.optional()
						.describe(
							"The project's title in OpenScreen. Default: the video's file name, or Untitled Project.",
						),
					videoPath: z
						.string()
						.optional()
						.describe(
							"Absolute path of a video (.mp4, .mov, .m4v, .webm, .mkv, .avi, .wmv) to start from. Omit it for an empty project.",
						),
				}),
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			},
			async (args) => {
				if (!deps.editsAllowed()) {
					return text(
						`No project was created: OpenScreen lets MCP clients create projects only while the user allows it. Ask the user to turn on ${MCP_EDITS_SETTING}.`,
						true,
					);
				}
				projectOperations += 1;
				try {
					const title = args.title?.trim();
					if (args.videoPath === undefined) {
						let projectId: string;
						try {
							projectId = (await deps.documents.createProject(title ?? "")).project.id;
						} catch (error) {
							return text(
								`No project was created: ${error instanceof Error ? error.message : String(error)}`,
								true,
							);
						}
						return text(JSON.stringify({ projectId, checkpointId: await checkpointOf(projectId) }));
					}
					const videoPath = args.videoPath;
					const problem = await mediaPathProblem(videoPath, "video");
					if (problem) return text(problem, true);
					let project: Awaited<ReturnType<typeof createProjectFromVideo>>;
					try {
						project = await createProjectFromVideo(
							deps,
							videoPath,
							title || path.parse(videoPath).name,
							// A video from elsewhere: no webcam recorded beside it here.
							null,
						);
					} catch (error) {
						return text(
							`No project was created: ${error instanceof Error ? error.message : String(error)}`,
							true,
						);
					}
					const projectId = project.document.project.id;
					return text(
						JSON.stringify({
							projectId,
							checkpointId: await checkpointOf(projectId),
							durationSec: project.durationSec,
							autoZooms: project.autoZooms,
						}),
					);
				} finally {
					projectOperations -= 1;
				}
			},
		);
	}

	return {
		preamble: mediaPreamble(transport),
		isBusy: () => take !== null || exporting || projectOperations > 0,
		register,
	};
}

/**
 * Where a ruler second plays in the export: the exporter's own projection, through the trims
 * (holes in the ruler that the export skips) and the speed regions (spans it plays faster).
 */
function programmeSecOf(document: AxcutDocument, rulerSec: number): number {
	return projectRawTimelineSecToPlayback(
		document.timeline.clips,
		document.timeline.trimRanges,
		rulerSec,
		readSpeedRegions(document),
	);
}

/**
 * The ruler second the export plays at `programmeSec`: `programmeSecOf` read backwards, which
 * it allows because it never goes back. A cut makes a stretch of ruler seconds play at the same
 * instant: what `starts` there starts after the cut, at its last second; what ends there ends
 * before it, at its first. Either way the stretch a client reads stays clear of the cut.
 */
function rulerSecOf(document: AxcutDocument, programmeSec: number, starts: boolean): number {
	let before = 0;
	let after = Math.max(0, ...document.timeline.clips.map((clip) => clip.timelineEndSec));
	// Forty halvings of any film come down to well under a frame.
	for (let step = 0; step < 40; step++) {
		const middle = (before + after) / 2;
		const played = programmeSecOf(document, middle);
		if (starts ? played <= programmeSec : played < programmeSec) before = middle;
		else after = middle;
	}
	return starts ? before : after;
}
