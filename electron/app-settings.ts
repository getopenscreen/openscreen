import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CursorCaptureMode } from "../src/lib/recordingSession";

export interface RecordingPreferences {
	micEnabled: boolean;
	micDeviceId: string | null;
	micDeviceName: string | null;
	camEnabled: boolean;
	camDeviceId: string | null;
	camDeviceName: string | null;
	systemAudioEnabled: boolean;
	cursorCaptureMode: CursorCaptureMode;
	/** Display captures on macOS and Windows. Opt-in: on Windows the icons also leave the real desktop while recording. */
	hideDesktopIcons: boolean;
}

export const DEFAULT_RECORDING_PREFERENCES: RecordingPreferences = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: false,
	camDeviceId: null,
	camDeviceName: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
	hideDesktopIcons: false,
};

export interface RecordingSourceDescriptor {
	platform: NodeJS.Platform;
	kind: "screen" | "window";
	id: string;
	name: string;
	displayId: string | null;
}

/** How far the one-time "star the repo" ask has got on this installation. Local only: nothing
 *  here is reported anywhere, it exists so the ask can happen once and then never again. */
export interface StarPromptPreferences {
	successfulExports: number;
	dismissed: boolean;
}

export const DEFAULT_STAR_PROMPT: StarPromptPreferences = {
	successfulExports: 0,
	dismissed: false,
};

export interface AppSettingsSnapshot {
	recording: RecordingPreferences;
	lastSource: RecordingSourceDescriptor | null;
	starPrompt: StarPromptPreferences;
}

type RawSettings = Record<string, unknown>;

function readRaw(userData: string): RawSettings {
	try {
		const value: unknown = JSON.parse(
			readFileSync(path.join(userData, "recording-settings.json"), "utf8"),
		);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as RawSettings)
			: {};
	} catch {
		return {};
	}
}

function atomicWrite(userData: string, value: RawSettings): void {
	const destination = path.join(userData, "recording-settings.json");
	const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const nullableString = (value: unknown, fallback: string | null) =>
	value === null || typeof value === "string" ? value : fallback;

function parseRecording(raw: RawSettings): RecordingPreferences {
	return {
		micEnabled: bool(raw.micEnabled, DEFAULT_RECORDING_PREFERENCES.micEnabled),
		micDeviceId: nullableString(raw.micDeviceId, DEFAULT_RECORDING_PREFERENCES.micDeviceId),
		micDeviceName: nullableString(raw.micDeviceName, DEFAULT_RECORDING_PREFERENCES.micDeviceName),
		camEnabled: bool(raw.camEnabled, DEFAULT_RECORDING_PREFERENCES.camEnabled),
		camDeviceId: nullableString(raw.camDeviceId, DEFAULT_RECORDING_PREFERENCES.camDeviceId),
		camDeviceName: nullableString(raw.camDeviceName, DEFAULT_RECORDING_PREFERENCES.camDeviceName),
		systemAudioEnabled: bool(
			raw.systemAudioEnabled,
			DEFAULT_RECORDING_PREFERENCES.systemAudioEnabled,
		),
		cursorCaptureMode:
			raw.cursorCaptureMode === "system" || raw.cursorCaptureMode === "editable-overlay"
				? raw.cursorCaptureMode
				: DEFAULT_RECORDING_PREFERENCES.cursorCaptureMode,
		hideDesktopIcons: bool(raw.hideDesktopIcons, DEFAULT_RECORDING_PREFERENCES.hideDesktopIcons),
	};
}

function parseSource(value: unknown): RecordingSourceDescriptor | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (
		(candidate.platform !== "win32" &&
			candidate.platform !== "darwin" &&
			candidate.platform !== "linux") ||
		(candidate.kind !== "screen" && candidate.kind !== "window") ||
		typeof candidate.id !== "string" ||
		candidate.id.length === 0 ||
		typeof candidate.name !== "string" ||
		candidate.name.length === 0 ||
		!(candidate.displayId === null || typeof candidate.displayId === "string")
	) {
		return null;
	}
	return candidate as unknown as RecordingSourceDescriptor;
}

/** A hand-edited or truncated settings file must not make the prompt reappear forever, so a
 *  count that is not a finite, non-negative integer reads as 0 rather than as "keep asking".
 *  `dismissed` is sticky the same way: anything unparseable leaves it false, and the single
 *  offer point in `offersStarPrompt` caps the damage at one ask. */
function parseStarPrompt(value: unknown): StarPromptPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_STAR_PROMPT;
	const candidate = value as Record<string, unknown>;
	const count = candidate.successfulExports;
	return {
		successfulExports:
			typeof count === "number" && Number.isInteger(count) && count >= 0
				? count
				: DEFAULT_STAR_PROMPT.successfulExports,
		dismissed: bool(candidate.dismissed, DEFAULT_STAR_PROMPT.dismissed),
	};
}

function validateRecordingPatch(patch: Partial<RecordingPreferences>): void {
	const allowed = new Set(Object.keys(DEFAULT_RECORDING_PREFERENCES));
	for (const [key, value] of Object.entries(patch)) {
		if (!allowed.has(key)) throw new TypeError(`unknown recording preference: ${key}`);
		if (value === undefined) continue;
		if ((key.endsWith("Enabled") || key === "hideDesktopIcons") && typeof value !== "boolean") {
			throw new TypeError(`${key} must be a boolean`);
		}
		if (
			(key.endsWith("DeviceId") || key.endsWith("DeviceName")) &&
			value !== null &&
			typeof value !== "string"
		) {
			throw new TypeError(`${key} must be a string or null`);
		}
		if (key === "cursorCaptureMode" && value !== "system" && value !== "editable-overlay") {
			throw new TypeError("cursorCaptureMode is invalid");
		}
	}
}

export class AppSettingsStore {
	constructor(private readonly userData: string) {}

	getSnapshot(): AppSettingsSnapshot {
		const raw = readRaw(this.userData);
		return {
			recording: parseRecording(raw),
			lastSource: parseSource(raw.lastSource),
			starPrompt: parseStarPrompt(raw.starPrompt),
		};
	}

	setRecordingPreferences(patch: Partial<RecordingPreferences>): AppSettingsSnapshot {
		validateRecordingPatch(patch);
		const raw = readRaw(this.userData);
		const current = parseRecording(raw);
		const next = Object.fromEntries(
			Object.entries(patch).filter(([, value]) => value !== undefined),
		) as Partial<RecordingPreferences>;
		atomicWrite(this.userData, { ...raw, ...current, ...next });
		return this.getSnapshot();
	}

	setLastSource(source: RecordingSourceDescriptor | null): AppSettingsSnapshot {
		if (source !== null && !parseSource(source)) throw new TypeError("last source is invalid");
		const raw = readRaw(this.userData);
		atomicWrite(this.userData, { ...raw, lastSource: source });
		return this.getSnapshot();
	}

	/** Counts one finished export. Stops counting once the user has answered: past the single
	 *  offer point the number cannot change any decision, and a counter that keeps climbing for
	 *  the life of the install is a usage statistic nobody asked for. */
	recordSuccessfulExport(): StarPromptPreferences {
		const raw = readRaw(this.userData);
		const current = parseStarPrompt(raw.starPrompt);
		if (current.dismissed) return current;
		const next: StarPromptPreferences = {
			...current,
			successfulExports: current.successfulExports + 1,
		};
		atomicWrite(this.userData, { ...raw, starPrompt: next });
		return next;
	}

	/** Both answers land here — starring and declining are the same thing to this file. */
	dismissStarPrompt(): StarPromptPreferences {
		const raw = readRaw(this.userData);
		const next: StarPromptPreferences = { ...parseStarPrompt(raw.starPrompt), dismissed: true };
		atomicWrite(this.userData, { ...raw, starPrompt: next });
		return next;
	}
}
