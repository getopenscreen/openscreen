// In-place updates for the artifacts we build and can replace: NSIS, the macOS .app, AppImage,
// deb, rpm and pacman. Everything else — Microsoft Store, Flathub, Snap, Nix — is filtered out
// before we get here by `platformOwnsUpdates`; see install-channel.ts for why that is a hard
// rule rather than a best effort.
//
// electron-updater replaces the WHOLE payload, not just the JS: the Swift/C++ capture helpers,
// the Rust compositor addon, the ffmpeg libraries and the whisper binaries all ship inside the
// bundle and come along. What does NOT come along is anything under userData — recordings,
// projects, and the ~500 MB STT model — which is exactly what we want.

import { mkdtempSync, rmdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { AppUpdater } from "electron-updater";
import type { InstallChannel } from "./install-channel";
import { ownsItsUpdates } from "./install-channel";

export type UpdateOutcome =
	| { kind: "unsupported" }
	| { kind: "current" }
	| { kind: "downloaded"; version: string }
	| { kind: "failed"; error: Error };

/** Reasons an install must not start right now. Kept separate from "can this channel update at
 *  all" because these are transient — the answer changes as the user works. */
export interface InstallReadiness {
	recording: boolean;
	/** macOS only. Gatekeeper runs a quarantined app from a read-only image (App Translocation),
	 *  where Squirrel cannot replace the bundle; worse, an app can BECOME translocated after an
	 *  update and then never update again. */
	inApplicationsFolder: boolean;
	platform: NodeJS.Platform;
}

/** Pure so the veto can be tested without an updater, a Mac, or a recording. */
export function blockedFromInstalling(state: InstallReadiness): string | null {
	if (state.recording) return "recording";
	if (state.platform === "darwin" && !state.inApplicationsFolder) return "not-in-applications";
	return null;
}

/** Whether a downloaded update installs as the app quits. Off unless the user's update mode asks
 *  for it, and main turns it back off at quit when `shouldInstallOnQuit` says not now. */
let installOnQuit = false;
/** Set once electron-updater has been imported, so `setInstallOnQuit` can reach it synchronously
 *  from `before-quit` without importing it there. */
let loadedUpdater: AppUpdater | null = null;

/** electron-updater reads the flag twice. At download, where only a `true` registers its quit
 *  handler (and, on macOS, hands the update to Squirrel, which then installs on any quit), and at
 *  quit, where the handler skips the install if it is `false` by then. */
export function setInstallOnQuit(enabled: boolean): void {
	installOnQuit = enabled;
	if (loadedUpdater) loadedUpdater.autoInstallOnAppQuit = enabled;
}

/** Loaded lazily: importing electron-updater costs startup time on every launch, and the
 *  channels that cannot use it must not pay for it at all. */
async function getUpdater() {
	const { autoUpdater } = await import("electron-updater");
	// Never download behind the user's back from here: every download is an explicit
	// `downloadSelfUpdate`, made by the update mode or by a click.
	//
	// Reapplied on every call rather than set once behind a flag: these are three property
	// writes, so memoising them buys nothing measurable, and a "configured" flag would mean
	// anything that later reset them is never corrected — while making the guarantee hold only
	// for whichever caller happened to come first.
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = installOnQuit;
	autoUpdater.logger = null;
	loadedUpdater = autoUpdater;
	return autoUpdater;
}

/** Would replacing this install prompt for rights the user has to grant? deb, rpm and pacman always
 *  go through pkexec. For NSIS and AppImage the install directory is probed by writing into it,
 *  because on Windows `fs.access` ignores ACLs and calls Program Files writable. macOS is not
 *  asked: Squirrel installs there. */
export function installNeedsElevation(
	channel: InstallChannel,
	execPath: string = process.execPath,
	appImage: string | undefined = process.env.APPIMAGE,
): boolean {
	if (channel === "deb" || channel === "rpm" || channel === "pacman") return true;
	if (channel === "dmg") return false;
	const dir = path.dirname(channel === "appimage" && appImage ? appImage : execPath);
	try {
		rmdirSync(mkdtempSync(path.join(dir, ".update-probe-")));
		return false;
	} catch {
		return true;
	}
}

/** Is an update available, and can this install apply it itself? */
export async function checkForSelfUpdate(channel: InstallChannel): Promise<UpdateOutcome> {
	if (!ownsItsUpdates(channel) || !app.isPackaged) return { kind: "unsupported" };
	try {
		const autoUpdater = await getUpdater();
		const result = await autoUpdater.checkForUpdates();
		// null when no feed resolved; equal versions come back with no downloadPromise.
		const version = result?.updateInfo?.version;
		if (!version || version === app.getVersion()) return { kind: "current" };
		return { kind: "downloaded", version };
	} catch (error) {
		// A missing or malformed feed is the expected failure on any release published before
		// this shipped. The caller falls back to opening the release page, which still works.
		return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
	}
}

/** Download the pending update. Separate from the check so the user approves the transfer. */
export async function downloadSelfUpdate(): Promise<UpdateOutcome> {
	try {
		const autoUpdater = await getUpdater();
		await autoUpdater.downloadUpdate();
		return { kind: "downloaded", version: app.getVersion() };
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
	}
}

/** Quit and hand over to the installer. Callers MUST have checked `blockedFromInstalling`. */
export async function installSelfUpdate(): Promise<void> {
	const autoUpdater = await getUpdater();
	// isSilent=false so a per-machine Windows install can show its elevation prompt: a silent
	// upgrade of a Program Files install hits UAC and, if the user dismisses it, quits having
	// done nothing. isForceRunAfter=true so the app comes back up.
	autoUpdater.quitAndInstall(false, true);
}
