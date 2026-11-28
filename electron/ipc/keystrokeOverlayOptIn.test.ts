// The keystroke overlay installs a low-level keyboard hook that observes every
// key typed during a take. It is off by default and opt-in per setting, and the
// helper must only install the hook when asked. The gate lives in handlers.ts
// (needs the whole Electron runtime) and in the native session's argv building,
// so we assert these invariants against source the way sibling tests do.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...segs: string[]) => fs.readFileSync(path.join(root, ...segs), "utf8");

const handlers = read("electron/ipc/handlers.ts");
const session = read("electron/native-bridge/cursor/recording/windowsNativeRecordingSession.ts");
const cpp = read("electron/native/wgc-capture/src/cursor-sampler.cpp");
const defaults = read("electron/app-settings.ts");
const types = read("electron/ipc/handlers.ts");

function fnBody(source: string, name: string): string {
	const start = source.indexOf(`async function ${name}(`);
	expect(start, `no ${name}`).toBeGreaterThan(-1);
	const end = source.indexOf("\n}\n", start);
	return source.slice(start, end === -1 ? undefined : end);
}

describe("keystroke overlay is opt-in", () => {
	it("defaults off in both preference stores", () => {
		expect(defaults).toMatch(/keystrokeOverlayEnabled: false/);
		// handlers.ts carries the mirrored RecordingPrefs default.
		expect(types).toMatch(/keystrokeOverlayEnabled: false/);
	});

	it("only starts the overlay and hook when the option is on", () => {
		const register = handlers.slice(handlers.indexOf("const setAppRecording"));
		const gate = register.slice(0, register.indexOf("const appSettings"));
		expect(gate).toContain("recording && recordingPrefs.get().keystrokeOverlayEnabled");
		expect(gate).toContain("showKeystrokeOverlay");
		expect(gate).toContain("startKeystrokeKeyCapture");
		// Stop always tears down, even if the toggle was switched off mid-take.
		expect(gate).toContain("hideKeystrokeOverlay");
		expect(gate).toContain("stopKeystrokeKeyCapture");
	});

	it("gates the cursor session's key callback on the option", () => {
		const body = fnBody(handlers, "startCursorRecording");
		expect(body).toContain("onKeyEvent: keystrokeKeysEnabled");
		expect(body).toContain("captureKeys: keystrokeKeysEnabled");
	});

	it("seeds and updates the module-level gate from the durable prefs", () => {
		expect(handlers).toContain(
			"keystrokeKeysEnabled = recordingPrefs.get().keystrokeOverlayEnabled",
		);
		expect(handlers).toContain("keystrokeKeysEnabled = next.keystrokeOverlayEnabled");
	});

	it("passes --keys to the helper only when captureKeys is set", () => {
		expect(session).toContain("this.options.captureKeys");
		expect(session).toContain('args.push("--keys")');
	});

	it("installs the native keyboard hook only with --keys", () => {
		expect(cpp).toContain('std::string(argv[3]) == "--keys"');
		// The hook call must be inside the opt-in branch, not unconditional.
		const optIn = cpp.indexOf("if (captureKeys)");
		const hook = cpp.indexOf("SetWindowsHookEx(WH_KEYBOARD_LL");
		expect(optIn, "no captureKeys branch").toBeGreaterThan(-1);
		expect(hook, "no keyboard hook").toBeGreaterThan(-1);
		expect(hook).toBeGreaterThan(optIn);
	});
});
