// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LayoutPicker } from "./LayoutPicker";

vi.mock("@/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));

describe("layout selection", () => {
	it("offers five visual presets and reports only the chosen preset", () => {
		const onSelect = vi.fn();
		render(<LayoutPicker value="dual-frame" hasCamera onSelect={onSelect} />);
		expect(screen.getAllByRole("button")).toHaveLength(5);
		expect(
			screen.getByRole("button", { name: "layouts.dual-frame" }).getAttribute("aria-pressed"),
		).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "layouts.camera-only" }));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("camera-only");
	});
	it("explains unavailable camera presets and keeps screen-only usable", () => {
		const onSelect = vi.fn();
		render(<LayoutPicker value="no-webcam" hasCamera={false} onSelect={onSelect} />);
		const camera = screen.getByRole("button", { name: "layouts.camera-only" }) as HTMLButtonElement;
		expect(camera.disabled).toBe(true);
		expect(camera.title).toBe("layouts.noCamera");
		fireEvent.click(camera);
		expect(onSelect).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "layouts.no-webcam" }));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("no-webcam");
	});
});
