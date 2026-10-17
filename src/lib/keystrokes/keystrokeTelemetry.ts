import type {
	AxcutClip,
	AxcutDocument,
	AxcutKeystrokeRange,
	AxcutTrimRange,
} from "../ai-edition/schema";
import { anchorRegionToClips } from "../ai-edition/timeline/timelineMap";
import { locateSourcePosition } from "../ai-edition/timeline/virtual-preview";

export type KeystrokePlatform = "darwin" | "win32" | "linux";

export interface KeystrokeTelemetrySample {
	/** Milliseconds from the start of the recording source. */
	timeMs: number;
	/** Key chord tokens in order, e.g. ["Cmd", "Shift", "P"] or ["Ctrl", "C"]. */
	keys: string[];
	/** Optional human-readable command label, e.g. "Command Palette" or "Copy". */
	label?: string;
	/** Explicit shortcut flag; when omitted, inferred from modifiers and special keys. */
	isShortcut?: boolean;
}

export interface KeystrokeTelemetryFile {
	version: 1;
	platform?: KeystrokePlatform;
	samples: KeystrokeTelemetrySample[];
}

export interface CoalescedKeystrokeSpan {
	startMs: number;
	endMs: number;
	/** Canonical "+"-joined key combo string, e.g. "Cmd+Shift+P". */
	keys: string;
	label?: string;
}

export interface KeystrokeTrackEvent {
	/** Source timestamp in seconds on the asset's recording clock. */
	atSec: number;
	/** Corresponding timestamp on the edited timeline, or null if not carried by any clip. */
	virtualSec: number | null;
	keys: string;
	label?: string;
	isShortcut: boolean;
	trimmed?: true;
}

export interface KeystrokeTrack {
	assetId: string;
	sampleCount: number;
	eventCount: number;
	events: KeystrokeTrackEvent[];
}

const MODIFIER_CANONICAL: Record<string, string> = {
	cmd: "Cmd",
	command: "Cmd",
	meta: "Cmd",
	super: "Win",
	win: "Win",
	windows: "Win",
	"⌘": "Cmd",
	ctrl: "Ctrl",
	control: "Ctrl",
	"⌃": "Ctrl",
	alt: "Alt",
	opt: "Option",
	option: "Option",
	"⌥": "Option",
	shift: "Shift",
	"⇧": "Shift",
	commandorcontrol: "CmdOrCtrl",
	cmdorctrl: "CmdOrCtrl",
};

const SPECIAL_KEY_CANONICAL: Record<string, string> = {
	enter: "Enter",
	return: "Enter",
	"↵": "Enter",
	esc: "Esc",
	escape: "Esc",
	tab: "Tab",
	"⇥": "Tab",
	space: "Space",
	" ": "Space",
	backspace: "Backspace",
	"⌫": "Backspace",
	delete: "Delete",
	del: "Delete",
	"⌦": "Delete",
	up: "Up",
	arrowup: "Up",
	"↑": "Up",
	down: "Down",
	arrowdown: "Down",
	"↓": "Down",
	left: "Left",
	arrowleft: "Left",
	"←": "Left",
	right: "Right",
	arrowright: "Right",
	"→": "Right",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pgup: "PageUp",
	pagedown: "PageDown",
	pgdn: "PageDown",
	plus: "+",
};

const MODIFIER_SET = new Set(["Cmd", "Win", "Ctrl", "Alt", "Option", "Shift", "CmdOrCtrl"]);

const STANDALONE_SHORTCUT_KEY_SET = new Set([
	"Enter",
	"Esc",
	"Tab",
	"F1",
	"F2",
	"F3",
	"F4",
	"F5",
	"F6",
	"F7",
	"F8",
	"F9",
	"F10",
	"F11",
	"F12",
]);

/**
 * Normalize a single key token into a canonical form ("Cmd", "Ctrl", "Shift", "P", "Enter", etc.).
 */
export function normalizeKeyToken(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const lower = trimmed.toLowerCase();
	if (MODIFIER_CANONICAL[lower]) return MODIFIER_CANONICAL[lower];
	if (SPECIAL_KEY_CANONICAL[lower]) return SPECIAL_KEY_CANONICAL[lower];
	if (/^f([1-9]|1[0-2])$/i.test(trimmed)) {
		return trimmed.toUpperCase();
	}
	if (trimmed.length === 1) {
		return trimmed.toUpperCase();
	}
	return trimmed;
}

/**
 * Parse either a "+"-separated shortcut string (e.g. "Cmd + Shift + P", "Ctrl++")
 * or an array of key strings into canonical key tokens.
 */
export function parseShortcutKeys(input: string | readonly string[]): string[] {
	if (Array.isArray(input)) {
		return input.map((k) => normalizeKeyToken(String(k))).filter(Boolean);
	}
	const raw = String(input).trim();
	if (!raw) return [];
	// Handle trailing "+" key (e.g. "Cmd++" or "Ctrl + +")
	const EndsWithPlusKey = raw.endsWith("++") || /\+\s*\+$/.test(raw);
	const base = EndsWithPlusKey ? raw.replace(/\+\s*\+$/, "+Plus") : raw;
	return base
		.split("+")
		.map((part) => normalizeKeyToken(part))
		.filter(Boolean);
}

/**
 * Format a canonical key token for display inside a keycap HUD badge on the given platform.
 */
export function formatKeycapLabel(token: string, platform: KeystrokePlatform = "win32"): string {
	const norm = normalizeKeyToken(token);
	if (platform === "darwin") {
		switch (norm) {
			case "Cmd":
			case "Win":
			case "CmdOrCtrl":
				return "⌘";
			case "Shift":
				return "⇧";
			case "Option":
			case "Alt":
				return "⌥";
			case "Ctrl":
				return "⌃";
			case "Enter":
				return "↵";
			case "Backspace":
				return "⌫";
			case "Delete":
				return "⌦";
			case "Tab":
				return "⇥";
			case "Esc":
				return "⎋";
			case "Up":
				return "↑";
			case "Down":
				return "↓";
			case "Left":
				return "←";
			case "Right":
				return "→";
			default:
				return norm;
		}
	}
	switch (norm) {
		case "CmdOrCtrl":
		case "Cmd":
			return "Ctrl";
		case "Option":
			return "Alt";
		case "Up":
			return "↑";
		case "Down":
			return "↓";
		case "Left":
			return "←";
		case "Right":
			return "→";
		default:
			return norm;
	}
}

/**
 * Format a shortcut combo string or token list into platform-aware keycap display labels.
 */
export function formatShortcutKeycaps(
	input: string | readonly string[],
	platform: KeystrokePlatform = "win32",
): string[] {
	return parseShortcutKeys(input).map((token) => formatKeycapLabel(token, platform));
}

/**
 * Determine whether a telemetry sample represents an intentional shortcut / command key
 * rather than plain prose / password typing (privacy-safe filtering).
 */
export function isShortcutSample(sample: KeystrokeTelemetrySample): boolean {
	if (typeof sample.isShortcut === "boolean") {
		return sample.isShortcut;
	}
	const tokens = parseShortcutKeys(sample.keys);
	if (tokens.length === 0) return false;
	const nonModifiers = tokens.filter((t) => !MODIFIER_SET.has(t));
	if (nonModifiers.length === 0) return false;
	const hasPrimaryModifier = tokens.some((t) => MODIFIER_SET.has(t) && t !== "Shift");
	if (hasPrimaryModifier) return true;
	const hasShift = tokens.includes("Shift");
	if (hasShift && nonModifiers.some((t) => t.length > 1)) return true;
	if (tokens.length === 1 && STANDALONE_SHORTCUT_KEY_SET.has(tokens[0])) return true;
	return false;
}

/**
 * Candidate sidecar paths for a recorded video file (`<video>.keys.json`).
 */
export function getKeystrokeTelemetryCandidates(videoPath: string): string[] {
	const trimmed = videoPath.trim();
	if (!trimmed) return [];
	const direct = `${trimmed}.keys.json`;
	const replaced = trimmed.replace(/\.[^/.\\]+$/, ".keys.json");
	return replaced !== trimmed && replaced !== direct ? [direct, replaced] : [direct];
}

/**
 * Filter raw keystroke telemetry samples and coalesce rapid repeats of the same shortcut
 * into timeline-ready HUD spans.
 */
export function coalesceKeystrokeSamplesToRegions(
	samples: readonly KeystrokeTelemetrySample[],
	options?: {
		shortcutsOnly?: boolean;
		holdMs?: number;
		mergeWindowMs?: number;
	},
): CoalescedKeystrokeSpan[] {
	const shortcutsOnly = options?.shortcutsOnly ?? true;
	const holdMs = Math.max(200, Math.round(options?.holdMs ?? 1600));
	const mergeWindowMs = Math.max(0, Math.round(options?.mergeWindowMs ?? 600));

	const sorted = [...samples]
		.filter((s) => Number.isFinite(s.timeMs) && s.timeMs >= 0)
		.filter((s) => !shortcutsOnly || isShortcutSample(s))
		.sort((a, b) => a.timeMs - b.timeMs);

	const out: CoalescedKeystrokeSpan[] = [];
	for (const sample of sorted) {
		const tokens = parseShortcutKeys(sample.keys);
		if (tokens.length === 0) continue;
		const canonicalCombo = tokens.join("+");
		const startMs = Math.round(sample.timeMs);
		const endMs = startMs + holdMs;
		const prev = out[out.length - 1];
		if (prev && prev.keys === canonicalCombo && startMs <= prev.startMs + mergeWindowMs) {
			prev.endMs = Math.max(prev.endMs, endMs);
			if (!prev.label && sample.label) {
				prev.label = sample.label;
			}
			continue;
		}
		out.push({
			startMs,
			endMs,
			keys: canonicalCombo,
			...(sample.label ? { label: sample.label } : {}),
		});
	}
	return out;
}

/**
 * Project recorded keystroke samples onto the edited timeline for agent inspection (`getKeystrokeTrack`).
 */
export function buildKeystrokeTrack(
	samples: readonly KeystrokeTelemetrySample[],
	clips: readonly AxcutClip[],
	trims: readonly AxcutTrimRange[],
	options?: {
		assetId?: string;
		shortcutsOnly?: boolean;
	},
): KeystrokeTrack {
	const assetId = options?.assetId ?? clips[0]?.assetId ?? "asset_1";
	const shortcutsOnly = options?.shortcutsOnly ?? true;

	const events: KeystrokeTrackEvent[] = [];
	for (const sample of samples) {
		if (!Number.isFinite(sample.timeMs) || sample.timeMs < 0) continue;
		const shortcut = isShortcutSample(sample);
		if (shortcutsOnly && !shortcut) continue;
		const tokens = parseShortcutKeys(sample.keys);
		if (tokens.length === 0) continue;

		const atSec = Math.round((sample.timeMs / 1000) * 1000) / 1000;
		const located = locateSourcePosition([...clips], atSec, assetId);
		const isTrimmed = trims.some(
			(t) => t.assetId === assetId && atSec >= t.startSec && atSec <= t.endSec,
		);
		events.push({
			atSec,
			virtualSec:
				located && Number.isFinite(located.virtualTimeSec)
					? Math.round(located.virtualTimeSec * 1000) / 1000
					: null,
			keys: tokens.join("+"),
			...(sample.label ? { label: sample.label } : {}),
			isShortcut: shortcut,
			...(isTrimmed ? { trimmed: true } : {}),
		});
	}

	return {
		assetId,
		sampleCount: samples.length,
		eventCount: events.length,
		events,
	};
}

/**
 * Parse raw JSON contents of a `.keys.json` sidecar file into normalized telemetry samples.
 */
export function parseKeystrokeSidecarJson(raw: string): KeystrokeTelemetrySample[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		const list = Array.isArray(parsed)
			? parsed
			: parsed &&
					typeof parsed === "object" &&
					Array.isArray((parsed as { samples?: unknown }).samples)
				? (parsed as { samples: unknown[] }).samples
				: [];
		const out: KeystrokeTelemetrySample[] = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			if (typeof rec.timeMs !== "number" || !Number.isFinite(rec.timeMs) || rec.timeMs < 0) {
				continue;
			}
			const keys = Array.isArray(rec.keys)
				? rec.keys.filter((k): k is string => typeof k === "string")
				: typeof rec.keys === "string"
					? parseShortcutKeys(rec.keys)
					: [];
			if (keys.length === 0) continue;
			out.push({
				timeMs: rec.timeMs,
				keys,
				...(typeof rec.label === "string" && rec.label.trim() ? { label: rec.label.trim() } : {}),
				...(typeof rec.isShortcut === "boolean" ? { isShortcut: rec.isShortcut } : {}),
			});
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Populate `document.keystrokeRanges` from recorded keystroke sidecar samples when the
 * document does not yet carry any keystroke ranges.
 */
export function seedKeystrokeRangesFromTelemetry(
	document: AxcutDocument,
	samples: readonly KeystrokeTelemetrySample[],
	createRegionId: (index: number) => string = (i) => `key_${i + 1}`,
): AxcutDocument {
	if ((document.keystrokeRanges?.length ?? 0) > 0) return document;
	if (document.timeline.clips.length === 0 || samples.length === 0) return document;
	const spans = coalesceKeystrokeSamplesToRegions(samples);
	if (spans.length === 0) return document;
	const seeded: AxcutKeystrokeRange[] = [];
	let seq = 0;
	for (const span of spans) {
		const anchored = anchorRegionToClips(
			document.timeline.clips,
			document.timeline.trimRanges,
			span.startMs,
			span.endMs,
			{
				keys: span.keys,
				...(span.label ? { label: span.label } : {}),
				position: "bottom-center" as const,
				theme: "dark" as const,
				size: "md" as const,
				platform: "win32" as const,
				source: "telemetry" as const,
			},
			() => createRegionId(seq++),
		);
		seeded.push(...anchored);
	}
	if (seeded.length === 0) return document;
	return {
		...document,
		keystrokeRanges: seeded,
	};
}
