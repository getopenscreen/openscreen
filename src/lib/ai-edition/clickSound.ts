// Mouse-click sound.
//
// The recorded click times (`<video>.cursor.json`, the same telemetry the click bounce and the
// auto-zoom read) become short hits. Nothing is baked into a file: the export sums them in the
// compositor (`mix_click_hits`, crates/compositor/src/audio.rs) and the preview plays them off the
// same list, placed by the raw→programme projection the app lays imported audio tracks out with.
// An imported track is moved by a speed region and never stretched, so a bed rendered against one
// edit falls behind every click after it; these hits are computed from the edit instead.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { getAssetPath } from "@/lib/assetPath";
import { nativeBridgeClient } from "@/native/client";
import { projectRawTimelineSecToPlayback, readSpeedRegions } from "./document/timeline";
import type { AxcutAsset, AxcutDocument } from "./schema";
import { audioGainScalar, getEditorSettings } from "./store/editorSettings";
import { resolveClipSourceEndSec } from "./timeline/clipDuration";
import { removedRawSpans } from "./timeline/programme-time";

export const CLICK_SOUND_DOWN_URL = "sounds/click-down.wav";
export const CLICK_SOUND_UP_URL = "sounds/click-up.wav";
/** The names the two samples are staged under, and the only names the main process accepts. */
const HIT_FILES = { down: "click-down.wav", up: "click-up.wav" } as const;

/**
 * The asset label an earlier cut of this feature stamped onto projects: it rendered the whole
 * take into one WAV and added that as a music track. Nothing writes one any more, and switching
 * the sound on clears it — a document holding both would hear every click twice.
 */
export const LEGACY_CLICK_BED_LABEL = "Mouse clicks";

/** A press with no matching release inside this window gets a synthetic one this far later. */
const MAX_RELEASE_GAP_MS = 600;
const FALLBACK_RELEASE_MS = 110;
const DOUBLE_TAP_MS = 90;
/** A playhead move larger than this is a seek, not a frame: no hit is owed across it. Kept well
 *  past one frame at the fastest preview rate (16x is ~0.27 s of raw time per frame), because a
 *  stray click after a small jump is a smaller wrong than a click that never sounds. */
const SEEK_JUMP_SEC = 0.5;

export interface ClickCue {
	/** Seconds from the start of the recording — source time, the clock the sidecar is written on,
	 *  not the edited timeline's. */
	timeSec: number;
	gain: number;
	release: boolean;
}

/** One hit of the scene's `clickSound` block: programme seconds, the compositor's own clock. */
export interface ClickHit {
	timeSec: number;
	gain: number;
	release: boolean;
}

export interface ClickSoundScene {
	downPath: string;
	upPath: string;
	hits: ClickHit[];
}

/**
 * Press/release hits for one take. Releases come from the recorded `mouseup` samples so a held
 * drag gets its let-go sound where the finger actually lifted; right and middle clicks sit a
 * little quieter than the left. The bundled samples are already level-matched and stripped of
 * leading silence, so a cue's own gain is the only volume decision left to make.
 */
export function buildClickCues(points: CursorTelemetryPoint[]): ClickCue[] {
	const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs);
	const releases = sorted
		.filter((p) => p.interactionType === "mouseup")
		.map((p) => p.timeMs)
		.sort((a, b) => a - b);

	const cues: ClickCue[] = [];
	const push = (ms: number, gain: number, release: boolean) => {
		// The sidecar is disk data. A NaN would serialize as `null` into the scene and cost the
		// whole export its parse, so a time that is not a number is not a click.
		if (!Number.isFinite(ms) || ms < 0) return;
		cues.push({ timeSec: ms / 1000, gain, release });
	};

	for (const point of sorted) {
		switch (point.interactionType) {
			case "click":
			case "double-click":
			case "right-click":
			case "middle-click":
				break;
			default:
				continue;
		}
		const isSide =
			point.interactionType === "right-click" || point.interactionType === "middle-click";
		const gain = isSide ? 0.85 : 1;
		push(point.timeMs, gain, false);
		if (point.interactionType === "double-click") push(point.timeMs + DOUBLE_TAP_MS, gain, false);
		// ponytail: a press held past MAX_RELEASE_GAP_MS gets its release early instead of never
		const release = releases.find(
			(ms) => ms > point.timeMs && ms <= point.timeMs + MAX_RELEASE_GAP_MS,
		);
		push(release ?? point.timeMs + FALLBACK_RELEASE_MS, gain * 0.7, true);
	}
	return cues.sort((a, b) => a.timeSec - b.timeSec);
}

/** Resolved URLs of the two bundled hits, for the renderer and for staging. */
export function clickHitUrls(): { down: string; up: string } {
	const one = (relative: string) => {
		try {
			return getAssetPath(relative);
		} catch {
			return `/${relative}`;
		}
	};
	return { down: one(CLICK_SOUND_DOWN_URL), up: one(CLICK_SOUND_UP_URL) };
}

// Both caches are one-shot: a finished take's sidecar never changes, and the staged samples are
// the same bytes in every project.
const cueCache = new Map<string, ClickCue[]>();
let hitPaths: { down: string; up: string } | null = null;

/**
 * The take's cues, read from disk once per run. A take whose sidecar cannot be read is cached as
 * holding no clicks: that is the answer the UI gives anyway, and re-asking on every scene build
 * would be a read storm against a file that is simply not there.
 */
export async function loadClickCues(takePath: string): Promise<ClickCue[]> {
	const cached = cueCache.get(takePath);
	if (cached) return cached;
	let cues: ClickCue[] = [];
	try {
		cues = buildClickCues(await nativeBridgeClient.cursor.getTelemetry(takePath));
	} catch (error) {
		console.error("Failed to read the click telemetry of", takePath, error);
	}
	cueCache.set(takePath, cues);
	// A preview that asked for this take gets fed now rather than on the next edit.
	if (previewTake === takePath) previewCues = levelClickCues(cues, previewGainDb);
	return cues;
}

/**
 * The bundled hits as files the compositor can open. The renderer knows them as a URL and the
 * package layout they ship in is nobody else's business, so the bytes go to the main process once
 * and it writes them under userData. `null` outside Electron (the browser shim keeps the URLs,
 * which is all the preview needs).
 */
export async function ensureClickHitPaths(): Promise<{ down: string; up: string } | null> {
	if (hitPaths) return hitPaths;
	const stage = window.electronAPI?.stageClickSoundHit;
	if (!stage) return null;
	const urls = clickHitUrls();
	const staged: string[] = [];
	for (const [key, name] of [
		["down", HIT_FILES.down],
		["up", HIT_FILES.up],
	] as const) {
		const response = await fetch(urls[key]);
		if (!response.ok) return null;
		const saved = await stage(name, await response.arrayBuffer());
		if (!saved?.success || !saved.path) return null;
		staged.push(saved.path);
	}
	hitPaths = { down: staged[0], up: staged[1] };
	return hitPaths;
}

/** The document's primary take — the one whose sidecar the clicks were recorded in. */
export function clickTakeOf(document: AxcutDocument | null | undefined) {
	return (
		document?.assets.find((asset) => asset.id === document.project?.primaryAssetId) ??
		document?.assets.find((asset) => asset.kind === "video") ??
		document?.assets[0]
	);
}

/**
 * The cues as the user asked to hear them. One place, because the preview plays these gains and
 * the export sums the hits built from them — a level applied to only one of the two would make
 * the preview lie about the file. `audioGainScalar` is the same dB law the output gain and the
 * compositor's `finish_audio` use.
 */
export function levelClickCues(cues: ClickCue[], gainDb: number): ClickCue[] {
	const scalar = audioGainScalar(gainDb);
	return scalar === 1 ? cues : cues.map((cue) => ({ ...cue, gain: cue.gain * scalar }));
}

/**
 * The scene's `clickSound` block for this document, or null when there is nothing to play.
 *
 * Synchronous by design: `buildSceneDescription` runs on paths that cannot await, so the answers
 * come from the caches above and a take that has not been read is read in the background here.
 * That is why an absent block means "off" as often as "not read yet" — the exporter awaits
 * `prepareClickSound` first and never relies on the guess.
 */
export function clickSoundForDocument(
	document: AxcutDocument,
	cursor: { clickSound: boolean; clickSoundGainDb: number },
): ClickSoundScene | null {
	const take = cursor.clickSound ? clickTakeOf(document) : undefined;
	const takePath = take?.originalPath;
	// The level rides along, so a cue read that lands after this (the background one below) is
	// still stashed at the level the user set, not at unity.
	previewGainDb = cursor.clickSoundGainDb;
	const cues = levelClickCues((takePath && cueCache.get(takePath)) || [], cursor.clickSoundGainDb);
	previewTake = takePath;
	previewCues = cues;
	if (!takePath) return null;
	// A take never read before is read now, in the background: the scene build cannot await.
	// `loadClickCues` feeds the preview when it lands; an export awaits `prepareClickSound`.
	if (!cueCache.has(takePath)) void loadClickCues(takePath);
	if (!hitPaths || cues.length === 0) return null;
	return {
		downPath: hitPaths.down,
		upPath: hitPaths.up,
		hits: placeClickHits(document, take, cues),
	};
}

/**
 * The take's clicks, on the PROGRAMME seconds the compositor mixes onto. Three clocks are in
 * play, so there are three steps: a click is recorded in the take's own source seconds, the
 * timeline plays a clip's source window at that clip's position (a take trimmed at the head, or
 * repeated across clips, is not at ruler zero), and only then do trims and speed regions move
 * what is left. A click no clip shows — cut out, or past the last frame — gets no hit, because
 * nothing plays there; that is also what keeps a cut from clamping the click onto the seam.
 */
export function placeClickHits(
	document: AxcutDocument,
	take: AxcutAsset,
	cues: ClickCue[],
): ClickHit[] {
	const clips = document.timeline.clips;
	const trims = document.timeline.trimRanges;
	const speeds = readSpeedRegions(document);
	const removed = removedRawSpans(clips, trims);
	const windows = clips
		.filter((clip) => clip.assetId === take.id)
		.map((clip) => ({
			from: clip.sourceStartSec,
			to: resolveClipSourceEndSec(clip, take),
			at: clip.timelineStartSec,
		}));
	const hits: ClickHit[] = [];
	for (const cue of cues) {
		for (const window of windows) {
			if (cue.timeSec < window.from || cue.timeSec >= window.to) continue;
			const rawSec = window.at + (cue.timeSec - window.from);
			if (removed.some((span) => rawSec >= span.startSec && rawSec < span.endSec)) continue;
			hits.push({
				timeSec: projectRawTimelineSecToPlayback(clips, trims, rawSec, speeds),
				gain: cue.gain,
				release: cue.release,
			});
		}
	}
	return hits.sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Loads what the sound needs for `document`: its cues, and the samples staged for the export.
 * Call this where a result must not depend on a background read having finished — switching the
 * sound on, and exporting with it on. Does nothing while the setting is off, so a caller that
 * always asks cannot hand the preview clicks the user never asked to hear.
 */
export async function prepareClickSound(document: AxcutDocument): Promise<void> {
	const cursor = getEditorSettings(document).cursor;
	if (!cursor.clickSound) return;
	const take = clickTakeOf(document)?.originalPath;
	if (!take) return;
	const cues = await loadClickCues(take);
	previewTake = take;
	previewGainDb = cursor.clickSoundGainDb;
	previewCues = levelClickCues(cues, cursor.clickSoundGainDb);
	await ensureClickHitPaths();
}

// What the preview plays. Building the scene is the one place that has the document, the setting
// and the cues together, so it stashes them here and the rAF tick drains them by crossings.
let previewCues: ClickCue[] = [];
let previewTake: string | undefined;
let previewGainDb = 0;
let lastSourceSec = Number.NaN;

/** The hits the playhead passed since the last call, measured in the take's own source seconds —
 *  where a click was recorded, and where the preview's picture is: under a 2x region that clock
 *  races with the picture, so a hit fired on a crossing lands on the click being shown.
 *
 *  `mountedTakePath` is the take on screen now. The cues belong to one take, so playing them over
 *  another take's picture would put a click where no click happened. */
export function takeCrossedClickHits(
	sourceSec: number,
	mountedTakePath?: string | null,
): ClickCue[] {
	const fit = clickCuesFitTake(previewTake, mountedTakePath);
	const crossed = fit ? crossedClickHits(previewCues, lastSourceSec, sourceSec) : [];
	// The anchor moves either way: coming back to the right take must not repay a stack of clicks.
	lastSourceSec = sourceSec;
	return crossed;
}

/**
 * Whether cues recorded against `cueTake` may sound while `mountedTake` is on screen. Only a known
 * mismatch suppresses them — a preview that has no path resolved yet (a source still being built,
 * or one loaded from a URL rather than a file) must not fall silent because of this check.
 */
export function clickCuesFitTake(
	cueTake: string | undefined,
	mountedTake?: string | null,
): boolean {
	return !cueTake || !mountedTake || mountedTake === cueTake;
}

/**
 * The clicks whose recorded time lies between two readings of the playhead, both in the take's own
 * source seconds. A move too big for one frame is a seek (or a clip swap) and nothing is owed
 * across it; a move backwards is a rewind, and since nothing is consumed the same clicks are
 * crossed again.
 */
export function crossedClickHits(
	cues: ClickCue[],
	fromSourceSec: number,
	toSourceSec: number,
): ClickCue[] {
	if (
		!(fromSourceSec >= 0) ||
		toSourceSec <= fromSourceSec ||
		toSourceSec - fromSourceSec > SEEK_JUMP_SEC
	) {
		return [];
	}
	return cues.filter((cue) => cue.timeSec > fromSourceSec && cue.timeSec <= toSourceSec);
}

/** The preview calls this while stopped: the next run starts wherever the user left the playhead,
 *  and an anchor from the previous run would fire a stack of clicks that already went by. */
export function resetClickPlayhead(): void {
	lastSourceSec = Number.NaN;
}

const hitBuffers = new WeakMap<AudioContext, Promise<AudioBuffer[]>>();

/** The two samples as `[press, release]`, decoded once per context. */
export function clickHitBuffers(context: AudioContext): Promise<AudioBuffer[]> {
	let pending = hitBuffers.get(context);
	if (!pending) {
		const urls = clickHitUrls();
		pending = Promise.all([decodeHit(context, urls.down), decodeHit(context, urls.up)]);
		hitBuffers.set(context, pending);
	}
	return pending;
}

async function decodeHit(context: AudioContext, url: string): Promise<AudioBuffer> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch ${url}`);
	return context.decodeAudioData(await response.arrayBuffer());
}

/** The hits, heard. `buffers` resolves on its own so a tick never waits on a decode, and a
 *  sample that will not load stays silent rather than throwing on every frame. */
export function playClickHits(
	context: AudioContext,
	destination: AudioNode,
	buffers: Promise<AudioBuffer[]>,
	cues: ClickCue[],
): void {
	void buffers
		.then(([down, up]) => {
			if (context.state === "closed") return;
			for (const cue of cues) {
				const buffer = cue.release ? up : down;
				if (!buffer) continue;
				const source = context.createBufferSource();
				source.buffer = buffer;
				const gain = context.createGain();
				gain.gain.value = cue.gain;
				source.connect(gain).connect(destination);
				source.start();
			}
		})
		.catch(() => undefined);
}
