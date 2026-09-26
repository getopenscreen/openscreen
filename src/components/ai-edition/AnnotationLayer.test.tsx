// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
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

function layer(annotations: AxcutAnnotationRegion[]) {
	const view = render(
		<AnnotationLayer
			annotations={annotations}
			selectedAnnotationId={null}
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
	return { frame, boxes };
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

	it("keeps a blur inside the footage it hides", () => {
		const { frame, boxes } = layer([region({ type: "blur", content: "" })]);
		const container = boxes[0].parentElement as HTMLElement;
		expect(container).not.toBe(frame);
		expect(container.style.left).toBe("100px");
		expect(container.style.width).toBe("800px");
		expect(boxes[0].style.transform).toBe("translate(80px,80px)");
	});
});
