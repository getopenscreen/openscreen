// @vitest-environment jsdom
//
// What a slider drag is allowed to put on the undo stack, and — the part that
// went wrong — what it is allowed to still be holding once the drag is over.
//
// `liveBaseRef` is the document a drag started from, kept until the commit that
// records it. Nothing else emptied it: `set` leaves it alone, and a drag does not
// always reach a commit (the gradient editor's is a 400ms timer its own unmount
// cleanup cancels). `SliderCell` then wires mouseup/touchend/keyup straight to
// `commit` with no `onChange` in front, so a bare click on a thumb is enough to
// hand that leftover on as `historyBase`.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { getEditorSettings } from "./editorSettings";
import { useProjectStore } from "./projectStore";
import { clearHistory, undo } from "./undo";
import { past } from "./undoStack";
import { useEditorSettings } from "./useEditorSettings";

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			get: bridgeMocks.get,
			create: bridgeMocks.create,
			save: bridgeMocks.save,
			addAsset: bridgeMocks.addAsset,
			removeAsset: bridgeMocks.removeAsset,
			listProjects: bridgeMocks.listProjects,
		},
	},
}));

const docA: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_a",
		title: "A",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 30,
			video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
			cameraTrack: null,
		},
	],
	transcript: null,
	transcripts: [],
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
	legacyEditor: null,
};

const docB: AxcutDocument = {
	...docA,
	project: { ...docA.project, id: "proj_b", title: "B" },
};

/** `borderRadius` of the document a snapshot holds. The defaults are the tell:
 *  40 is what nobody has touched, so an assertion on it says "this is the
 *  pre-drag document" without spelling the whole fixture out again. */
const radiusOf = (doc: unknown) => getEditorSettings(doc as AxcutDocument).borderRadius;

describe("useEditorSettings drag snapshots", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		for (const mock of Object.values(bridgeMocks)) mock.mockReset();
		bridgeMocks.save.mockImplementation(async (doc: AxcutDocument) => ({
			success: true,
			document: doc,
		}));
		useProjectStore.setState({
			projectId: "proj_a",
			document: docA,
			revision: 1,
			status: "ready",
			error: null,
		});
	});

	afterEach(() => {
		clearHistory();
		vi.clearAllMocks();
	});

	it("returns whether a settings edit persisted", async () => {
		const { result } = renderHook(() => useEditorSettings());
		await expect(result.current.set({ borderRadius: 10 })).resolves.toBe(true);
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "disk full" });
		await expect(result.current.set({ borderRadius: 20 })).resolves.toBe(false);
	});

	it("does not record a snapshot of the project the user left", async () => {
		const { result, rerender } = renderHook(() => useEditorSettings());

		// The drag that never commits. `liveBaseRef` now holds project A's document.
		act(() => result.current.setLive({ padding: 80 }));

		act(() => {
			useProjectStore.setState({ projectId: "proj_b", document: docB });
		});
		rerender();

		// One real edit in project B, so the stack has something to lose.
		await act(async () => {
			await result.current.set({ borderRadius: 10 });
		});
		expect(past.map((s) => s.projectId)).toEqual(["proj_b"]);

		// The bare click on a slider thumb.
		await act(async () => {
			await result.current.commit();
		});

		expect(past.map((s) => s.projectId)).toEqual(["proj_b"]);
		// And what the foreign snapshot cost is more than one step: `undo` answers a
		// projectId that is not the store's by throwing the WHOLE stack away, so the
		// user loses this edit's undo as well as the bogus one.
		expect(undo()).toBe(true);
		expect(radiusOf(useProjectStore.getState().document)).toBe(40);
	});

	it("does not hand a bare commit a base the edits since have already buried", async () => {
		const { result } = renderHook(() => useEditorSettings());

		act(() => result.current.setLive({ padding: 80 }));

		// Two edits the user makes next, each recording its own step.
		await act(async () => {
			await result.current.set({ borderRadius: 10 });
		});
		await act(async () => {
			await result.current.set({ borderRadius: 20 });
		});
		expect(past).toHaveLength(2);

		await act(async () => {
			await result.current.commit();
		});

		// Same project, so no clearing happens — the cost here is that one Ctrl+Z
		// jumps over both edits and lands on the document the abandoned drag started
		// from (radius 40, the untouched default).
		expect(past).toHaveLength(2);
		expect(undo()).toBe(true);
		expect(radiusOf(useProjectStore.getState().document)).toBe(10);
	});

	it("refits the frame's annotations with a new format, in the same undo step", async () => {
		const text: AxcutDocument["annotations"][number] = {
			id: "ann1",
			startMs: 0,
			endMs: 1000,
			type: "text",
			content: "hi",
			space: "frame",
			position: { x: 45, y: 40 },
			size: { width: 10, height: 6 },
			style: {
				color: "#ffffff",
				backgroundColor: "transparent",
				fontSize: 32,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			},
			zIndex: 1,
		};
		useProjectStore.setState({
			document: { ...docA, annotations: [text], legacyEditor: { aspectRatio: "16:9" } },
		});
		const { result } = renderHook(() => useEditorSettings());
		await act(async () => {
			await result.current.set({ aspectRatio: "9:16" });
		});

		const after = useProjectStore.getState().document?.annotations[0];
		// Its width is a share of a frame now 3.16 times narrower in pixels: the share grows by
		// as much, around the same centre, so the text keeps its line and its place.
		expect(after?.size.width).toBeCloseTo((10 * (16 / 9)) / (9 / 16), 6);
		expect((after?.position.x ?? 0) + (after?.size.width ?? 0) / 2).toBeCloseTo(50, 6);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.annotations[0]).toEqual(text);
	});

	it("still records the pre-drag document when the drag does reach its commit", async () => {
		// The guards above must not cost the feature they are guarding: a drag that
		// ends the way a drag normally ends is still ONE undo step, back to before it.
		const { result } = renderHook(() => useEditorSettings());

		act(() => result.current.setLive({ borderRadius: 12 }));
		act(() => result.current.setLive({ borderRadius: 14 }));
		await act(async () => {
			await result.current.commit();
		});

		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(radiusOf(useProjectStore.getState().document)).toBe(40);
	});
});
