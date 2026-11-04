import { describe, expect, it } from "vitest";
import { badgeLabel, baseKeyLabel, isModifierVk, VK_CONTROL, VK_SHIFT } from "./keystrokeLabels";

describe("keystrokeLabels", () => {
	it("names letters, digits and function keys off the vk code ranges", () => {
		expect(baseKeyLabel(0x41)).toBe("A");
		expect(baseKeyLabel(0x31)).toBe("1");
		expect(baseKeyLabel(0x70)).toBe("F1");
		expect(baseKeyLabel(0x87)).toBe("F24");
		expect(baseKeyLabel(0x64)).toBe("Num4");
	});

	it("names the named and OEM keys the overlay is likely to see", () => {
		expect(baseKeyLabel(0x0d)).toBe("Enter");
		expect(baseKeyLabel(0x1b)).toBe("Esc");
		expect(baseKeyLabel(0x20)).toBe("Space");
		expect(baseKeyLabel(0xba)).toBe(";");
		expect(baseKeyLabel(0xdb)).toBe("[");
	});

	it("returns null for keys the overlay hides, and names every modifier", () => {
		expect(baseKeyLabel(0xa6)).toBeNull(); // media key, no label
		expect(baseKeyLabel(0x10)).toBe("Shift");
		expect(baseKeyLabel(0x11)).toBe("Ctrl");
		expect(baseKeyLabel(0x12)).toBe("Alt");
		expect(baseKeyLabel(0x5b)).toBe("Win");
	});

	it("composes held modifiers in Ctrl, Alt, Shift, Win order", () => {
		expect(badgeLabel(0x43, new Set([VK_CONTROL, VK_SHIFT]))).toBe("Ctrl+Shift+C");
		expect(badgeLabel(0x2e, new Set([VK_CONTROL]))).toBe("Ctrl+Del");
		expect(badgeLabel(0x43, new Set())).toBe("C");
	});

	it("shows modifiers alone and never double-prefixes one", () => {
		expect(badgeLabel(0x10, new Set([VK_SHIFT]))).toBe("Shift");
		expect(badgeLabel(0x11, new Set())).toBe("Ctrl");
		expect(isModifierVk(0x11)).toBe(true);
		expect(isModifierVk(0x41)).toBe(false);
	});
});
