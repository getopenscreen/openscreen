// Convert an external mouse track (CSV of t,x,y plus optional click timestamps)
// into the version-2 cursor sidecar (`<video>.cursor.json`) that export, the
// editor, and `--auto-zoom` already consume.
//
// Node-pure: no Electron import, so `openscreen cursor import` and the unit
// tests can run it without booting Chromium.

import fs from "node:fs/promises";
import path from "node:path";
import type { CursorRecordingData, CursorRecordingSample } from "../../src/native/contracts";
import { clamp } from "../../src/utils/math";
import { CURSOR_TELEMETRY_VERSION } from "./cursorSidecar";

export type MouseCsvRow = { t: number; x: number; y: number };

const INTERACTION_ORDER: Record<string, number> = {
	move: 0,
	click: 1,
	"double-click": 1,
	"right-click": 1,
	"middle-click": 1,
	mouseup: 2,
};

export interface BuildCursorSidecarOptions {
	mouse: MouseCsvRow[];
	clicks?: number[];
	width: number;
	height: number;
	/** How long a synthesized click is held, in milliseconds. Default 60. */
	clickHoldMs?: number;
}

export function parseMouseCsv(text: string): MouseCsvRow[] {
	const lines = text.split(/\r?\n/);
	if (lines.length === 0) {
		return [];
	}
	const header = lines[0].split(",").map((cell) => cell.trim().toLowerCase());
	const tIndex = header.findIndex((name) => name === "t" || name === "time" || name === "time_s");
	const xIndex = header.findIndex((name) => name === "x");
	const yIndex = header.findIndex((name) => name === "y");
	if (xIndex < 0 || yIndex < 0) {
		throw new Error("mouse CSV must have columns x and y (and t, time, or time_s)");
	}
	const rows: MouseCsvRow[] = [];
	for (const line of lines.slice(1)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const cells = trimmed.split(",");
		const t = tIndex >= 0 ? Number(cells[tIndex]) : 0;
		const x = Number(cells[xIndex]);
		const y = Number(cells[yIndex]);
		if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) {
			continue;
		}
		rows.push({ t, x, y });
	}
	rows.sort((a, b) => a.t - b.t);
	return rows;
}

/** One seconds-timestamp per line; a leading `#` comments the line out. Extra CSV columns are ignored. */
export function parseClickTimestamps(text: string): number[] {
	const out: number[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const value = Number(trimmed.split(",")[0]);
		if (Number.isFinite(value)) {
			out.push(value);
		}
	}
	return out.sort((a, b) => a - b);
}

function cursorAt(samples: MouseCsvRow[], t: number): { x: number; y: number } {
	if (samples.length === 0) {
		return { x: 0.5, y: 0.5 };
	}
	if (t <= samples[0].t) {
		return { x: samples[0].x, y: samples[0].y };
	}
	if (t >= samples[samples.length - 1].t) {
		return { x: samples[samples.length - 1].x, y: samples[samples.length - 1].y };
	}
	let lo = 0;
	let hi = samples.length - 1;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >> 1;
		if (samples[mid].t <= t) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	const a = samples[lo];
	const b = samples[hi];
	if (b.t <= a.t) {
		return { x: a.x, y: a.y };
	}
	const u = (t - a.t) / (b.t - a.t);
	return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) };
}

export function buildCursorSidecar(options: BuildCursorSidecarOptions): CursorRecordingData {
	const width = Math.max(1, options.width);
	const height = Math.max(1, options.height);
	const clickHoldMs = options.clickHoldMs ?? 60;
	const samples: CursorRecordingSample[] = [];

	const add = (
		tSeconds: number,
		x: number,
		y: number,
		interactionType: "move" | "click" | "mouseup",
	) => {
		samples.push({
			timeMs: Math.max(0, Math.round(tSeconds * 1000)),
			cx: clamp(x / width, 0, 1),
			cy: clamp(y / height, 0, 1),
			visible: true,
			interactionType,
		});
	};

	for (const row of options.mouse) {
		add(row.t, row.x, row.y, "move");
	}
	for (const clickT of options.clicks ?? []) {
		const point = cursorAt(options.mouse, clickT);
		add(clickT, point.x, point.y, "click");
		add(clickT + clickHoldMs / 1000, point.x, point.y, "mouseup");
	}

	const dedup = new Map<string, CursorRecordingSample>();
	for (const sample of samples) {
		dedup.set(`${sample.timeMs}:${sample.interactionType ?? "move"}`, sample);
	}
	const ordered = [...dedup.values()].sort((a, b) => {
		if (a.timeMs !== b.timeMs) {
			return a.timeMs - b.timeMs;
		}
		return (
			(INTERACTION_ORDER[a.interactionType ?? "move"] ?? 0) -
			(INTERACTION_ORDER[b.interactionType ?? "move"] ?? 0)
		);
	});

	return {
		version: CURSOR_TELEMETRY_VERSION,
		provider: "none",
		samples: ordered,
		assets: [],
	};
}

export function defaultCursorSidecarPath(videoPath: string): string {
	return `${videoPath}.cursor.json`;
}

export interface WriteCursorSidecarFromCsvOptions {
	csvPath: string;
	clicksPath?: string | null;
	videoPath?: string | null;
	outputPath?: string | null;
	width: number;
	height: number;
	clickHoldMs?: number;
}

export async function writeCursorSidecarFromCsv(
	options: WriteCursorSidecarFromCsvOptions,
): Promise<{ outputPath: string; data: CursorRecordingData }> {
	if (!options.outputPath && !options.videoPath) {
		throw new Error("provide --output or --video");
	}
	const outputPath = options.outputPath ?? defaultCursorSidecarPath(options.videoPath as string);
	const csvText = await fs.readFile(options.csvPath, "utf8");
	const clicksText = options.clicksPath ? await fs.readFile(options.clicksPath, "utf8") : "";
	const data = buildCursorSidecar({
		mouse: parseMouseCsv(csvText),
		clicks: clicksText ? parseClickTimestamps(clicksText) : [],
		width: options.width,
		height: options.height,
		clickHoldMs: options.clickHoldMs,
	});
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	return { outputPath, data };
}
