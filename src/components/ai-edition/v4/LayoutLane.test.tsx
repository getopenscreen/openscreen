// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLayoutChange, layoutRuns } from "@/lib/ai-edition/document/layout";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { LayoutLane } from "./LayoutLane";

const store = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock("@/lib/ai-edition/store/projectStore", () => ({ useProjectStore: store }));
vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));

function footage() {
	const doc = createEmptyDocument({ title: "Layouts", projectId: "layout-test" });
	doc.timeline.clips = [
		{
			id: "clip",
			assetId: "asset",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			origin: "user",
			reason: "",
			wordRefs: [],
		},
	];
	return doc;
}

describe("layout boundary gestures", () => {
	let current: {
		document: AxcutDocument;
		setDocument: ReturnType<typeof vi.fn>;
		saveDocument: ReturnType<typeof vi.fn>;
	};
	let animation: FrameRequestCallback | null;
	beforeEach(() => {
		animation = null;
		vi.stubGlobal("PointerEvent", MouseEvent);
		vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
			animation = fn;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		current = {
			document: addLayoutChange(footage(), 5, "no-webcam"),
			setDocument: vi.fn((doc: AxcutDocument) => {
				current.document = doc;
			}),
			saveDocument: vi.fn(async () => true),
		};
		store.getState.mockImplementation(() => current);
	});
	afterEach(() => vi.unstubAllGlobals());
	function show() {
		const canvasRef = { current: document.createElement("div") };
		canvasRef.current.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 100);
		const selectRegion = vi.fn(),
			moveLayoutBoundary = vi.fn();
		const tl = {
			layoutSegments: layoutRuns(current.document),
			clips: current.document.timeline.clips,
			selection: null,
			selectRegion,
			moveLayoutBoundary,
		} as unknown as ReturnType<typeof useTimeline>;
		render(<LayoutLane tl={tl} total={10} canvasRef={canvasRef} pxPerSec={100} />);
		return { selectRegion, moveLayoutBoundary };
	}
	it("selects a passage and moves a change with the keyboard", () => {
		const callbacks = show();
		fireEvent.click(screen.getByRole("button", { name: /layouts.no-webcam/ }));
		expect(callbacks.selectRegion).toHaveBeenCalledWith(
			"layout",
			layoutRuns(current.document)[1].ids[0],
		);
		fireEvent.keyDown(screen.getByRole("button", { name: "layouts.moveBoundary" }), {
			key: "ArrowLeft",
		});
		expect(callbacks.moveLayoutBoundary).toHaveBeenCalledWith(
			layoutRuns(current.document)[1].ids[0],
			4.9,
		);
	});
	it("commits a complete drag once, retaining its pre-drag history base", () => {
		const base = current.document;
		show();
		fireEvent.pointerDown(screen.getByRole("button", { name: "layouts.moveBoundary" }), {
			button: 0,
			clientX: 500,
		});
		fireEvent.pointerMove(document, { clientX: 600 });
		expect(current.saveDocument).not.toHaveBeenCalled();
		fireEvent.pointerUp(document, { clientX: 600 });
		expect(layoutRuns(current.document)[1].start).toBe(6);
		expect(current.saveDocument).toHaveBeenCalledExactlyOnceWith(current.document, {
			history: true,
			historyBase: base,
		});
	});
	it("cancels the live preview without persisting it", () => {
		const base = current.document;
		show();
		fireEvent.pointerDown(screen.getByRole("button", { name: "layouts.moveBoundary" }), {
			button: 0,
			clientX: 500,
		});
		fireEvent.pointerMove(document, { clientX: 600 });
		animation?.(0);
		expect(current.document).not.toBe(base);
		fireEvent.pointerCancel(document);
		expect(current.document).toBe(base);
		expect(current.saveDocument).not.toHaveBeenCalled();
	});
	it("does not overwrite a concurrent undo or project change", () => {
		show();
		fireEvent.pointerDown(screen.getByRole("button", { name: "layouts.moveBoundary" }), {
			button: 0,
			clientX: 500,
		});
		const other = footage();
		current.document = other;
		fireEvent.pointerMove(document, { clientX: 600 });
		animation?.(0);
		fireEvent.pointerUp(document);
		expect(current.document).toBe(other);
		expect(current.saveDocument).not.toHaveBeenCalled();
	});
});
