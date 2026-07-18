import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CursorMotionEditorOverlay } from "./CursorMotionEditorOverlay";

describe("CursorMotionEditorOverlay", () => {
	it("renders locked anchors and exposes one draggable curve handle", () => {
		render(
			<CursorMotionEditorOverlay
				width={800}
				height={450}
				trajectory={[
					{ x: 80, y: 225 },
					{ x: 400, y: 80 },
					{ x: 720, y: 225 },
				]}
				controlPoint={{ x: 400, y: 80 }}
				onControlPointChange={vi.fn()}
				onControlPointCommit={vi.fn()}
			/>,
		);

		expect(screen.getByLabelText("Cursor motion path editor")).not.toBeNull();
		expect(screen.getByLabelText("Motion curve handle").getAttribute("cx")).toBe("400");
	});

	it("previews pointer movement and commits once when released", () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		render(
			<CursorMotionEditorOverlay
				width={800}
				height={450}
				trajectory={[
					{ x: 80, y: 225 },
					{ x: 720, y: 225 },
				]}
				controlPoint={{ x: 400, y: 80 }}
				onControlPointChange={onChange}
				onControlPointCommit={onCommit}
			/>,
		);

		const handle = screen.getByLabelText("Motion curve handle");
		Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
		Object.defineProperty(handle, "hasPointerCapture", { value: vi.fn(() => true) });
		Object.defineProperty(handle, "releasePointerCapture", { value: vi.fn() });
		fireEvent.pointerDown(handle, {
			pointerId: 7,
			isPrimary: true,
			pointerType: "mouse",
			button: 0,
			clientX: 410,
			clientY: 90,
		});
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: 430, clientY: 120 });
		fireEvent.pointerUp(handle, { pointerId: 7, clientX: 430, clientY: 120 });

		expect(onChange).toHaveBeenLastCalledWith(430, 120);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});
});
