// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeystrokeOverlay } from "./KeystrokeOverlay";

type KeyListener = (vk: number, modifiers: number) => void;

describe("KeystrokeOverlay", () => {
	let pushKey: KeyListener = () => undefined;

	beforeEach(() => {
		window.electronAPI = {
			...window.electronAPI,
			onKeystrokeKey: (listener: KeyListener) => {
				pushKey = listener;
				return () => undefined;
			},
		} as typeof window.electronAPI;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a modifier followed by a regular key as one combined badge", () => {
		const { container } = render(<KeystrokeOverlay />);

		// The sampler sends the modifier press, then the letter with the modifier
		// bit held at event time. The overlay must compose "Ctrl+C", not two badges.
		act(() => pushKey(0x11, 2)); // Ctrl down (modifier bit for itself)
		act(() => pushKey(0x43, 2)); // C down while Ctrl held

		expect(container.textContent).toContain("Ctrl+C");
	});

	it("composes from the event-time modifier mask alone", () => {
		const { container } = render(<KeystrokeOverlay />);

		// No modifier keydown was ever delivered, but C arrives with Ctrl in its
		// mask (e.g. the first key seen mid-take). The mask alone must still yield
		// a combo rather than a bare "C".
		act(() => pushKey(0x43, 2));
		expect(container.textContent).toContain("Ctrl+C");
	});

	it("leaves an unmodified key as a bare badge", () => {
		const { container } = render(<KeystrokeOverlay />);
		act(() => pushKey(0x43, 0));
		expect(container.textContent).toBe("C");
	});

	it("keeps a standalone modifier visible and clears the combo after the next key", () => {
		const { container } = render(<KeystrokeOverlay />);
		act(() => pushKey(0x11, 2)); // Ctrl alone
		expect(container.textContent).toContain("Ctrl");

		act(() => pushKey(0x43, 2)); // Ctrl+C
		expect(container.textContent).toContain("Ctrl+C");

		// A later key with no modifier must not inherit the released Ctrl.
		act(() => pushKey(0x44, 0)); // D, no modifiers
		expect(container.textContent).toContain("D");
		expect(container.textContent).not.toContain("Ctrl+D");
	});
});
