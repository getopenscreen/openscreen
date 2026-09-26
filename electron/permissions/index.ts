import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	app,
	type BrowserWindow,
	desktopCapturer,
	ipcMain,
	shell,
	systemPreferences,
} from "electron";
import { macSystemPickerEnabled } from "../native-bridge/screen/macPickerSession";
import {
	findMacScreenAccessHelperPath,
	readMacScreenCaptureAccess,
} from "../native-bridge/screen/macScreenAccess";
import { createPermissionsWindow } from "../windows";
import {
	createMacPermissions,
	type MacPermissions,
	type NotedKind,
	type PermissionKind,
	type PermissionsStore,
} from "./macPermissions";

export type { PermissionKind, PermissionsSnapshot } from "./macPermissions";

const STORE_FILE = "permissions.json";

/**
 * The app's own note of which prompts it has raised on this Mac: the one thing macOS
 * will not say. Only ever used to choose between raising a prompt and opening System
 * Settings -- never as the answer to whether a permission is held, which is always
 * read live.
 *
 * A stale note (the user reset TCC with `tccutil`) costs the prompt, and the user gets
 * the System Settings pane instead, which still works. A lost one costs a request macOS
 * silently ignores. Both leave the user with something to act on.
 */
interface StoreFile {
	requested?: Partial<Record<NotedKind, string>>;
	completedAt?: string;
}

function createFileStore(userData: string): PermissionsStore {
	const file = path.join(userData, STORE_FILE);
	let state: StoreFile = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") {
			state = parsed as StoreFile;
		}
	} catch {
		// Missing or unreadable: nothing has been asked yet.
	}

	const save = (next: StoreFile) => {
		state = next;
		const temporary = `${file}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			renameSync(temporary, file);
		} catch (error) {
			// Best effort: the in-memory note still gets the rest of this launch right.
			console.warn("[permissions] failed to persist the permissions note:", error);
		} finally {
			rmSync(temporary, { force: true });
		}
	};

	return {
		hasRequested: (kind) => typeof state.requested?.[kind] === "string",
		markRequested: (kind) =>
			save({ ...state, requested: { ...state.requested, [kind]: new Date().toISOString() } }),
		isCompleted: () => typeof state.completedAt === "string",
		markCompleted: () => {
			if (typeof state.completedAt !== "string") {
				save({ ...state, completedAt: new Date().toISOString() });
			}
		},
	};
}

/**
 * How long to wait on the system-audio prompt. A person is reading it; this only bounds a
 * helper that hung, so a stuck request cannot pin the permissions window's button forever.
 */
const SYSTEM_AUDIO_REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * Raises macOS' "record system audio" prompt from the capture helper, which the app spawns
 * and TCC therefore attributes to the app. Resolves once the helper exits -- when the prompt
 * was answered, or at once when it had been already.
 */
function requestSystemAudioAccess(): Promise<void> {
	const helperPath = findMacScreenAccessHelperPath();
	if (!helperPath) {
		console.warn("[permissions] no capture helper to request system audio with");
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const child = spawn(helperPath, ["--request-system-audio"], { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill();
			resolve();
		}, SYSTEM_AUDIO_REQUEST_TIMEOUT_MS);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		child.once("error", (error) => {
			console.warn("[permissions] system audio request failed:", error);
			done();
		});
		child.once("close", done);
	});
}

function macosMajor(): number {
	if (process.platform !== "darwin") {
		return 0;
	}
	const major = Number.parseInt(process.getSystemVersion().split(".")[0] ?? "", 10);
	return Number.isFinite(major) ? major : 0;
}

let permissions: MacPermissions | null = null;

export function getMacPermissions(): MacPermissions {
	permissions ??= createMacPermissions({
		platform: process.platform,
		macosMajor: macosMajor(),
		systemPickerOwnsScreen: macSystemPickerEnabled,
		requestSystemAudio: requestSystemAudioAccess,
		probeScreen: async () => {
			const probe = await readMacScreenCaptureAccess();
			return probe.status === "granted" || probe.status === "denied"
				? { answered: true, granted: probe.granted }
				: { answered: false };
		},
		appScreenGranted: () => systemPreferences.getMediaAccessStatus("screen") === "granted",
		accessibilityTrusted: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
		mediaStatus: (kind) => systemPreferences.getMediaAccessStatus(kind),
		askForMedia: (kind) => systemPreferences.askForMediaAccess(kind),
		// Raised from THIS process, through Chromium's own call to
		// CGRequestScreenCaptureAccess, so TCC files the grant under the app bundle.
		// The call rejects within milliseconds while the permission is missing, so nothing
		// is learned from awaiting it; the answer is read back from a fresh process.
		raiseScreenPrompt: () => {
			desktopCapturer
				.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
				.catch(() => undefined);
		},
		openExternal: (url) => shell.openExternal(url),
		store: createFileStore(app.getPath("userData")),
	});
	return permissions;
}

let permissionsWindow: BrowserWindow | null = null;

export function showPermissionsWindow(): void {
	if (process.platform !== "darwin") {
		return;
	}
	if (permissionsWindow && !permissionsWindow.isDestroyed()) {
		permissionsWindow.show();
		permissionsWindow.focus();
		return;
	}
	permissionsWindow = createPermissionsWindow();
	permissionsWindow.on("closed", () => {
		permissionsWindow = null;
		const permissions = getMacPermissions();
		void permissions
			.read()
			.then((snapshot) => permissions.noteWindowClosed(snapshot))
			.catch(() => undefined);
	});
}

/** Opens the permissions window at launch when it belongs there (see shouldShowAtLaunch). */
export async function showPermissionsWindowIfNeeded(): Promise<void> {
	// Not in the headless e2e runs either: there is no one to answer, and the probe would
	// hold the window open behind every spec.
	if (process.platform !== "darwin" || process.env["HEADLESS"] === "true") {
		return;
	}
	const permissions = getMacPermissions();
	if (permissions.shouldShowAtLaunch(await permissions.read())) {
		showPermissionsWindow();
	}
}

const KINDS: readonly PermissionKind[] = [
	"screen",
	"accessibility",
	"microphone",
	"camera",
	"systemAudio",
];
const isKind = (value: unknown): value is PermissionKind => KINDS.includes(value as PermissionKind);

export function registerPermissionsIpc(): void {
	ipcMain.handle("permissions:get", () => getMacPermissions().read());
	ipcMain.handle("permissions:request", (_event, kind: unknown) =>
		isKind(kind) ? getMacPermissions().request(kind) : undefined,
	);
	ipcMain.handle("permissions:open-settings", (_event, kind: unknown) =>
		isKind(kind) ? getMacPermissions().openSettings(kind) : undefined,
	);
	ipcMain.handle("permissions:relaunch", () => {
		app.relaunch();
		app.quit();
	});
	ipcMain.handle("permissions:close", () => {
		if (permissionsWindow && !permissionsWindow.isDestroyed()) {
			permissionsWindow.close();
		}
	});
}
