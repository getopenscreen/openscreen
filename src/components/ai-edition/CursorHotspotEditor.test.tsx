// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { defaultCursorHotspot } from "@/lib/cursor/cursorThemes";
import { CursorHotspotEditor } from "./CursorHotspotEditor";

beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? "en" : null),
			setItem: vi.fn(),
		},
	});
});
afterEach(cleanup);

function setup(kind: "arrow" | "pointer" | "text" = "arrow") {
	const onApply = vi.fn().mockResolvedValue(true);
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<CursorHotspotEditor
				draft={{
					setId: "custom:test",
					kind,
					image: "data:image/png;base64,QQ==",
					hotspot: defaultCursorHotspot(kind),
				}}
				onClose={onClose}
				onApply={onApply}
			/>
		</I18nProvider>,
	);
	const image = screen.getByRole("img", {
		name: kind === "arrow" ? "Arrow" : kind === "pointer" ? "Hand" : "Text",
	});
	Object.defineProperties(image, { naturalWidth: { value: 200 }, naturalHeight: { value: 100 } });
	fireEvent.load(image);
	return { onApply, onClose, plane: screen.getByRole("button", { name: "Hotspot" }) };
}

describe("CursorHotspotEditor", () => {
	it.each([
		"arrow",
		"pointer",
		"text",
	] as const)("starts and resets at the default %s point", (kind) => {
		setup(kind);
		fireEvent.change(screen.getByRole("spinbutton", { name: "X %" }), { target: { value: "99" } });
		fireEvent.click(screen.getByRole("button", { name: "Reset to default hotspot" }));
		expect(
			Number((screen.getByRole("spinbutton", { name: "X %" }) as HTMLInputElement).value),
		).toBeCloseTo(defaultCursorHotspot(kind).x * 100, 2);
	});
	it("moves by a source-image pixel with arrow keys, clamps, and applies one point", async () => {
		const { plane, onApply } = setup();
		fireEvent.change(screen.getByRole("spinbutton", { name: "X %" }), { target: { value: "50" } });
		fireEvent.change(screen.getByRole("spinbutton", { name: "Y %" }), { target: { value: "50" } });
		fireEvent.keyDown(plane, { key: "ArrowRight" });
		fireEvent.keyDown(plane, { key: "ArrowDown", shiftKey: true });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(onApply).toHaveBeenCalledWith({ x: 0.505, y: 0.6 }));
	});
	it("maps dragging to the actual image rectangle, including its edges", () => {
		const { plane } = setup();
		vi.spyOn(plane, "getBoundingClientRect").mockReturnValue({
			left: 10,
			top: 20,
			width: 260,
			height: 130,
		} as DOMRect);
		Object.assign(plane, {
			setPointerCapture: vi.fn(),
			hasPointerCapture: () => true,
			releasePointerCapture: vi.fn(),
		});
		const pointer = (type: string, x: number, y: number) => {
			const event = new Event(type, { bubbles: true });
			Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: y });
			fireEvent(plane, event);
		};
		pointer("pointerdown", 140, 85);
		expect((screen.getByRole("spinbutton", { name: "X %" }) as HTMLInputElement).value).toBe("50");
		expect((screen.getByRole("spinbutton", { name: "Y %" }) as HTMLInputElement).value).toBe("50");
		pointer("pointermove", -50, 500);
		expect((screen.getByRole("spinbutton", { name: "X %" }) as HTMLInputElement).value).toBe("0");
		expect((screen.getByRole("spinbutton", { name: "Y %" }) as HTMLInputElement).value).toBe("100");
	});
	it("starts at matching 100% scale and zooms to 200% without changing the point", async () => {
		const { onApply } = setup();
		const slider = screen.getByRole("slider", { name: "Preview zoom" }) as HTMLInputElement;
		const preview = screen.getByRole("img", { name: "Preview" });
		expect([slider.min, slider.max, slider.value]).toEqual(["100", "200", "100"]);
		expect(preview.style.width).toBe("260px");
		expect(preview.style.height).toBe("130px");
		const anchor = preview.style.transform;
		fireEvent.change(slider, {
			target: { value: "200" },
		});
		expect(preview.style.width).toBe("520px");
		expect(preview.style.height).toBe("260px");
		expect(preview.style.transform).toBe(anchor);
		expect(screen.getByText("200 %")).toBeTruthy();
		fireEvent.click(screen.getByRole("checkbox", { name: "Dark background" }));
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() => expect(onApply).toHaveBeenCalledWith(defaultCursorHotspot("arrow")));
	});
	it("keeps the dialog open when saving fails", async () => {
		const { onApply, onClose } = setup();
		onApply.mockResolvedValue(false);
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		await screen.findByRole("alert");
		expect(onClose).not.toHaveBeenCalled();
	});
	it("blocks applying an image that cannot be decoded", () => {
		setup();
		fireEvent.error(screen.getByRole("img", { name: "Arrow" }));
		expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(screen.getByRole("alert")).toBeTruthy();
	});
});
