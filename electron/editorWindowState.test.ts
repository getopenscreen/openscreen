import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clampRectToWorkArea,
	fitEditorRect,
	loadEditorWindowState,
	resolveEditorCreation,
	saveEditorWindowState,
	shouldTrackEditorWindow,
} from "./editorWindowState";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

function tmp(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "os-editor-win-"));
	temps.push(dir);
	return dir;
}

describe("editor window state", () => {
	it("returns null when the file is missing", () => {
		expect(loadEditorWindowState(tmp())).toBeNull();
	});

	it("clamps an off-screen rect onto the display workArea", () => {
		const clamped = clampRectToWorkArea(
			{ x: -4000, y: 50, width: 1200, height: 800 },
			{ x: 0, y: 0, width: 1920, height: 1080 },
		);
		expect(clamped.x).toBe(0);
		expect(clamped.y).toBe(50);
		expect(clamped.width).toBe(1200);
		expect(clamped.height).toBe(800);
	});

	it("still maximizes when nothing is saved, and never loads or saves the bench", () => {
		const missing = resolveEditorCreation({ isBench: false, saved: null });
		expect(missing.maximize).toBe(true);
		expect(missing.deferMaximize).toBe(false);
		expect(missing.persist).toBe(true);
		expect(missing.bounds).toEqual({ width: 1200, height: 800 });

		expect(shouldTrackEditorWindow({ windowType: "bench" })).toBe(false);
		const bench = resolveEditorCreation({ isBench: true, saved: null });
		expect(bench.persist).toBe(false);
		expect(bench.maximize).toBe(true);
		// Not even under Wayland: a maximize landing mid-run would resize what it measures.
		expect(resolveEditorCreation({ isBench: true, saved: null, wayland: true }).deferMaximize).toBe(
			false,
		);

		const dir = tmp();
		saveEditorWindowState(dir, { x: 10, y: 20, width: 1280, height: 720, maximized: false });
		expect(shouldTrackEditorWindow({ windowType: "bench" })).toBe(false);
		expect(shouldTrackEditorWindow({})).toBe(true);
	});

	it("round-trips a save through load", () => {
		const dir = tmp();
		const state = { x: 10, y: 20, width: 1280, height: 720, maximized: true };
		saveEditorWindowState(dir, state);
		expect(loadEditorWindowState(dir)).toEqual(state);
	});

	it("returns null on a corrupted file instead of throwing", () => {
		const dir = tmp();
		writeFileSync(path.join(dir, "editor-window.json"), "{ not json");
		expect(loadEditorWindowState(dir)).toBeNull();
	});

	it("rejects garbage fields rather than restoring a broken rect", () => {
		const dir = tmp();
		writeFileSync(
			path.join(dir, "editor-window.json"),
			JSON.stringify({ x: Number.NaN, y: 20, width: "1280", height: 720, maximized: false }),
		);
		expect(loadEditorWindowState(dir)).toBeNull();
	});

	it("rejects zero or negative dimensions instead of clamping them up", () => {
		// A width:0 record is garbage the app never writes; letting it through
		// would restore a min-size non-maximized window instead of the default.
		for (const dims of [
			{ width: 0, height: 720 },
			{ width: 1280, height: 0 },
			{ width: -1280, height: 720 },
		]) {
			const dir = tmp();
			writeFileSync(
				path.join(dir, "editor-window.json"),
				JSON.stringify({ x: 10, y: 20, ...dims, maximized: false }),
			);
			expect(loadEditorWindowState(dir)).toBeNull();
		}
	});

	it("rejects a non-boolean maximized rather than coercing it", () => {
		for (const maximized of ["true", 1, null, undefined]) {
			const dir = tmp();
			writeFileSync(
				path.join(dir, "editor-window.json"),
				JSON.stringify({ x: 10, y: 20, width: 1280, height: 720, maximized }),
			);
			expect(loadEditorWindowState(dir)).toBeNull();
		}
	});
});

describe("editor window state under Wayland", () => {
	// GNOME 46 on a 1920x1080 output: Chromium reports the whole output as the work area,
	// although the top bar and the dock take part of it.
	const OUTPUT = { x: 0, y: 0, width: 1920, height: 1080 };
	// What the v2.1.0-rc.1 pass found on disk after a maximized session (it grew each time).
	const DRIFTED = { x: 256, y: -10, width: 1440, height: 1121, maximized: true };

	it("keeps a tenth of each dimension free for panels it cannot see", () => {
		expect(fitEditorRect(DRIFTED, OUTPUT, true)).toEqual({
			x: 256,
			y: 54,
			width: 1440,
			height: 972,
		});
		// Elsewhere the reported work area is the real one, and is used whole.
		expect(fitEditorRect(DRIFTED, OUTPUT, false)).toEqual({
			x: 256,
			y: 0,
			width: 1440,
			height: 1080,
		});
		expect(fitEditorRect(DRIFTED, OUTPUT, false)).toEqual(clampRectToWorkArea(DRIFTED, OUTPUT));
	});

	it("leaves a rect that already fits as it is", () => {
		const rect = { x: 300, y: 120, width: 1200, height: 800 };
		expect(fitEditorRect(rect, OUTPUT, true)).toEqual(rect);
	});

	it("never fits below the editor's minimum size", () => {
		const fitted = fitEditorRect(
			{ x: 0, y: 0, width: 1024, height: 700 },
			{ x: 0, y: 0, width: 800, height: 600 },
			true,
		);
		expect(fitted.width).toBe(800);
		expect(fitted.height).toBe(600);
	});

	it("leaves placement to the compositor and maximizes only once mapped", () => {
		const saved = { ...fitEditorRect(DRIFTED, OUTPUT, true), maximized: true };
		const creation = resolveEditorCreation({ isBench: false, saved, wayland: true });
		expect(creation.bounds).toEqual({ width: 1440, height: 972 });
		expect(creation.maximize).toBe(true);
		expect(creation.deferMaximize).toBe(true);

		const fresh = resolveEditorCreation({ isBench: false, saved: null, wayland: true });
		expect(fresh.maximize).toBe(true);
		expect(fresh.deferMaximize).toBe(true);
	});

	it("keeps the saved position and the immediate maximize elsewhere", () => {
		const saved = { x: 10, y: 20, width: 1280, height: 720, maximized: true };
		const creation = resolveEditorCreation({ isBench: false, saved, wayland: false });
		expect(creation.bounds).toEqual({ x: 10, y: 20, width: 1280, height: 720 });
		expect(creation.deferMaximize).toBe(false);
	});

	it("still opens the default window for a hand-edited zero size or non-boolean maximized", () => {
		const dir = tmp();
		writeFileSync(
			path.join(dir, "editor-window.json"),
			JSON.stringify({ x: 10, y: 20, width: 0, height: 0, maximized: "yes" }),
		);
		const saved = loadEditorWindowState(dir);
		expect(saved).toBeNull();
		const creation = resolveEditorCreation({ isBench: false, saved, wayland: true });
		expect(creation.bounds).toEqual({ width: 1200, height: 800 });
		expect(creation.maximize).toBe(true);
	});
});
