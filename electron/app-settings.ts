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
};

export interface RecordingSourceDescriptor {
	platform: NodeJS.Platform;
	kind: "screen" | "window";
	id: string;
	name: string;
	displayId: string | null;
}

export interface AppSettingsSnapshot {
	recording: RecordingPreferences;
	lastSource: RecordingSourceDescriptor | null;
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

function validateRecordingPatch(patch: Partial<RecordingPreferences>): void {
	const allowed = new Set(Object.keys(DEFAULT_RECORDING_PREFERENCES));
	for (const [key, value] of Object.entries(patch)) {
		if (!allowed.has(key)) throw new TypeError(`unknown recording preference: ${key}`);
		if (value === undefined) continue;
		if (key.endsWith("Enabled") && typeof value !== "boolean") {
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
}
