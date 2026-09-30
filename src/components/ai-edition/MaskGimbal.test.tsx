// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rectQuad } from "@/lib/ai-edition/annotations/footageQuad";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { MaskGimbal } from "./MaskGimbal";

// The gimbal reads the pointer against its own box: the whole 1000 × 500 frame.
beforeAll(() => {
	vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(
		DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 500 }),
	);
});
afterAll(() => vi.restoreAllMocks());

const BLUR = {
	id: "b",
	startMs: 0,
	endMs: 1000,
	type: "blur",
	content: "",
	position: { x: 10, y: 20 },
	size: { width: 30, height: 40 },
	style: {},
	zIndex: 1,
	blurData: { type: "mosaic", shape: "rectangle", color: "white", intensity: 12, blockSize: 12 },
} as unknown as AxcutAnnotationRegion;

// The footage zoomed ×2 around its middle: one unit of footage is 1.6 units of frame.
const ZOOMED = rectQuad(-0.3, -0.3, 1.6, 1.6);

function gimbal() {
	const onChange = vi.fn();
	const onCommit = vi.fn();
	const onClick = vi.fn();
	const { container } = render(
		<MaskGimbal
			annotation={BLUR}
			quad={ZOOMED}
			frameWidth={1000}
			frameHeight={500}
			onChange={onChange}
			onCommit={onCommit}
			onClick={onClick}
			zIndex={1}
		/>,
	);
	return { container, onChange, onCommit, onClick };
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 });

describe("MaskGimbal", () => {
	it("moves the mask by what the pointer covers of the footage, zoomed", () => {
		const { container, onChange, onCommit } = gimbal();
		const body = container.querySelector("polygon") as SVGPolygonElement;
		fireEvent.pointerDown(body, at(300, 200));
		// 160 px of a 1000 px frame, zoomed ×2 over 1.6: a tenth of the footage.
		fireEvent.pointerMove(body, at(460, 200));
		fireEvent.pointerUp(body, at(460, 200));
		const last = onChange.mock.lastCall?.[1];
		expect(last.position.x).toBeCloseTo(20, 9);
		expect(last.position.y).toBeCloseTo(20, 9);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("resizes from a corner while the opposite one stays", () => {
		const { container, onChange } = gimbal();
		const bottomRight = container.querySelectorAll("circle")[2];
		fireEvent.pointerDown(bottomRight, at(0, 0));
		// Frame point (0.5, 0.5) is the middle of the footage.
		fireEvent.pointerMove(bottomRight, at(500, 250));
		const last = onChange.mock.lastCall?.[1];
		expect(last.position).toEqual({ x: 10, y: 20 });
		expect(last.size.width).toBeCloseTo(40, 9);
		expect(last.size.height).toBeCloseTo(30, 9);
	});

	it("selects through on a click that moves nothing", () => {
		const { container, onChange, onCommit, onClick } = gimbal();
		const body = container.querySelector("polygon") as SVGPolygonElement;
		fireEvent.pointerDown(body, at(300, 200));
		fireEvent.pointerUp(body, at(300, 200));
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
		expect(onClick).toHaveBeenCalledWith("b");
	});
});
