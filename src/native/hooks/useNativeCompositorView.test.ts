// @vitest-environment jsdom
/**
 * The fatal-error channel (PR #162).
 *
 * `createView` returns an id long before the native render thread can fail, so a host
 * that cannot create a D3D11 device used to leave the user with a black canvas and an
 * `eprintln!` nobody reads. The addon now reports the dead thread through `readFrame`,
 * and this hook turns that into `error`.
 *
 * The half worth guarding is the negative one: `readFrame` also rejects when there is no
 * Electron bridge at all (pure web `npm run dev`, jsdom), and the addon being absent is a
 * normal no-op, not a failure. Neither may raise the banner.
 */

import { renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositorSharedFrameMeta } from "../contracts";

type SharedFrameListener = (frame: VideoFrame, meta: CompositorSharedFrameMeta) => void;

const mocks = vi.hoisted(() => ({
	createCompositorView: vi.fn(),
	readCompositorFrame: vi.fn(),
	destroyCompositorView: vi.fn(),
	setCompositorRect: vi.fn(async () => undefined),
	stopSharedCompositorFrames: vi.fn(async () => ({ ok: true })),
	/** What the preload would call with each frame sent as a shared texture. */
	sharedListener: null as SharedFrameListener | null,
}));

vi.mock("../compositorViewClient", () => ({
	createCompositorView: mocks.createCompositorView,
	readCompositorFrame: mocks.readCompositorFrame,
	destroyCompositorView: mocks.destroyCompositorView,
	setCompositorParam: vi.fn(),
	setCompositorPlaying: vi.fn(),
	setCompositorRect: mocks.setCompositorRect,
	stopSharedCompositorFrames: mocks.stopSharedCompositorFrames,
	subscribeCompositorSharedFrames: (listener: SharedFrameListener) => {
		mocks.sharedListener = listener;
		return () => {
			if (mocks.sharedListener === listener) {
				mocks.sharedListener = null;
			}
		};
	},
}));

import { useNativeCompositorView } from "./useNativeCompositorView";

// jsdom ships no ResizeObserver; the hook constructs one to track the canvas box.
// Nothing here observes anything — these tests only exercise the pull loop.
globalThis.ResizeObserver = class {
	observe() {
		// inert on purpose: the canvas box never changes in these tests
	}
	unobserve() {
		// see observe()
	}
	disconnect() {
		// see observe()
	}
} as unknown as typeof ResizeObserver;

/** A canvas with a stubbed 2D context — jsdom has none, and the pull loop bails without it.
 *  `centreAlpha` is what reading back the middle pixel answers: opaque, as a composed frame
 *  always is, unless a test says otherwise. */
function stubCanvasRef(centreAlpha = 255): RefObject<HTMLCanvasElement> {
	const canvas = document.createElement("canvas");
	const ctx = {
		drawImage: vi.fn(),
		putImageData: vi.fn(),
		getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, centreAlpha]) })),
	};
	canvas.getContext = vi.fn(() => ctx) as unknown as HTMLCanvasElement["getContext"];
	return { current: canvas };
}

function context(ref: RefObject<HTMLCanvasElement>) {
	return ref.current?.getContext("2d") as unknown as {
		drawImage: ReturnType<typeof vi.fn>;
		getImageData: ReturnType<typeof vi.fn>;
	};
}

function sharedMeta(overrides: Partial<CompositorSharedFrameMeta> = {}): CompositorSharedFrameMeta {
	return {
		viewId: 7,
		gen: 3,
		width: 4,
		height: 2,
		footage: null,
		footageProjective: false,
		...overrides,
	};
}

function fakeVideoFrame() {
	return { close: vi.fn() } as unknown as VideoFrame & { close: ReturnType<typeof vi.fn> };
}

const DEVICE_FAILURE =
	"this display adapter has no D3D11 video decoder (0x887A0004). OpenScreen decodes every preview and export frame with D3D11VA";

describe("useNativeCompositorView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sharedListener = null;
	});

	it("surfaces the native message when the render thread dies", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
	});

	it("stops polling once the error is terminal — the thread never restarts", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
		const callsAtFailure = mocks.readCompositorFrame.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(callsAtFailure);
	});

	it("stays quiet when the addon is absent (synthetic id, no frames, no error)", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: -1 });
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.readCompositorFrame).toHaveBeenCalled());
		expect(result.current.error).toBeNull();
		// No frame yet: the card keeps its placeholder background.
		expect(ref.current?.dataset.painted).toBeUndefined();
	});

	// The preview card paints a placeholder wallpaper until the canvas has pixels; left under
	// the same rounded clip afterwards, it showed through the anti-aliased corners. The canvas
	// says when it has painted, and the card's CSS drops the placeholder then.
	it("marks the canvas painted once a frame lands", async () => {
		vi.stubGlobal(
			"ImageData",
			class {
				constructor(
					public data: Uint8ClampedArray,
					public width: number,
					public height: number,
				) {}
			},
		);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => ({ close: vi.fn() })),
		);
		try {
			mocks.createCompositorView.mockResolvedValue({ id: 1 });
			mocks.readCompositorFrame.mockResolvedValue({
				gen: 1,
				width: 2,
				height: 1,
				data: new Uint8Array(8),
			});
			const ref = stubCanvasRef();
			renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));
			await waitFor(() => expect(ref.current?.dataset.painted).toBe("true"));
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("clears the mark for a fresh view until that view paints", async () => {
		vi.stubGlobal(
			"ImageData",
			class {
				constructor(
					public data: Uint8ClampedArray,
					public width: number,
					public height: number,
				) {}
			},
		);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => ({ close: vi.fn() })),
		);
		try {
			mocks.createCompositorView.mockResolvedValue({ id: 1 });
			mocks.readCompositorFrame.mockResolvedValue({
				gen: 1,
				width: 2,
				height: 1,
				data: new Uint8Array(8),
			});
			const ref = stubCanvasRef();
			const { rerender } = renderHook(
				({ path }: { path: string }) =>
					useNativeCompositorView(ref, { sources: { screenPath: path } }),
				{ initialProps: { path: "a.mp4" } },
			);
			await waitFor(() => expect(ref.current?.dataset.painted).toBe("true"));

			// Another recording: its view has painted nothing yet.
			mocks.readCompositorFrame.mockResolvedValue(null);
			rerender({ path: "b.mp4" });
			await waitFor(() => expect(ref.current?.dataset.painted).toBeUndefined());
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// An Auto format reshapes the preview box on every padding tick. Resizing the drawing buffer
	// then, rather than with the next draw, emptied it until native answered at the new size:
	// the footage blinked out and back while the slider moved.
	it("keeps the last frame up when the canvas box changes, until a frame at the new size lands", async () => {
		vi.stubGlobal(
			"ImageData",
			class {
				constructor(
					public data: Uint8ClampedArray,
					public width: number,
					public height: number,
				) {}
			},
		);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => ({ close: vi.fn() })),
		);
		try {
			mocks.createCompositorView.mockResolvedValue({ id: 1 });
			mocks.readCompositorFrame
				.mockResolvedValueOnce({ gen: 1, width: 4, height: 2, data: new Uint8Array(32) })
				.mockResolvedValue(null);
			const ref = stubCanvasRef();
			const canvas = ref.current as HTMLCanvasElement;
			let box = { width: 4, height: 2 };
			canvas.getBoundingClientRect = () => ({ left: 0, top: 0, ...box }) as DOMRect;
			renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));
			await waitFor(() => expect(canvas.dataset.painted).toBe("true"));

			box = { width: 4, height: 3 };
			window.dispatchEvent(new Event("resize"));
			await waitFor(() => expect(mocks.setCompositorRect).toHaveBeenCalled());
			// Untouched buffer: the bitmap still holds the last frame.
			expect(canvas.height).toBe(2);
			expect(canvas.dataset.painted).toBe("true");

			mocks.readCompositorFrame.mockResolvedValueOnce({
				gen: 2,
				width: 4,
				height: 3,
				data: new Uint8Array(48),
			});
			await waitFor(() => expect(canvas.height).toBe(3));
			expect(canvas.dataset.painted).toBe("true");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// `inFlight` orders the reads, not the bitmap decodes: an older frame's bitmap can land after
	// a newer one's. Painting it would bring back its pixels and its buffer size.
	it("drops a frame whose bitmap lands after a newer one's", async () => {
		vi.stubGlobal(
			"ImageData",
			class {
				constructor(
					public data: Uint8ClampedArray,
					public width: number,
					public height: number,
				) {}
			},
		);
		const decodes: Array<(bitmap: { close: () => void }) => void> = [];
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(
				() =>
					new Promise<{ close: () => void }>((resolve) => {
						decodes.push(resolve);
					}),
			),
		);
		try {
			mocks.createCompositorView.mockResolvedValue({ id: 1 });
			mocks.readCompositorFrame
				.mockResolvedValueOnce({ gen: 1, width: 4, height: 2, data: new Uint8Array(32) })
				.mockResolvedValueOnce({ gen: 2, width: 4, height: 3, data: new Uint8Array(48) })
				.mockResolvedValue(null);
			const ref = stubCanvasRef();
			const canvas = ref.current as HTMLCanvasElement;
			renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));
			await waitFor(() => expect(decodes).toHaveLength(2));

			decodes[1]({ close: vi.fn() });
			await waitFor(() => expect(canvas.height).toBe(3));
			decodes[0]({ close: vi.fn() });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(canvas.height).toBe(3);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("stays quiet without an Electron bridge — no view id, so nothing is ever polled", async () => {
		mocks.createCompositorView.mockRejectedValue(new Error("Native bridge unavailable."));
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.createCompositorView).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).not.toHaveBeenCalled();
		expect(result.current.error).toBeNull();
	});

	// Issue #960: on a project switch the old view is destroyed in the same commit that
	// starts creating the new one. Handing out the old id meanwhile let the caller push the
	// new project's scene and clip to the dying view, and the preview drew captions and
	// frames at the wrong times.
	it("hands out no view id while the view for a new source is being created", async () => {
		mocks.readCompositorFrame.mockResolvedValue(null);
		let resolveSecond: (value: { id: number }) => void = () => undefined;
		mocks.createCompositorView
			.mockResolvedValueOnce({ id: 7 })
			.mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

		const ref = stubCanvasRef();
		const { result, rerender } = renderHook(
			({ screenPath }) => useNativeCompositorView(ref, { sources: { screenPath } }),
			{ initialProps: { screenPath: "a.mp4" } },
		);
		await waitFor(() => expect(result.current.viewId).toBe(7));

		rerender({ screenPath: "b.mp4" });
		expect(result.current.viewId).toBeNull();
		expect(mocks.destroyCompositorView).toHaveBeenCalledWith(7);

		resolveSecond({ id: 8 });
		await waitFor(() => expect(result.current.viewId).toBe(8));
	});

	describe("frames handed over as shared GPU textures", () => {
		it("draws the frame on the canvas, sized to it, and closes it", async () => {
			mocks.createCompositorView.mockResolvedValue({ id: 7 });
			mocks.readCompositorFrame.mockResolvedValue(null);
			const ref = stubCanvasRef();
			const { result } = renderHook(() =>
				useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
			);
			await waitFor(() => expect(result.current.viewId).toBe(7));

			const frame = fakeVideoFrame();
			mocks.sharedListener?.(frame, sharedMeta());

			expect(context(ref).drawImage).toHaveBeenCalledWith(frame, 0, 0);
			expect(ref.current?.width).toBe(4);
			expect(ref.current?.height).toBe(2);
			expect(ref.current?.dataset.painted).toBe("true");
			expect(frame.close).toHaveBeenCalled();
			expect(mocks.stopSharedCompositorFrames).not.toHaveBeenCalled();
		});

		it("closes a frame meant for another view without drawing it", async () => {
			mocks.createCompositorView.mockResolvedValue({ id: 7 });
			mocks.readCompositorFrame.mockResolvedValue(null);
			const ref = stubCanvasRef();
			const { result } = renderHook(() =>
				useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
			);
			await waitFor(() => expect(result.current.viewId).toBe(7));

			const frame = fakeVideoFrame();
			mocks.sharedListener?.(frame, sharedMeta({ viewId: 8 }));

			expect(context(ref).drawImage).not.toHaveBeenCalled();
			expect(frame.close).toHaveBeenCalled();
		});

		// Chromium opens the texture in its own GPU process. One it cannot open — a hybrid
		// laptop's other adapter — draws as nothing, and the preview would stay empty.
		it("goes back to read-back frames when the first one lands as nothing", async () => {
			mocks.createCompositorView.mockResolvedValue({ id: 7 });
			mocks.readCompositorFrame.mockResolvedValue(null);
			const ref = stubCanvasRef(0);
			const { result } = renderHook(() =>
				useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
			);
			await waitFor(() => expect(result.current.viewId).toBe(7));

			mocks.sharedListener?.(fakeVideoFrame(), sharedMeta());

			expect(mocks.stopSharedCompositorFrames).toHaveBeenCalledWith(7);
		});

		it("checks only the view's first frame, not every frame", async () => {
			mocks.createCompositorView.mockResolvedValue({ id: 7 });
			mocks.readCompositorFrame.mockResolvedValue(null);
			const ref = stubCanvasRef();
			const { result } = renderHook(() =>
				useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
			);
			await waitFor(() => expect(result.current.viewId).toBe(7));

			mocks.sharedListener?.(fakeVideoFrame(), sharedMeta({ gen: 3 }));
			mocks.sharedListener?.(fakeVideoFrame(), sharedMeta({ gen: 4 }));

			// A readback stalls the GPU pipeline: one per view, not one per frame.
			expect(context(ref).getImageData).toHaveBeenCalledTimes(1);
		});

		it("takes a receipt as the generation to ask after, with nothing to draw", async () => {
			mocks.createCompositorView.mockResolvedValue({ id: 7 });
			mocks.readCompositorFrame
				.mockResolvedValueOnce({ ...sharedMeta({ gen: 5 }), shared: true })
				.mockResolvedValue(null);
			const ref = stubCanvasRef();
			renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));

			await waitFor(() => expect(mocks.readCompositorFrame).toHaveBeenCalledWith(7, 5));
			expect(context(ref).drawImage).not.toHaveBeenCalled();
		});
	});
});
