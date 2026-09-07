// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount. The slot has to be emptied once that project owns
// the file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { createId } from "@/lib/ai-edition/document/ids";
import { clipAwaitsProbedDuration } from "@/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
	saveWithDeadline,
	useProjectStore,
	waitForDocumentSaves,
} from "@/lib/ai-edition/store/projectStore";
import {
	appendAutoZoomSuggestions,
	clipExtentSignature,
	collectAutoZoomSuggestionsForDocument,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import { nativeBridgeClient } from "@/native/client";

// Fresh recordings used to get cursor-dwell zooms on load (legacy editor
// `autoZoomEnabled`, default on). The ai-edition import only seeded a clip, so
// the wand still worked but a new take landed un-zoomed. This flag is the
// one-shot hand-off: set as soon as the asset is on the document, then taken
// only after a real apply attempt (clips exist, duration is probed, and
// telemetry was readable, or the toggle is off). Keeping it across an
// empty-clip / empty-sidecar / placeholder-duration pass is what lets metadata
// win the race against the helper flush. The path stops a leftover flag from
// decorating a later, unrelated project in the same window. A successful save
// records the project id so a later undo or delete cannot be silently re-seeded.
let pendingFreshRecordingAutoZoom = false;
let pendingFreshRecordingAutoZoomPath: string | null = null;
let appliedFreshRecordingAutoZoomProjectId: string | null = null;
let pendingFreshRecordingAutoZoomTimers: ReturnType<typeof setTimeout>[] = [];
let freshRecordingAutoZoomSaveChain: Promise<void> = Promise.resolve();

const FRESH_RECORDING_AUTO_ZOOM_RETRY_MS = [500, 1500, 3000];

function clearFreshRecordingAutoZoomTimers(): void {
	for (const timer of pendingFreshRecordingAutoZoomTimers) {
		clearTimeout(timer);
	}
	pendingFreshRecordingAutoZoomTimers = [];
}

function scheduleFreshRecordingAutoZoomRetries(): void {
	clearFreshRecordingAutoZoomTimers();
	for (const delayMs of FRESH_RECORDING_AUTO_ZOOM_RETRY_MS) {
		pendingFreshRecordingAutoZoomTimers.push(
			setTimeout(() => {
				if (!pendingFreshRecordingAutoZoom) return;
				const document = useProjectStore.getState().document;
				if (document) {
					void maybeSaveFreshRecordingAutoZooms(document);
				}
			}, delayMs),
		);
	}
}

export function markFreshRecordingAutoZoomPending(assetPath?: string): void {
	pendingFreshRecordingAutoZoom = true;
	pendingFreshRecordingAutoZoomPath = assetPath ?? null;
	appliedFreshRecordingAutoZoomProjectId = null;
	scheduleFreshRecordingAutoZoomRetries();
}

function clearFreshRecordingAutoZoomPending(): void {
	pendingFreshRecordingAutoZoom = false;
	pendingFreshRecordingAutoZoomPath = null;
	clearFreshRecordingAutoZoomTimers();
}

export function consumeFreshRecordingAutoZoomPending(): boolean {
	const was = pendingFreshRecordingAutoZoom;
	clearFreshRecordingAutoZoomPending();
	appliedFreshRecordingAutoZoomProjectId = null;
	freshRecordingAutoZoomSaveChain = Promise.resolve();
	return was;
}

export type ApplyFreshRecordingAutoZoomsDeps = {
	enabled?: boolean;
	getTelemetry?: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>;
	createId?: (prefix: string) => string;
	/** Deadline for this path's own write. Tests use a short one. */
	saveTimeoutMs?: number;
	/** Deadline for waiting on writes somebody else started. Tests shorten it. */
	waitTimeoutMs?: number;
};

async function readAutoZoomPref(): Promise<boolean> {
	try {
		const prefs = await window.electronAPI?.getRecordingPrefs?.();
		return prefs?.autoZoomEnabled !== false;
	} catch {
		return true;
	}
}

function pendingFreshRecordingAsset(document: AxcutDocument) {
	if (pendingFreshRecordingAutoZoomPath) {
		return document.assets.find(
			(asset) => asset.originalPath === pendingFreshRecordingAutoZoomPath,
		);
	}
	const primaryId = document.project.primaryAssetId;
	return document.assets.find((asset) => asset.id === primaryId) ?? document.assets[0];
}

/**
 * Whether the pending take's real length has landed yet.
 *
 * Not just `asset.durationSec != null`. A recording whose container reports no
 * duration (MediaRecorder WebM, until the EBML fix) still gets the placeholder
 * written to that field, because the timeline layer clamps every interval it
 * builds against `primaryAssetDuration` and would otherwise drop every clip. So
 * the asset says "60" for a take nothing has measured, and the clips are what
 * distinguish the two: one still sitting at the placeholder length is waiting.
 *
 * The cost is a take of exactly 60.000 s never being auto-zoomed. That is the
 * same ambiguity `applyProbedDuration` already lives with, and it is a far
 * smaller price than suggesting zooms against a length nothing measured.
 */
function hasProbedDurationForPendingAsset(document: AxcutDocument): boolean {
	const asset = pendingFreshRecordingAsset(document);
	if (
		asset == null ||
		asset.durationSec == null ||
		!Number.isFinite(asset.durationSec) ||
		asset.durationSec <= 0
	) {
		return false;
	}
	return !document.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id));
}

function canApplyFreshRecordingAutoZooms(document: AxcutDocument): boolean {
	if (!pendingFreshRecordingAutoZoom) return false;
	if (appliedFreshRecordingAutoZoomProjectId === document.project.id) return false;
	if ((document.zoomRanges?.length ?? 0) > 0) return false;
	if ((document.timeline?.clips?.length ?? 0) === 0) return false;
	if (!hasProbedDurationForPendingAsset(document)) return false;
	if (
		pendingFreshRecordingAutoZoomPath &&
		!document.assets.some((asset) => asset.originalPath === pendingFreshRecordingAutoZoomPath)
	) {
		return false;
	}
	return true;
}

function liveDocument(fallback: AxcutDocument): AxcutDocument {
	return useProjectStore.getState().document ?? fallback;
}

export async function applyPendingFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<AxcutDocument> {
	if (!pendingFreshRecordingAutoZoom) return document;
	if (appliedFreshRecordingAutoZoomProjectId === document.project.id) {
		clearFreshRecordingAutoZoomPending();
		return document;
	}
	const enabled = deps.enabled ?? (await readAutoZoomPref());
	if (!enabled) {
		clearFreshRecordingAutoZoomPending();
		return liveDocument(document);
	}
	const start = liveDocument(document);
	if ((start.zoomRanges?.length ?? 0) > 0) {
		clearFreshRecordingAutoZoomPending();
		appliedFreshRecordingAutoZoomProjectId = start.project.id;
		return start;
	}
	if (!canApplyFreshRecordingAutoZooms(start)) {
		return start;
	}
	const inner =
		deps.getTelemetry ?? ((videoPath: string) => nativeBridgeClient.cursor.getTelemetry(videoPath));
	const getTelemetry = async (videoPath: string) => {
		try {
			return await inner(videoPath);
		} catch {
			// Sidecar may not be readable yet. Keep pending for the delayed retries.
			return [];
		}
	};
	const collectFrom = async (source: AxcutDocument) => {
		const scoped = pendingFreshRecordingAutoZoomPath
			? {
					...source,
					assets: source.assets.filter(
						(asset) => asset.originalPath === pendingFreshRecordingAutoZoomPath,
					),
				}
			: source;
		return collectAutoZoomSuggestionsForDocument(scoped, getTelemetry);
	};

	const firstSignature = clipExtentSignature(start);
	let suggestions = await collectFrom(start);
	let latest = liveDocument(start);
	if (latest.project.id !== start.project.id) {
		return latest;
	}
	if ((latest.zoomRanges?.length ?? 0) > 0) {
		clearFreshRecordingAutoZoomPending();
		appliedFreshRecordingAutoZoomProjectId = latest.project.id;
		return latest;
	}
	if (!canApplyFreshRecordingAutoZooms(latest)) {
		return latest;
	}
	if (clipExtentSignature(latest) !== firstSignature) {
		suggestions = await collectFrom(latest);
		latest = liveDocument(latest);
		if (latest.project.id !== start.project.id) return latest;
		if ((latest.zoomRanges?.length ?? 0) > 0) {
			clearFreshRecordingAutoZoomPending();
			appliedFreshRecordingAutoZoomProjectId = latest.project.id;
			return latest;
		}
		if (!canApplyFreshRecordingAutoZooms(latest)) return latest;
	}
	if (suggestions.length === 0) {
		// Do not consume: a mid-flush sidecar can have samples but no dwell yet
		// (the qualifying sit is often the last second of the take).
		return latest;
	}
	return appendAutoZoomSuggestions(latest, suggestions, deps.createId ?? createId);
}

export async function maybeSaveFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<boolean> {
	const writeFreshRecordingAutoZooms = async (): Promise<boolean> => {
		try {
			// A wait that times out has told us nothing about what is on disk, so the
			// only safe move is to abandon this attempt with pending still set: the
			// retries below rebase onto whatever the stuck save eventually leaves.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const latest = liveDocument(document);
			const next = await applyPendingFreshRecordingAutoZooms(latest, deps);
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const current = liveDocument(document);
			if (current.project.id !== latest.project.id) return false;
			if ((current.zoomRanges?.length ?? 0) > 0) {
				appliedFreshRecordingAutoZoomProjectId = current.project.id;
				clearFreshRecordingAutoZoomPending();
				return false;
			}
			// Contention means exit, not rebase. If the document moved while the
			// suggestion pass ran, this attempt is working from a snapshot that is
			// already history — recomputing onto the newer one just races the writer
			// that produced it. Drop the attempt with pending still set; the
			// 500/1500/3000 ms retries run against a settled document instead.
			if (current !== latest) return false;
			const toSave = next;
			const storedNow = liveDocument(document);
			if (storedNow !== latest) return false;
			if (toSave === latest || toSave === storedNow) return false;
			if (storedNow.project.id !== latest.project.id) return false;
			const saved = await saveWithDeadline(
				useProjectStore.getState().saveDocument(toSave, { history: true }),
				deps.saveTimeoutMs ?? DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
			);
			// The write never answered. Keep pending and let go of the chain, so the
			// retries get to run instead of queueing behind a promise that is not
			// coming back.
			if (saved === "timeout") return false;
			// A trim (or any other edit) can start after this save was submitted and
			// still be in flight when it returns: `waitForDocumentSaves` before the
			// write only sees saves that have already begun. Wait again, then look at
			// the store — if that later write landed on the unzoomed snapshot, keep
			// pending so a retry can try again. A timeout here says the same thing for
			// a different reason: we cannot tell what landed, so do not clear pending.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return saved;
			const stored = useProjectStore.getState().document;
			if (saved && stored && (stored.zoomRanges?.length ?? 0) > 0) {
				appliedFreshRecordingAutoZoomProjectId = stored.project.id;
				clearFreshRecordingAutoZoomPending();
			}
			return saved;
		} catch (error) {
			// `saveDocument` reports failure by returning false, so anything thrown
			// here came from the suggestion pass or a bridge call. Pending stays set
			// and the retries fire silently — log it, or the whole path is invisible.
			console.warn("[recording] fresh-recording auto-zoom write failed:", error);
			return false;
		}
	};
	const done = freshRecordingAutoZoomSaveChain.then(
		writeFreshRecordingAutoZooms,
		writeFreshRecordingAutoZooms,
	);
	freshRecordingAutoZoomSaveChain = done.then(
		() => undefined,
		() => undefined,
	);
	return done;
}

/**
 * Imports the recording the HUD handed over into a new project, and consumes the
 * hand-off so it is imported exactly once.
 *
 * Returns false when there is nothing pending — the caller then falls back to
 * reopening the most recent project. Throws if the import itself fails, leaving
 * the session in place so a later mount can retry it.
 */
export async function importPendingRecording(): Promise<boolean> {
	const api = window.electronAPI;
	if (!api) return false;

	const result = await api.getCurrentRecordingSession();
	const screenPath = result.success ? result.session?.screenVideoPath : undefined;
	if (!screenPath) return false;
	const cursorCaptureMode = result.success ? result.session?.cursorCaptureMode : undefined;

	const label = screenPath.split(/[\\/]/).pop() || "Recording";
	await useProjectStore.getState().createProject(`Recording ${new Date().toLocaleString()}`);
	await useProjectStore.getState().addAsset(screenPath, label);
	// Mark before the video element can fire `loadedmetadata`. The asset path is
	// already on the document; waiting until the 60s seed finished let the first
	// metadata pass consume nothing and the second never arrive.
	//
	// Except for a system-cursor take, which writes no `.cursor.json` at all: the
	// toggle stays on in prefs (it is only disabled in the UI while that mode is
	// picked), so without this the flag was set for a recording that can never
	// produce a dwell, and all three retries ran against an empty sidecar. What
	// governs is the mode THIS take was recorded in, not the current preference.
	if (cursorCaptureMode !== "system") {
		markFreshRecordingAutoZoomPending(screenPath);
	}
	// Consumed: the recording now lives in a project. Cleared here rather than
	// after the timeline seed below so a failure down there can't hand the same
	// recording to the next editor window.
	await api.setCurrentRecordingSession(null);

	// ponytail: MediaRecorder WebMs ship with duration = NaN until
	// fix-webm-duration patches the EBML header; until that flows through the
	// asset, drop a default 60s clip into the timeline so the editor isn't stuck
	// on "No clips yet" the moment the user lands in the project. Real duration
	// overwrites this when handleLoadedMetadata fires with a finite value.
	const doc = useProjectStore.getState().document;
	if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
		// `history: false`. Nothing here is an edit: the user finished a recording and the
		// editor built them a project around it, unattended, on mount. Recording it left a
		// brand-new project sitting at `past.length === 1` before the user had touched
		// anything, so their FIRST Ctrl+Z restored the state before the seed -- an empty
		// timeline -- and the persist that follows an undo wrote that empty timeline to disk.
		await useProjectStore
			.getState()
			.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording", {
				history: false,
			});
	}
	const latest = useProjectStore.getState().document;
	if (latest) {
		await maybeSaveFreshRecordingAutoZooms(latest);
	}
	return true;
}
