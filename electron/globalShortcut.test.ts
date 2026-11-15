import { beforeEach, describe, expect, it, vi } from "vitest";

const registered = new Set<string>();
const register = vi.fn((accelerator: string) => {
	if (!grants(accelerator)) return false;
	registered.add(accelerator);
	return true;
});
let grants: (accelerator: string) => boolean = () => true;

vi.mock("electron", () => ({
	globalShortcut: {
		register: (accelerator: string) => register(accelerator),
		unregister: (accelerator: string) => registered.delete(accelerator),
		unregisterAll: () => registered.clear(),
	},
}));
vi.mock("./ipc/handlers", () => ({ SHORTCUTS_FILE: "/nonexistent/shortcuts.json" }));

const OPEN_APP = { key: "o", ctrl: true, shift: true };

async function freshModule() {
	vi.resetModules();
	return import("./globalShortcut");
}

beforeEach(() => {
	registered.clear();
	register.mockClear();
	grants = () => true;
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("registerOpenAppShortcut", () => {
	// The rc.1 pass on GNOME Wayland: the session grants no global shortcut, so Save in
	// the shortcuts dialog failed on Open App every time and no binding could change.
	it("does not fail where the session grants no global shortcut, and says Open App is unavailable", async () => {
		grants = () => false;
		const shortcuts = await freshModule();

		expect(shortcuts.registerOpenAppShortcut(OPEN_APP, () => undefined)).toBe(true);
		expect(shortcuts.isGlobalShortcutAvailable()).toBe(false);
		// A later Save asks nothing more of a session that already said no.
		register.mockClear();
		expect(shortcuts.registerOpenAppShortcut({ ...OPEN_APP, key: "p" }, () => undefined)).toBe(
			true,
		);
		expect(register).not.toHaveBeenCalled();
	});

	it("still fails a key another app holds, where the session grants others", async () => {
		grants = (accelerator) => accelerator !== "CommandOrControl+Shift+O";
		const shortcuts = await freshModule();

		expect(shortcuts.registerOpenAppShortcut(OPEN_APP, () => undefined)).toBe(false);
		expect(shortcuts.isGlobalShortcutAvailable()).toBe(true);
		// The probe is released, not kept.
		expect([...registered]).toEqual([]);
	});

	it("keeps the old binding when the new key is taken", async () => {
		const shortcuts = await freshModule();
		expect(shortcuts.registerOpenAppShortcut(OPEN_APP, () => undefined)).toBe(true);

		grants = (accelerator) => accelerator !== "CommandOrControl+Shift+P";
		expect(shortcuts.registerOpenAppShortcut({ ...OPEN_APP, key: "p" }, () => undefined)).toBe(
			false,
		);
		expect([...registered]).toEqual(["CommandOrControl+Shift+O"]);
		expect(shortcuts.isGlobalShortcutAvailable()).toBe(true);
	});
});
