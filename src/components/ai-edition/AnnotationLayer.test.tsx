// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { publishFootageQuad } from "@/native/footageQuadStore";
import { AnnotationLayer } from "./AnnotationLayer";

// react-rnd reads its offset in the parent off `getBoundingClientRect` on mount, and jsdom lays
// nothing out: every rect is at 0, the offset comes out as minus the position, and the box is
// drawn at twice its place. Placing each element where its translate puts it is all the layout
// these boxes need.
beforeAll(() => {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
		this: HTMLElement,
	) {
		const shift = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(this.style.transform);
		const [x, y] = shift ? [Number(shift[1]), Number(shift[2])] : [0, 0];
		return DOMRect.fromRect({ x, y, width: 0, height: 0 });
	});
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => publishFootageQuad(null));

function region(overrides: Partial<AxcutAnnotationRegion>): AxcutAnnotationRegion {
	return {
		id: "a",
		startMs: 0,
		endMs: 1000,
		type: "text",
		content: "Hi",
		position: { x: 10, y: 20 },
		size: { width: 30, height: 40 },
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
		...overrides,
	};
}

// A 1000×500 frame, the footage padded in to 800×400 at (100, 50).
const FOOTAGE = { x: 100, y: 50, width: 800, height: 400 };

function layer(annotations: AxcutAnnotationRegion[], selectedAnnotationId: string | null = null) {
	const view = render(
		<AnnotationLayer
			annotations={annotations}
			selectedAnnotationId={selectedAnnotationId}
			currentTimeSec={0.5}
			frameWidth={1000}
			frameHeight={500}
			footage={FOOTAGE}
			onSelectAnnotation={vi.fn()}
			onChange={vi.fn()}
			onCommit={vi.fn()}
		/>,
	);
	const frame = view.container.firstElementChild as HTMLElement;
	const boxes = [...view.container.querySelectorAll<HTMLElement>(".react-draggable")];
	return { frame, boxes, view };
}

/** The corners of the selected blur's gimbal, frame px. */
function maskCorners(container: HTMLElement): number[][] {
	return [...container.querySelectorAll("[data-testid=mask-gimbal] circle")].map((c) => [
		Math.round(Number(c.getAttribute("cx")) * 1000) / 1000,
		Math.round(Number(c.getAttribute("cy")) * 1000) / 1000,
	]);
}

describe("AnnotationLayer", () => {
	it("places an annotation on the frame, free of the footage", () => {
		const { frame, boxes } = layer([region({ space: "frame" })]);
		// Its box moves in the frame itself, so it can go over the padding.
		expect(boxes[0].parentElement).toBe(frame);
		expect(boxes[0].style.transform).toBe("translate(100px,100px)");
		expect(boxes[0].style.width).toBe("300px");
	});

	it("reads an annotation saved on the footage from the footage, but lets it roam the frame", () => {
		const { frame, boxes } = layer([region({})]);
		expect(boxes[0].parentElement).toBe(frame);
		// 100 + 10 % of 800, 50 + 20 % of 400: where it has always been drawn.
		expect(boxes[0].style.transform).toBe("translate(180px,130px)");
		expect(boxes[0].style.width).toBe("240px");
	});

	it("puts a blur's gimbal on the footage it hides, at rest", () => {
		const { view, boxes } = layer([region({ type: "blur", content: "" })], "a");
		expect(boxes).toHaveLength(0);
		// 100 + 10 % of 800 = 180, 50 + 20 % of 400 = 130; 30 % × 40 % of the footage.
		expect(maskCorners(view.container)).toEqual([
			[180, 130],
			[420, 130],
			[420, 290],
			[180, 290],
		]);
	});

	it("moves a blur's gimbal with the footage the compositor draws: zoomed, then leaning", () => {
		const { view } = layer([region({ type: "blur", content: "" })], "a");
		// The frame on screen shows the footage zoomed ×2 around its middle.
		act(() => publishFootageQuad([-0.3, -0.3, 1.3, -0.3, 1.3, 1.3, -0.3, 1.3], false));
		expect(maskCorners(view.container)).toEqual([
			[-140, 10],
			[340, 10],
			[340, 330],
			[-140, 330],
		]);
		// Leaning under the real camera: the gimbal is a quad, not a rect.
		act(() => publishFootageQuad([0.1, 0.1, 0.9, 0.2, 0.9, 0.8, 0.1, 0.9], true));
		const [tl, tr] = maskCorners(view.container);
		expect(tr[1]).toBeGreaterThan(tl[1]);
	});

	it("frames an arrow, not the empty box around it", () => {
		const arrow = region({
			type: "figure",
			space: "frame",
			position: { x: 10, y: 20 },
			size: { width: 60, height: 60 },
			figureData: { arrowDirection: "down-right", color: "#fff", strokeWidth: 8 },
		});
		const { boxes } = layer([arrow], "a");
		// Its box is 600 × 300 px: the arrow takes the height (scale 3), centred 150 px in, and
		// its strokes span 21..79 of 100.
		expect(boxes[0].style.transform).toBe(`translate(${100 + 150 + 63}px,${100 + 63}px)`);
		expect(boxes[0].style.width).toBe(`${58 * 3}px`);
		expect(boxes[0].style.height).toBe(`${58 * 3}px`);
	});
});
