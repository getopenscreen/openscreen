import fs from "node:fs/promises";
import { globalShortcut } from "electron";
import { type ShortcutBinding } from "../src/lib/shortcuts";
import { SHORTCUTS_FILE } from "./ipc/handlers";

const DEFAULT_OPEN_APP_BINDING: ShortcutBinding = { key: "o", ctrl: true, shift: true };

// Maps KeyboardEvent.key values to Electron accelerator key names
const KEY_TO_ACCELERATOR: Record<string, string> = {
	" ": "Space",
	"+": "Plus",
	"-": "numsub",
	"*": "nummult",
	"/": "numdiv",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	escape: "Escape",
	enter: "Return",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
};

function bindingToAccelerator(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("CommandOrControl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	const acceleratorKey = KEY_TO_ACCELERATOR[keyLower] ?? binding.key.toUpperCase();
	parts.push(acceleratorKey);

	return parts.join("+");
}

let currentAccelerator: string | null = null;
/**
 * False once a failed registration showed that this session grants no global shortcut
 * at all, as on GNOME Wayland: there `Ctrl+Shift+O` failed at every launch and every
 * Save of the shortcuts dialog with it, so no binding could ever be changed.
 */
let globalShortcutsGranted = true;

/**
 * Whether the session grants global shortcuts at all, asked only once a registration
 * failed: a key nothing uses, so a refusal of it means "none", not "this one is taken".
 */
function sessionGrantsGlobalShortcuts(): boolean {
	const probe = "CommandOrControl+Alt+Shift+F24";
	if (!globalShortcut.register(probe, () => undefined)) {
		return false;
	}
	globalShortcut.unregister(probe);
	return true;
}

/** Whether Open App can be a global shortcut in this session. */
export function isGlobalShortcutAvailable(): boolean {
	return globalShortcutsGranted;
}

/**
 * Registers Open App. False means the key is taken and the user should pick another;
 * a session that grants no global shortcut returns true, since no key would do.
 */
export function registerOpenAppShortcut(binding: ShortcutBinding, onTrigger: () => void): boolean {
	const accelerator = bindingToAccelerator(binding);

	if (!globalShortcutsGranted || accelerator === currentAccelerator) {
		return true;
	}

	// Register the new shortcut before unregistering the old, so a failure leaves the old binding intact
	const success = globalShortcut.register(accelerator, onTrigger);

	if (success) {
		if (currentAccelerator) {
			globalShortcut.unregister(currentAccelerator);
		}
		currentAccelerator = accelerator;
		console.log(`Global shortcut registered: ${accelerator}`);
		return true;
	}
	if (!currentAccelerator && !sessionGrantsGlobalShortcuts()) {
		globalShortcutsGranted = false;
		console.warn(
			`This session grants no global shortcut; Open App (${accelerator}) is unavailable.`,
		);
		return true;
	}
	console.warn(`Failed to register global shortcut: ${accelerator}`);
	return false;
}

export async function loadAndRegisterGlobalShortcut(onTrigger: () => void): Promise<void> {
	try {
		const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
		const shortcuts = JSON.parse(data);
		const binding = shortcuts.openApp || DEFAULT_OPEN_APP_BINDING;
		registerOpenAppShortcut(binding, onTrigger);
	} catch {
		registerOpenAppShortcut(DEFAULT_OPEN_APP_BINDING, onTrigger);
	}
}

export function unregisterAllGlobalShortcuts(): void {
	globalShortcut.unregisterAll();
}
