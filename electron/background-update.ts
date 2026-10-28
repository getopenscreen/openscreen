import type { UpdateOutcome } from "./auto-updater";

/** How far a background-discovered update may go on its own. None of them opens a dialog: a
 *  background find only ever becomes the update button (`UpdateBadge`). `download-and-install`
 *  also installs the downloaded update when the app quits, silently and without relaunching,
 *  unless `shouldInstallOnQuit` says not now. Closing the last window quits this app, so that
 *  quit is an ordinary one, and the installer is already on disk by then. */
export type UpdateMode = "notify" | "download" | "download-and-install";

/** Keeping users current is the point, so the default goes all the way. A mode the user picked in
 *  the tray is stored and wins. */
export const DEFAULT_UPDATE_MODE: UpdateMode = "download-and-install";
/** A minute after launch, then every six hours. Most sessions end long before 24 hours, so a check
 *  that only ran once a day of uptime almost never ran at all. */
export const BACKGROUND_UPDATE_FIRST_CHECK_MS = 60 * 1000;
export const BACKGROUND_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What a background find shows: a button in the HUD and the editor, and a tray item. */
export interface UpdateBadge {
	/** `available`: found, not downloaded, so the click downloads it (or opens the release page,
	 *  when only the release lookup worked). `ready`: downloaded, so the click restarts into it. */
	state: "available" | "ready";
	version: string;
}

/** May the downloaded update install while the app quits? Only in the mode that says so; only
 *  where it needs no rights the user would be prompted for on the way out (UAC for a per-machine
 *  NSIS install, pkexec for deb/rpm/pacman); and never while a CLI run is alive, because the NSIS
 *  installer ends every process of this executable, `openscreen mcp` driven by an agent included.
 *  The update button does not ask this: a click is the user deciding. */
export function shouldInstallOnQuit(input: {
	mode: UpdateMode;
	needsElevation: boolean;
	cliSessionAlive: boolean;
}): boolean {
	return input.mode === "download-and-install" && !input.needsElevation && !input.cliSessionAlive;
}

export function parseUpdateMode(raw: unknown): UpdateMode {
	if (raw === "notify" || raw === "download" || raw === "download-and-install") return raw;
	return DEFAULT_UPDATE_MODE;
}

export function shouldStartBackgroundUpdateTimer(input: {
	isPackaged: boolean;
	ownsItsUpdates: boolean;
}): boolean {
	return input.isPackaged && input.ownsItsUpdates;
}

export type BackgroundUpdatePlan =
	| { action: "none" }
	| { action: "notify-available"; version: string }
	| { action: "download"; version: string }
	| { action: "download-and-install"; version: string };

/** Background path: never plan a "you are current" dialog. */
export function planBackgroundUpdate(input: {
	outcome: UpdateOutcome;
	mode: UpdateMode;
}): BackgroundUpdatePlan {
	if (input.outcome.kind !== "downloaded") return { action: "none" };
	switch (input.mode) {
		case "notify":
			return { action: "notify-available", version: input.outcome.version };
		case "download":
			return { action: "download", version: input.outcome.version };
		case "download-and-install":
			return { action: "download-and-install", version: input.outcome.version };
	}
}

export function shouldQuitAndInstallAfterRestartPrompt(response: number): boolean {
	return response === 0;
}

/** The failure carries the download error: the dialog that reports it shows
 *  `error.message` as detail, and collapsing the outcome to a bare string
 *  here is exactly how that detail once got lost between the helper and the
 *  caller. */
export type DownloadAndInstallResult =
	| { status: "failed"; error: Error }
	| { status: "unavailable" }
	| { status: "blocked" }
	| { status: "cancelled" }
	| { status: "installed" };

export async function runUnblockedDownloadAndInstall(deps: {
	download: () => Promise<UpdateOutcome>;
	blocked: () => string | null;
	confirmRestart: () => Promise<number>;
	install: () => Promise<void>;
}): Promise<DownloadAndInstallResult> {
	const downloaded = await deps.download();
	if (downloaded.kind === "failed") return { status: "failed", error: downloaded.error };
	// `downloadSelfUpdate` only ever reports downloaded|failed today, but the
	// UpdateOutcome type admits current|unsupported — neither of which may
	// reach the restart prompt, let alone quitAndInstall.
	if (downloaded.kind !== "downloaded") return { status: "unavailable" };
	if (deps.blocked()) return { status: "blocked" };
	const choice = await deps.confirmRestart();
	if (!shouldQuitAndInstallAfterRestartPrompt(choice)) return { status: "cancelled" };
	await deps.install();
	return { status: "installed" };
}
