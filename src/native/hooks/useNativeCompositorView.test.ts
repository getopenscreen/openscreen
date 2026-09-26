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

import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createCompositorView: vi.fn(),
	readCompositorFrame: vi.fn(),
	destroyCompositorView: vi.fn(),
}));

vi.mock("../compositorViewClient", () => ({
	createCompositorView: mocks.createCompositorView,
	readCompositorFrame: mocks.readCompositorFrame,
	destroyCompositorView: mocks.destroyCompositorView,
	setCompositorParam: vi.fn(),
	setCompositorPlaying: vi.fn(),
	setCompositorRect: vi.fn(),
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

/** A canvas with a stubbed 2D context — jsdom has none, and the pull loop bails without it. */
function stubCanvasRef(): RefObject<HTMLCanvasElement> {
	const canvas = document.createElement("canvas");
	const context = {
		drawImage: vi.fn(),
		putImageData: vi.fn(),
	};
	canvas.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement["getContext"];
	return { current: canvas };
}

const DEVICE_FAILURE =
	"this display adapter has no D3D11 video decoder (0x887A0004). OpenScreen decodes every preview and export frame with D3D11VA";

describe("useNativeCompositorView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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

	it("does not paint an older bitmap after a newer frame", async () => {
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
		const pending = new Map<number, (bitmap: { marker: number; close: () => void }) => void>();
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(
				(image: ImageData) =>
					new Promise<{ marker: number; close: () => void }>((resolve) => {
						pending.set(image.data[0], resolve);
					}),
			),
		);
		try {
			mocks.createCompositorView.mockResolvedValue({ id: 1 });
			mocks.readCompositorFrame
				.mockResolvedValueOnce({
					gen: 1,
					width: 2,
					height: 1,
					data: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]),
				})
				.mockResolvedValueOnce({
					gen: 2,
					width: 2,
					height: 1,
					data: new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]),
				})
				.mockResolvedValue(null);
			const ref = stubCanvasRef();
			renderHook(() => useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }));
			await waitFor(() => expect(pending.size).toBe(2));
			const drawImage = ref.current?.getContext("2d")?.drawImage;

			await act(async () => {
				pending.get(2)?.({ marker: 2, close: vi.fn() });
			});
			expect(drawImage).toHaveBeenCalledWith(expect.objectContaining({ marker: 2 }), 0, 0);
			await act(async () => {
				pending.get(1)?.({ marker: 1, close: vi.fn() });
			});
			expect(drawImage).toHaveBeenCalledTimes(1);
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
});
