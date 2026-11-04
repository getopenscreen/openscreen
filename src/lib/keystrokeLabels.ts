// Win32 virtual-key codes → display labels for the keystroke overlay.
//
// The C++ sampler reports raw `vkCode`s (`cursor-sampler.cpp`); naming and modifier
// composition live here, in the renderer. Modifiers compose a combo prefix on the next
// non-modifier key, keyviz-style; a modifier press on its own shows as a badge too, so
// the user sees Ctrl happen even if nothing follows it.

export const VK_SHIFT = 0x10;
export const VK_CONTROL = 0x11;
export const VK_MENU = 0x12;
export const VK_LWIN = 0x5b;
export const VK_RWIN = 0x5c;

const MODIFIER_VKS: readonly number[] = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN];

/** Combo prefix order, the one keyviz uses: Ctrl · Alt · Shift · Win. */
const MODIFIER_ORDER: readonly [number, string][] = [
	[VK_CONTROL, "Ctrl"],
	[VK_MENU, "Alt"],
	[VK_SHIFT, "Shift"],
	[VK_LWIN, "Win"],
	[VK_RWIN, "Win"],
];

const NAMED_KEYS: Record<number, string> = {
	0x08: "Backspace",
	0x09: "Tab",
	0x0d: "Enter",
	0x13: "Pause",
	0x14: "CapsLock",
	0x1b: "Esc",
	0x20: "Space",
	0x21: "PageUp",
	0x22: "PageDown",
	0x23: "End",
	0x24: "Home",
	0x25: "←",
	0x26: "↑",
	0x27: "→",
	0x28: "↓",
	0x2d: "Ins",
	0x2e: "Del",
};

const OEM_KEYS: Record<number, string> = {
	0xba: ";",
	0xbb: "=",
	0xbc: ",",
	0xbd: "-",
	0xbe: ".",
	0xbf: "/",
	0xc0: "`",
	0xdb: "[",
	0xdc: "\\",
	0xdd: "]",
	0xde: "'",
};

/** Labels for one virtual key, without modifiers; `null` for keys the overlay hides. */
export function baseKeyLabel(vk: number): string | null {
	if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
	if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
	if (vk >= 0x60 && vk <= 0x69) return `Num${vk - 0x60}`;
	if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x70 + 1}`;
	if (vk === VK_LWIN || vk === VK_RWIN) return "Win";
	if (vk === VK_SHIFT) return "Shift";
	if (vk === VK_CONTROL) return "Ctrl";
	if (vk === VK_MENU) return "Alt";
	return NAMED_KEYS[vk] ?? OEM_KEYS[vk] ?? null;
}

/** `true` when the key is one of the composing modifiers the overlay tracks. */
export function isModifierVk(vk: number): boolean {
	return MODIFIER_VKS.includes(vk);
}

/**
 * The badge label for a keydown: the held modifiers as a `Ctrl+Alt+Delete`-style combo,
 * or the bare key. `heldModifiers` carries the modifier keys still down, as tracked by
 * the overlay from the same event stream.
 */
export function badgeLabel(vk: number, heldModifiers: ReadonlySet<number>): string | null {
	const base = baseKeyLabel(vk);
	if (base === null) return null;
	if (isModifierVk(vk)) return base;

	const prefix = MODIFIER_ORDER.filter(([modVk]) => heldModifiers.has(modVk)).map(
		([, label]) => label,
	);
	return [...prefix, base].join("+");
}
