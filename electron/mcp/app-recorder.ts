// The in-app server's recorder: a take made the way the app makes every take. Not a
// recorder of its own beside the app's: startRecording points the recording bar at
// what the client asked for and hands over to it, as the editor's Record button does,
// and stopRecording presses the bar's Stop, as the tray does. The bar then saves the
// take and the editor opens it as a new project, laid out and zoomed as any take is,
// and that project is what the client edits: through the editor, live.
//
// No `electron` import: the app's side is handed in (handlers.ts), so this runs under
// plain vitest with stand-ins.

import path from "node:path";
import { clipAwaitsProbedDuration } from "../../src/lib/ai-edition/document/timeline";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import type { CliSourcesResult } from "../../src/lib/cliContracts";
import type { RecordingPreferences } from "../app-settings";
import type { RecordedTake, RecordRequest, RunningTake, TakeRecorder } from "./media-tools";
import type { McpDocumentHost } from "./openscreen-mcp-server";

/** The recording bar's settings a client's take sets, and puts back once it is captured. */
export const TAKE_PREF_KEYS = [
	"micEnabled",
	"micDeviceId",
	"micDeviceName",
	"camEnabled",
	"camDeviceId",
	"camDeviceName",
	"systemAudioEnabled",
	"cursorCaptureMode",
	// A client asks for a screen, window or display take: a camera only left on in the bar
	// would record the camera instead. Put back with the rest once the take is captured.
	"cameraOnly",
] as const;
export type TakePrefs = Pick<RecordingPreferences, (typeof TAKE_PREF_KEYS)[number]>;

/** The take settings among `prefs`: what puts the user's own back. */
export function pickTakePrefs(prefs: TakePrefs): TakePrefs {
	return Object.fromEntries(TAKE_PREF_KEYS.map((key) => [key, prefs[key]])) as TakePrefs;
}

/**
 * The recording bar's settings for a client's take. A device asked for by name is looked up
 * in `listed` (listSources' list), its id beside its name as the bar records with both; none
 * asked for leaves the choice to the system, as the bar does with no device picked. Throws
 * when no listed device has the name.
 */
export function takePrefs(request: RecordRequest, listed: CliSourcesResult | null): TakePrefs {
	const find = (
		kind: "microphone" | "camera",
		devices: { label: string; deviceId?: string }[] | undefined,
		name: string | null,
	) => {
		if (!name) return { id: null, name: null };
		const needle = name.toLowerCase();
		const match = devices?.find((device) => device.label.toLowerCase().includes(needle));
		if (!match) {
			throw new Error(`No ${kind}'s name contains "${name}". Call listSources for their names.`);
		}
		return { id: match.deviceId ?? null, name: match.label };
	};
	const mic = find("microphone", listed?.microphones, request.mic ? request.micDevice : null);
	const cam = find("camera", listed?.cameras, request.camera ? request.cameraDevice : null);
	return {
		micEnabled: request.mic,
		micDeviceId: mic.id,
		micDeviceName: mic.name,
		camEnabled: request.camera,
		camDeviceId: cam.id,
		camDeviceName: cam.name,
		systemAudioEnabled: request.systemAudio,
		cursorCaptureMode: request.cursorMode,
		cameraOnly: false,
	};
}

// ponytail: fixed deadlines. A take only starts once the countdown, and the system's
// picker where it asks, are through; a long take takes a while to save.
const TIMING = {
	startMs: 120_000,
	saveMs: 120_000,
	openMs: 60_000,
	pollMs: 250,
	// The editor lays a take out in several saves (the clip, its measured length, the
	// zooms on its clicks): it is ready once its revision has held this long.
	// ponytail: a quiet period, not a signal; ask the editor to say "done" if it races.
	settleMs: 1_500,
};

export interface AppRecorderDeps {
	/** The app is recording or saving a take, the user's or a client's. */
	isRecording(): boolean;
	/** The editor holds changes it has not saved: closing it for the take would lose them. */
	editorHasUnsavedChanges(): boolean;
	/**
	 * Points the recording bar at the request, as Record mode does before it hands over:
	 * its source, microphone, camera, system audio and cursor. Returns what puts back the settings
	 * the user had. Throws when the request matches no source or microphone.
	 */
	prepare(request: RecordRequest): Promise<() => void>;
	/** The editor's Record button: hand over to the recording bar, which starts the take. */
	startTake(): void;
	/** The recording bar's Stop, as the tray's Stop Recording. */
	stopTake(): void;
	/** The editor, where a saved take opens as a new project. */
	host: Pick<McpDocumentHost, "snapshot" | "apply">;
	timing?: Partial<typeof TIMING>;
}

export interface AppRecorder extends TakeRecorder {
	/** The app's recording state changed (`set-recording-state`). */
	recordingChanged(recording: boolean): void;
	/** The recording bar handed a saved take to the editor (`set-current-recording-session`). */
	takeSaved(videoPath: string): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** `promise`, or `null` once `ms` have passed without it. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms: number) => Math.round(ms / 1000);

/** The take's asset, once the editor has measured it: until then its clip is a placeholder. */
function takeAsset(document: AxcutDocument, videoPath: string) {
	const asset = document.assets.find(
		(candidate) =>
			!!candidate.originalPath && path.resolve(candidate.originalPath) === path.resolve(videoPath),
	);
	if (!asset?.durationSec) return null;
	if (document.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id))) return null;
	return asset;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

interface ClientTake {
	phase: "starting" | "recording" | "saving";
	/** Resolves with when capture started. */
	started: Deferred<number>;
	/** Resolves with the saved take's video. */
	saved: Deferred<string>;
	restore(): void;
}

export function createAppRecorder(deps: AppRecorderDeps): AppRecorder {
	const timing = { ...TIMING, ...deps.timing };
	/** The client's take, from the moment it is asked for until stopRecording has it. */
	let current: ClientTake | null = null;

	/** The editor's project for the take, once laid out. */
	async function openedInEditor(videoPath: string) {
		const deadline = Date.now() + timing.openMs;
		let seen = null as { projectId: string; revision: number; since: number } | null;
		while (Date.now() < deadline) {
			const snapshot = await deps.host.snapshot();
			const parsed = snapshot ? documentSchema.safeParse(snapshot.document) : null;
			const document = parsed?.success ? parsed.data : null;
			const asset = document ? takeAsset(document, videoPath) : null;
			if (snapshot && document && asset) {
				const { revision } = snapshot;
				if (seen?.projectId !== document.project.id || seen.revision !== revision) {
					seen = { projectId: document.project.id, revision, since: Date.now() };
				} else if (Date.now() - seen.since >= timing.settleMs) {
					return { document, revision, asset };
				}
			} else {
				seen = null;
			}
			await sleep(timing.pollMs);
		}
		throw new Error(
			`The take was saved to ${videoPath}, but the OpenScreen editor did not open it within ${seconds(timing.openMs)} s.`,
		);
	}

	async function stop(take: ClientTake, title: string | undefined) {
		try {
			if (take.phase === "recording") deps.stopTake();
			const videoPath = await within(take.saved.promise, timing.saveMs);
			if (videoPath === null) {
				throw new Error(
					`The recording failed: OpenScreen did not hand the take to its editor within ${seconds(timing.saveMs)} s. The recording bar says why.`,
				);
			}
			const opened = await openedInEditor(videoPath);
			const { asset, revision } = opened;
			let { document } = opened;
			if (title && title !== document.project.title) {
				const renamed = { ...document, project: { ...document.project, title } };
				// A user edit that lands first keeps the editor's title: nothing else depends on it.
				if ((await deps.host.apply(renamed, revision)) === "applied") document = renamed;
			}
			return {
				projectId: document.project.id,
				videoPath: asset.originalPath,
				durationSec: asset.durationSec ?? 0,
				autoZooms: document.zoomRanges?.length ?? 0,
			} satisfies RecordedTake;
		} finally {
			take.restore();
			if (current === take) current = null;
		}
	}

	return {
		recordingChanged(recording) {
			if (!current) return;
			if (recording && current.phase === "starting") {
				current.phase = "recording";
				current.started.resolve(Date.now());
			} else if (!recording && current.phase === "recording") {
				// The take is captured: the bar's own settings can come back while it saves.
				current.phase = "saving";
				current.restore();
			}
		},
		takeSaved(videoPath) {
			if (current?.phase === "saving") current.saved.resolve(videoPath);
		},
		async start(request): Promise<RunningTake> {
			if (current || deps.isRecording()) throw new Error("OpenScreen is already recording a take.");
			if (deps.editorHasUnsavedChanges()) {
				throw new Error(
					"the OpenScreen editor has changes it has not saved yet, and the take closes it. Ask the user to save them, then try again.",
				);
			}
			const restoreSettings = await deps.prepare(request);
			let restored = false;
			const take: ClientTake = {
				phase: "starting",
				started: deferred<number>(),
				saved: deferred<string>(),
				restore() {
					if (restored) return;
					restored = true;
					restoreSettings();
				},
			};
			current = take;
			deps.startTake();
			const startedAt = await within(take.started.promise, timing.startMs);
			if (startedAt === null) {
				// A take that starts after this is the user's: nothing here waits for it.
				current = null;
				take.restore();
				throw new Error(
					`capture had not started after ${seconds(timing.startMs)} s. OpenScreen's recording bar says why.`,
				);
			}
			return { startedAt, stop: (title) => stop(take, title) };
		},
	};
}
