/**
 * React hook that drives a canvas-based preview of the native D3D11
 * compositor. The compositor renders OFFSCREEN (no OS window), so this hook:
 *   1. Allocates an offscreen compositor view sized to the canvas's device-pixel
 *      rect (measured via ResizeObserver + window resize/scroll, rAF-coalesced
 *      — the exact same sync machinery as before, repurposed: it now drives
 *      the offscreen render-target resolution instead of a window position).
 *   2. Polls `readCompositorFrame` on rAF ticks, passing the generation it last
 *      painted. Native answers ONLY when a newer frame exists — otherwise `null`, and
 *      the canvas is left untouched, so while the preview sits still (paused editing)
 *      nothing is cloned, sent over IPC, or repainted. A new frame comes one of two ways:
 *        - as a shared GPU texture (Windows), sent to `subscribeCompositorSharedFrames`
 *          ahead of the reply, which then only names its generation. Nothing is copied
 *          through RAM, so while frames keep coming it is pulled every 8 ms;
 *        - as RGBA pixels (`{ gen, width, height, data }`) everywhere else, pulled ~30
 *          times a second to bound the copies.
 *      Either way the canvas drawing buffer is sized from the frame's own dims, so pixels
 *      and canvas can never drift apart.
 *
 * Every native-bridge call is wrapped in a try/catch that swallows + warns,
 * because the renderer may run without the bridge (pure web `npm run dev`,
 * Vitest jsdom env). The hook never throws upward.
 */

import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { noteUiProbePreviewFrame } from "@/lib/ai-edition/perf/uiFrameProbe";
import {
	createCompositorView,
	destroyCompositorView,
	readCompositorFrame,
	setCompositorParam,
	setCompositorPlaying,
	setCompositorRect,
	stopSharedCompositorFrames,
	subscribeCompositorSharedFrames,
} from "../compositorViewClient";
import type { CompositorParamValue, CompositorViewRect } from "../contracts";
import { publishFootageQuad } from "../footageQuadStore";
import { computeDeviceRect, rectsEqual } from "../nativeViewRect";

export interface UseNativeCompositorViewOptions {
	/** When false, the hook does nothing on mount and destroys nothing on
	 * unmount. Defaults to true. */
	enabled?: boolean;
	/** F3: real recording sources (screen + webcam H264 files + cursor telemetry).
	 * Omitted → the native side falls back to the POC fixture. Read once at view
	 * creation, so resolve them before enabling the hook to avoid a fixture→real
	 * re-create. */
	sources?: { screenPath?: string; webcamPath?: string; cursorPath?: string };
}

export interface UseNativeCompositorViewResult {
	/** Numeric view id once createCompositorView resolves. `null` while the
	 * call is in flight or when the bridge is unavailable. May be a negative
	 * synthetic id when the native addon is absent (see
	 * `compositorViewService`). */
	viewId: number | null;
	setParam: (key: string, value: CompositorParamValue) => void;
	setPlaying: (playing: boolean) => void;
	/**
	 * Native message from a render thread that died — no D3D11 device on this host,
	 * a decoder that refused the recording, etc. `null` while things work AND in every
	 * environment without the native path (pure web `npm run dev`, jsdom): the pull
	 * loop that produces this only runs once a real `viewId` exists, so an absent
	 * bridge or addon reads as "no frames", never as an error.
	 *
	 * Terminal: the render thread does not restart, so the pull loop stops with it.
	 * Callers show it instead of the canvas — it is the only thing that distinguishes
	 * "this machine cannot run the compositor" from a preview that is merely black.
	 */
	error: string | null;
}

/** swallow+warn wrapper for native-bridge calls. The renderer can run without
 * a preload `electronAPI` (jsdom, pure web); errors must never propagate. */
function safelyCall(label: string, call: () => Promise<unknown>) {
	try {
		call().catch((error: unknown) => {
			console.warn(`[compositor-view] ${label} failed:`, error);
		});
	} catch (error) {
		console.warn(`[compositor-view] ${label} failed:`, error);
	}
}

/** Least time between two pulls, by the clock rather than in animation frames: the display
 *  sets the rAF rate, the recording sets the frame rate, and the two have nothing to do with
 *  each other. Counting ticks pulled 280 times a second on a 280 Hz display, idle or not, and
 *  under-pulled read-back frames on 60 Hz, where a tick lost to a slow round trip pushed the
 *  next pull a whole tick further.
 *
 *  While shared-texture frames keep coming, a pull every 8 ms catches each one within half a
 *  60 fps frame. Anything else — read-back frames, each a GPU readback, a structured clone
 *  across IPC and a canvas upload, or a view with nothing new — is pulled ~30 times a second. */
const PULL_INTERVAL_FLOWING_MS = 8;
const PULL_INTERVAL_MS = 33;
/** Frames still count as coming this long after the last one. A pull that lands between two
 *  frames finds nothing new, and taking that for the end of playback dropped every next
 *  pull to the slow interval: ~40 frames a second drawn out of ~60. */
const PULL_FLOWING_WINDOW_MS = 250;
/** rAF timestamps jitter around the display's period: without it, a 33 ms interval on a 60 Hz
 *  display would land on the third tick as often as the second. */
const PULL_INTERVAL_SLACK_MS = 1.5;

export function useNativeCompositorView(
	canvasRef: RefObject<HTMLCanvasElement>,
	opts: UseNativeCompositorViewOptions = {},
): UseNativeCompositorViewResult {
	const enabled = opts.enabled !== false;
	// Re-create the native view when the screen source changes (e.g. loading a different
	// project) so it never keeps showing a stale clip.
	const screenPath = opts.sources?.screenPath;
	const [view, setView] = useState<{ id: number; screenPath: string | undefined } | null>(null);
	// A view is only handed out for the source it was created for. When a project switch
	// changes the source, the old view is destroyed in this very commit while the new one is
	// still being created; returning its id in the meantime let the caller's effects push the
	// NEW project's scene and clip to the dying view, and the preview then drew captions and
	// frames at the wrong times until something re-pushed the scene (#960).
	const viewId = view && view.screenPath === screenPath ? view.id : null;
	const [error, setError] = useState<string | null>(null);
	// Mirror into a ref so async callbacks always see the freshest id without
	// re-subscribing the main effect. It tracks the live native view, not `viewId`, so the
	// cleanup still destroys the old view after a source change.
	const viewIdRef = useRef<number | null>(null);
	viewIdRef.current = view?.id ?? null;

	useEffect(() => {
		if (!enabled) {
			return;
		}
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}

		let rectRafHandle = 0;
		let pullRafHandle = 0;
		let lastPullAt = Number.NEGATIVE_INFINITY;
		let lastRect: CompositorViewRect | null = null;
		let disposed = false;
		// Fresh view (source or enablement changed) → the previous view's fatal error
		// says nothing about this one.
		setError(null);

		// `data-painted` tells the preview card the canvas holds pixels, so it can drop its
		// placeholder background (see `.previewFrame`), which would otherwise show through the
		// anti-aliased rounded clip. It is set once a frame is really drawn, and cleared for a
		// fresh view, whose bitmap stays empty until that view paints.
		const markPainted = () => {
			canvas.dataset.painted = "true";
		};
		delete canvas.dataset.painted;

		/** Size the canvas's DRAWING BUFFER. Destructive: assigning `canvas.width` or
		 *  `canvas.height` empties the bitmap, so past the mount it only happens in the same
		 *  task as the draw that refills it (see `paint` in the pull loop). */
		const setBufferSize = (width: number, height: number) => {
			if (canvas.width !== width) {
				canvas.width = width;
			}
			if (canvas.height !== height) {
				canvas.height = height;
			}
		};

		const applyRectNow = () => {
			rectRafHandle = 0;
			if (disposed) {
				return;
			}
			// `getBoundingClientRect` on the canvas reflects its CSS layout box;
			// scaled to device pixels for the native offscreen target.
			const domRect = canvas.getBoundingClientRect();
			const next = computeDeviceRect(domRect, window.devicePixelRatio);
			// `x` / `y` are vestigial in the new contract (ignored native-side),
			// but `rectsEqual` still compares them — harmless: scrolling will just
			// re-push the rect, and the native side ignores x/y.
			if (lastRect && rectsEqual(lastRect, next)) {
				return;
			}
			lastRect = next;
			const id = viewIdRef.current;
			if (id == null) {
				return;
			}
			safelyCall("setRect", () => setCompositorRect(id, next));
		};

		const scheduleRectUpdate = () => {
			if (rectRafHandle !== 0) {
				return;
			}
			rectRafHandle = requestAnimationFrame(applyRectNow);
		};

		// Generation of the last frame we painted. The native side only publishes a
		// NEW generation when it actually composed a new frame (it never republishes
		// an identical one), so passing this back as `sinceGen` means an unchanged
		// frame is never re-delivered: no clone, no IPC, no canvas copy while the
		// preview sits still (paused editing — the dominant case). `0` = "painted
		// nothing yet", which forces delivery of the first frame.
		let lastGen = 0;
		// Only one readFrame in flight at a time. Skipping while pending both avoids
		// redundant IPC and removes any chance of two responses landing out of order
		// and rewinding `lastGen` (which would re-deliver an already-painted frame).
		let inFlight = false;
		// `inFlight` orders the reads, not the paints: a bitmap still decoding can finish after
		// the next frame's. The generation actually on the canvas lets an older one be dropped,
		// instead of bringing back its pixels and its buffer size until native sends another.
		let paintedGen = 0;
		// Frames arrive as shared GPU textures (see `subscribeCompositorSharedFrames`), and one
		// came lately: while both hold, the loop pulls at its fast interval.
		let sharedTransport = false;
		let lastFrameAt = Number.NEGATIVE_INFINITY;
		// Whether this view's first shared frame was checked to have actually landed.
		let sharedChecked = false;

		/** Puts a frame on the canvas. The buffer takes the frame's size HERE, in the same task
		 *  as the draw that refills it, never when the canvas box changes: anything awaited
		 *  between the two (the rect's trip to native, `createImageBitmap`) is a frame the
		 *  browser presents empty. Meanwhile CSS stretches the previous frame over the new box.
		 *  An Auto format reshapes that box on every padding tick, so an early resize blinked
		 *  the footage out and back while the slider moved. */
		const paint = (gen: number, width: number, height: number, draw: () => void): boolean => {
			if (disposed || gen < paintedGen) {
				return false;
			}
			setBufferSize(width, height);
			draw();
			paintedGen = gen;
			markPainted();
			return true;
		};

		// Frames the main process hands over as shared GPU textures land here, ahead of the
		// `readCompositorFrame` reply that names their generation.
		const unsubscribeShared = subscribeCompositorSharedFrames((frame, meta) => {
			try {
				const id = viewIdRef.current;
				const ctx = canvas.getContext("2d");
				if (disposed || id == null || meta.viewId !== id || !ctx) {
					return;
				}
				sharedTransport = true;
				lastGen = Math.max(lastGen, meta.gen);
				publishFootageQuad(meta.footage, meta.footageProjective);
				const fresh = canvas.dataset.painted === undefined;
				const drawn = paint(meta.gen, meta.width, meta.height, () => ctx.drawImage(frame, 0, 0));
				if (drawn && fresh && !sharedChecked) {
					sharedChecked = true;
					// Chromium opens the texture in its own GPU process, and one it cannot open (a
					// hybrid laptop's other adapter) draws as nothing at all. The composed frame is
					// opaque everywhere, so a transparent pixel on this fresh canvas is that failure.
					if (ctx.getImageData(meta.width >> 1, meta.height >> 1, 1, 1).data[3] === 0) {
						sharedTransport = false;
						safelyCall("stopSharedFrames", () => stopSharedCompositorFrames(id));
					}
				}
				noteUiProbePreviewFrame();
			} finally {
				frame.close();
			}
		});

		/** rAF pull loop: repaint ONLY when native reports a newer generation. A pixel packet
		 *  is self-describing (`gen` + dims + pixels), so the canvas is sized from the packet —
		 *  pixels and canvas can never drift out of sync. */
		const pullLoop = (now: number) => {
			pullRafHandle = requestAnimationFrame(pullLoop);
			if (disposed || inFlight) {
				return;
			}
			const flowing = sharedTransport && now - lastFrameAt < PULL_FLOWING_WINDOW_MS;
			const interval = flowing ? PULL_INTERVAL_FLOWING_MS : PULL_INTERVAL_MS;
			if (now - lastPullAt < interval - PULL_INTERVAL_SLACK_MS) {
				return;
			}
			const id = viewIdRef.current;
			if (id == null) {
				return;
			}
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return;
			}
			inFlight = true;
			lastPullAt = now;
			readCompositorFrame(id, lastGen)
				.then((frame) => {
					inFlight = false;
					if (frame) {
						lastFrameAt = now;
					}
					// `null` = nothing newer than `lastGen` (idle path — no pixels
					// crossed IPC) OR no frame yet. Either way, leave the canvas as-is.
					if (disposed || !frame) {
						return;
					}
					if ("shared" in frame) {
						// Already drawn by the shared-frame listener: only the generation is news.
						lastGen = Math.max(lastGen, frame.gen);
						return;
					}
					const { gen, width, height, data } = frame;
					// Defensive: the packet's byte count must match its own declared
					// dimensions. A mismatch would corrupt the image silently — bail.
					if (data.byteLength !== width * height * 4 || width === 0 || height === 0) {
						return;
					}
					// Where the footage lies in this frame: a privacy blur's gimbal follows it.
					publishFootageQuad(frame.footage, frame.footageProjective);
					// Wrap the received buffer DIRECTLY — no intermediate copy. `data` is a
					// fresh per-frame Buffer from IPC (never pooled or reused across frames),
					// so a view over it is valid for the lifetime of this paint, and nothing
					// mutates it. Cast to `ArrayBuffer` because `ImageData` rejects
					// `SharedArrayBuffer`-backed arrays (IPC binary is never shared).
					const pixels = new Uint8ClampedArray(
						data.buffer as ArrayBuffer,
						data.byteOffset,
						data.byteLength,
					);
					const image = new ImageData(pixels, width, height);
					// `createImageBitmap` decodes off the main thread (keeps UI at 60/120fps)
					// and snapshots `image`, so the view can be released after; `putImageData`
					// is the synchronous fallback if bitmap creation is unavailable.
					createImageBitmap(image)
						.then((bitmap) => {
							paint(gen, width, height, () => ctx.drawImage(bitmap, 0, 0));
							bitmap.close();
						})
						.catch(() => paint(gen, width, height, () => ctx.putImageData(image, 0, 0)));
					// Advance only after a successful, validated frame — so a dropped/
					// malformed packet is retried rather than silently skipped.
					lastGen = gen;
					// Sonde de fluidité : signale qu'une frame a réellement été livrée, pour
					// que les intervalles rAF soient rangés dans l'état « preview active »
					// plutôt que moyennés avec des périodes de repos.
					noteUiProbePreviewFrame();
				})
				.catch((cause: unknown) => {
					inFlight = false;
					console.warn("[compositor-view] readFrame failed:", cause);
					// Native reports the render thread's fatal error here (see the addon's
					// `read_frame`), and it is the ONLY place it can surface: `createView`
					// has long since returned an id by the time the thread dies. Stop
					// polling — a dead thread never publishes another frame — and hand the
					// message up so the user gets it instead of a silent black canvas.
					if (disposed) {
						return;
					}
					cancelAnimationFrame(pullRafHandle);
					pullRafHandle = 0;
					setError(cause instanceof Error ? cause.message : String(cause));
				});
		};

		// Initial mount: allocate the native view with the rect observed at
		// the moment the effect ran. The async id will be used on subsequent
		// resize/scroll updates. Without the bridge, this is a swallowed
		// warning — the rest of the hook stays inert.
		const initialRect = computeDeviceRect(canvas.getBoundingClientRect(), window.devicePixelRatio);
		lastRect = initialRect;
		// Prime the canvas drawing buffer to the resolution we expect the
		// first pulled frame to have; avoids a 300x150 flash before the
		// first readFrame resolves.
		setBufferSize(initialRect.width, initialRect.height);

		safelyCall("createView", async () => {
			const result = await createCompositorView(initialRect, opts.sources);
			if (disposed) {
				// The element unmounted before the response came back; clean up.
				safelyCall("destroyView (late)", () => destroyCompositorView(result.id));
				return;
			}
			viewIdRef.current = result.id;
			setView({ id: result.id, screenPath });
		});

		const observer = new ResizeObserver(scheduleRectUpdate);
		observer.observe(canvas);
		window.addEventListener("resize", scheduleRectUpdate);
		// capture phase so we observe parent scroll containers too,
		// not just `window` — the preview pane may scroll independently.
		window.addEventListener("scroll", scheduleRectUpdate, true);

		// Start the pull loop only after the view id is published — otherwise
		// every early tick would just hit `id == null` and no-op. Id is set
		// in the safelyCall above; we also pull here defensively for the
		// common case (addon absent → synthetic negative id, pull returns null,
		// no draw happens). The pull loop self-cancels in cleanup.
		pullRafHandle = requestAnimationFrame(pullLoop);

		return () => {
			disposed = true;
			unsubscribeShared();
			publishFootageQuad(null);
			if (rectRafHandle !== 0) {
				cancelAnimationFrame(rectRafHandle);
			}
			if (pullRafHandle !== 0) {
				cancelAnimationFrame(pullRafHandle);
			}
			observer.disconnect();
			window.removeEventListener("resize", scheduleRectUpdate);
			window.removeEventListener("scroll", scheduleRectUpdate, true);
			const id = viewIdRef.current;
			if (id != null) {
				safelyCall("destroyView", () => destroyCompositorView(id));
			}
		};
		// `canvasRef` is a stable RefObject; we re-run (destroy + re-create the view) when the
		// enabled flag flips or the screen source changes.
	}, [enabled, canvasRef, screenPath]);

	const setParam = useCallback((key: string, value: CompositorParamValue) => {
		const id = viewIdRef.current;
		if (id == null) {
			return;
		}
		safelyCall("setParam", () => setCompositorParam(id, key, value));
	}, []);

	const setPlaying = useCallback((playing: boolean) => {
		const id = viewIdRef.current;
		if (id == null) {
			return;
		}
		safelyCall("setPlaying", () => setCompositorPlaying(id, playing));
	}, []);

	return { viewId, setParam, setPlaying, error };
}
