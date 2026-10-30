import type { UpdateOutcome } from "./auto-updater";

// One behaviour, the one Codex and VS Code have: check in the background, download in the
// background, then show an update button. Nothing installs until the user clicks it, so no update
// ever interrupts a take, an export or an agent's `openscreen mcp` session on its own, and no
// install ever asks for an admin password on the way out.

/** A minute after launch, then every six hours. Most sessions end long before 24 hours, so a check
 *  that only ran once a day of uptime almost never ran at all. */
export const BACKGROUND_UPDATE_FIRST_CHECK_MS = 60 * 1000;
export const BACKGROUND_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What a background find shows: a button in the HUD and the editor, and a tray item. */
export interface UpdateBadge {
	/** `ready`: downloaded, so the click restarts into it. `available`: the background download
	 *  failed, so the click downloads it again; or the self-updater failed and only the release
	 *  lookup found it, so the click opens the release page. */
	state: "available" | "ready";
	version: string;
}

export function shouldStartBackgroundUpdateTimer(input: {
	isPackaged: boolean;
	ownsItsUpdates: boolean;
}): boolean {
	return input.isPackaged && input.ownsItsUpdates;
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
