// Persist/restore the editor window's normal bounds and maximized flag.
// The export bench must never load or save this file — it measures a 1200×800
// maximized window on purpose.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_EDITOR_SIZE = { width: 1200, height: 800 };
export const EDITOR_WINDOW_MIN = { width: 800, height: 600 };

export interface EditorWindowRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface EditorWindowState extends EditorWindowRect {
	maximized: boolean;
}

export interface DisplayWorkArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function editorWindowStatePath(userData: string): string {
	return path.join(userData, "editor-window.json");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function parseEditorWindowState(raw: unknown): EditorWindowState | null {
	if (!raw || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	// Zero/negative dimensions and a non-boolean `maximized` are garbage the
	// app never writes; restoring them would clamp into a small non-maximized
	// window instead of the documented default. Reject the record whole.
	if (
		!isFiniteNumber(rec.x) ||
		!isFiniteNumber(rec.y) ||
		!isFiniteNumber(rec.width) ||
		!isFiniteNumber(rec.height) ||
		rec.width <= 0 ||
		rec.height <= 0 ||
		typeof rec.maximized !== "boolean"
	) {
		return null;
	}
	return {
		x: rec.x,
		y: rec.y,
		width: rec.width,
		height: rec.height,
		maximized: rec.maximized,
	};
}

export function loadEditorWindowState(userData: string): EditorWindowState | null {
	const file = editorWindowStatePath(userData);
	if (!existsSync(file)) return null;
	try {
		return parseEditorWindowState(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

export function saveEditorWindowState(userData: string, state: EditorWindowState): void {
	try {
		writeFileSync(editorWindowStatePath(userData), `${JSON.stringify(state)}\n`, "utf8");
	} catch {
		// Best-effort; a failed write must not block close.
	}
}

export function clampRectToWorkArea(
	rect: EditorWindowRect,
	workArea: DisplayWorkArea,
	min = EDITOR_WINDOW_MIN,
): EditorWindowRect {
	const width = Math.min(Math.max(rect.width, min.width), Math.max(min.width, workArea.width));
	const height = Math.min(Math.max(rect.height, min.height), Math.max(min.height, workArea.height));
	const maxX = workArea.x + Math.max(0, workArea.width - width);
	const maxY = workArea.y + Math.max(0, workArea.height - height);
	return {
		x: Math.min(Math.max(rect.x, workArea.x), maxX),
		y: Math.min(Math.max(rect.y, workArea.y), maxY),
		width,
		height,
	};
}

/**
 * Share of each dimension of the reported work area left to panels under Wayland.
 *
 * Wayland tells a client nothing about panels, so Chromium reports the whole output as the
 * work area — GNOME's 32 px top bar and a docked Ubuntu dock included. A normal window as tall
 * as the output then runs under them, with its bottom edge off screen, and un-maximizing
 * returns to exactly that. A tenth of each dimension (108 px of a 1080 px output) covers a top
 * bar and a dock; the compositor still places the window, so only its size is at stake.
 */
export const WAYLAND_PANEL_RESERVE = 0.1;

/** Clamps a normal rect to the work area — under Wayland, to the share panels leave free. */
export function fitEditorRect(
	rect: EditorWindowRect,
	workArea: DisplayWorkArea,
	wayland: boolean,
): EditorWindowRect {
	if (!wayland) return clampRectToWorkArea(rect, workArea);
	// Centred: the panels may sit on any edge.
	const width = Math.floor(workArea.width * (1 - WAYLAND_PANEL_RESERVE));
	const height = Math.floor(workArea.height * (1 - WAYLAND_PANEL_RESERVE));
	return clampRectToWorkArea(rect, {
		x: workArea.x + Math.floor((workArea.width - width) / 2),
		y: workArea.y + Math.floor((workArea.height - height) / 2),
		width,
		height,
	});
}

/**
 * How long a Wayland editor waits, once the compositor has focused it, before maximizing.
 *
 * Electron 41's Chromium leaves a window stuck maximized — its restore button and
 * `unmaximize()` do nothing — when it asks for maximize while the compositor still has a
 * configure without the maximized state on its way: the configure latches Chromium's
 * "restore to maximized" flag (electron/electron#53063, fixed in Electron 42+ only). Focus
 * means the window is mapped, and the configures that come with mapping (activated, suspended)
 * arrive within a frame or two of it; this waits them out with room to spare.
 */
export const WAYLAND_MAXIMIZE_SETTLE_MS = 200;

export function shouldTrackEditorWindow(query: Record<string, string>): boolean {
	return query.windowType !== "bench";
}

export function resolveEditorCreation(input: {
	isBench: boolean;
	saved: EditorWindowState | null;
	/** Chromium's Wayland backend: positions are fiction, and maximize must wait for the map. */
	wayland?: boolean;
}): {
	bounds: { x?: number; y?: number; width: number; height: number };
	maximize: boolean;
	/** Maximize only once the compositor has mapped the window (see WAYLAND_MAXIMIZE_SETTLE_MS). */
	deferMaximize: boolean;
	persist: boolean;
} {
	if (input.isBench) {
		// The bench never un-maximizes, and a maximize that lands mid-run would resize what it
		// measures: it keeps the immediate one everywhere.
		return {
			bounds: { ...DEFAULT_EDITOR_SIZE },
			maximize: true,
			deferMaximize: false,
			persist: false,
		};
	}
	const deferMaximize = input.wayland === true;
	if (!input.saved) {
		return { bounds: { ...DEFAULT_EDITOR_SIZE }, maximize: true, deferMaximize, persist: true };
	}
	const { width, height } = input.saved;
	return {
		// A Wayland client cannot place its window and never learns where the compositor put
		// it, so a saved position is whatever Chromium assumed: leave placement to the compositor.
		bounds: input.wayland
			? { width, height }
			: { x: input.saved.x, y: input.saved.y, width, height },
		maximize: input.saved.maximized,
		deferMaximize,
		persist: true,
	};
}
