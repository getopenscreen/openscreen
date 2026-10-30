// In-place updates for the artifacts we build and can replace: NSIS, the macOS .app, AppImage,
// deb, rpm and pacman. Everything else — Microsoft Store, Flathub, Snap, Nix — is filtered out
// before we get here by `platformOwnsUpdates`; see install-channel.ts for why that is a hard
// rule rather than a best effort.
//
// electron-updater replaces the WHOLE payload, not just the JS: the Swift/C++ capture helpers,
// the Rust compositor addon, the ffmpeg libraries and the whisper binaries all ship inside the
// bundle and come along. What does NOT come along is anything under userData — recordings,
// projects, and the ~500 MB STT model — which is exactly what we want.

import { spawnSync } from "node:child_process";
import { app } from "electron";
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

/** Loaded lazily: importing electron-updater costs startup time on every launch, and the
 *  channels that cannot use it must not pay for it at all. */
async function getUpdater() {
	const { autoUpdater } = await import("electron-updater");
	// Never surprise the user with a 240 MB download or an install they did not ask for.
	// `window-all-closed` quits this app, and the HUD is a window — with the default
	// `autoInstallOnAppQuit` simply closing the HUD would kick off an installer.
	//
	// Reapplied on every call rather than set once behind a flag: these are three property
	// writes, so memoising them buys nothing measurable, and a "configured" flag would mean
	// anything that later reset them is never corrected — while making the guarantee hold only
	// for whichever caller happened to come first.
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.logger = null;
	return autoUpdater;
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

/** Where electron-builder's NSIS installer records an install: `Software\<UUID v5 of appId>`,
 *  under HKLM per machine and HKCU per user. auto-updater.test.ts pins it to the appId. */
export const NSIS_INSTALL_KEY = "Software\\5b412b41-8d8b-5faf-b557-de4fe681e5fc";

function hasNsisInstall(hive: "HKLM" | "HKCU"): boolean {
	const key = `${hive}\\${NSIS_INSTALL_KEY}`;
	const args = ["query", key, "/v", "InstallLocation", "/reg:64"];
	// Exit 1 is reg's "key not found". Anything else, reg itself failing to run included, counts
	// as present, so a doubt keeps the wizard rather than risking the wrong copy.
	return spawnSync("reg", args, { windowsHide: true }).status !== 1;
}

/** Whether the installer can run with /S. Without it the assisted NSIS installer shows its whole
 *  wizard (#1437). A silent upgrade of a per-machine install still elevates itself
 *  (UAC_RunElevated in electron-builder's installer.nsi), so the user sees only UAC. But /S
 *  always picks the per-machine copy when one exists, so with both a per-user and a per-machine
 *  install it could update the copy that is not running: there, let the wizard ask. */
export function installsSilently(
	platform: NodeJS.Platform = process.platform,
	hasInstall: (hive: "HKLM" | "HKCU") => boolean = hasNsisInstall,
): boolean {
	return platform !== "win32" || !(hasInstall("HKLM") && hasInstall("HKCU"));
}

/** Quit and hand over to the installer. Callers MUST have checked `blockedFromInstalling`. */
export async function installSelfUpdate(): Promise<void> {
	const autoUpdater = await getUpdater();
	// isForceRunAfter=true so the app comes back up.
	autoUpdater.quitAndInstall(installsSilently(), true);
}
