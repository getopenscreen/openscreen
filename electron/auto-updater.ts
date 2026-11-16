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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { InstallChannel } from "./install-channel";
import { ownsItsUpdates } from "./install-channel";
import { requestMacMcpShutdown } from "./mcp/mac-update-shutdown";

export type UpdateOutcome =
	| { kind: "unsupported" }
	| { kind: "current" }
	| { kind: "downloaded"; version: string }
	| { kind: "failed"; error: Error };

/** Reasons an install must not start right now. Kept separate from "can this channel update at
 *  all" because these are transient — the answer changes as the user works. */
export interface InstallReadiness {
	recording: boolean;
	/** A Windows handoff cannot wait on the editor's close prompt with input disabled. */
	editorHasUnsavedChanges?: boolean;
	/** macOS only. Gatekeeper runs a quarantined app from a read-only image (App Translocation),
	 *  where Squirrel cannot replace the bundle; worse, an app can BECOME translocated after an
	 *  update and then never update again. */
	inApplicationsFolder: boolean;
	platform: NodeJS.Platform;
}

/** Pure so the veto can be tested without an updater, a Mac, or a recording. */
export function blockedFromInstalling(state: InstallReadiness): string | null {
	if (state.recording) return "recording";
	if (state.platform === "win32" && state.editorHasUnsavedChanges) return "unsaved-changes";
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

function nsisInstallStatus(hive: "HKLM" | "HKCU"): number | null {
	const key = `${hive}\\${NSIS_INSTALL_KEY}`;
	const args = ["query", key, "/v", "InstallLocation", "/reg:64"];
	const { status } = spawnSync("reg", args, { windowsHide: true });
	if (status !== 1) return status;
	// reg's exit 1 means any failure, including access denied. Confirm absence by
	// successfully enumerating the parent, without parsing localized error text.
	const parent = spawnSync("reg", ["query", `${hive}\\Software`, "/reg:64"], {
		windowsHide: true,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (parent.status !== 0) return null;
	const root = hive === "HKLM" ? "HKEY_LOCAL_MACHINE" : "HKEY_CURRENT_USER";
	const keys = parent.stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase());
	return keys.includes(`${root}\\${NSIS_INSTALL_KEY}`.toLowerCase()) ? null : 1;
}

/** Where an install lives, from `reg export`: it writes UTF-16, where `reg query` prints in the
 *  console code page and would garble a non-ASCII user folder. */
function nsisInstallLocation(hive: "HKLM" | "HKCU"): string | null {
	const file = path.join(os.tmpdir(), `openscreen-install-${hive}-${process.pid}.reg`);
	try {
		const args = ["export", `${hive}\\${NSIS_INSTALL_KEY}`, file, "/y", "/reg:64"];
		if (spawnSync("reg", args, { windowsHide: true }).status !== 0) return null;
		const match = fs.readFileSync(file, "utf16le").match(/^"InstallLocation"="(.*)"\r?$/m);
		return match ? match[1].replace(/\\(.)/g, "$1") : null;
	} catch {
		return null;
	} finally {
		fs.rmSync(file, { force: true });
	}
}

/** Whether the running exe is the per-user install. Only asked when a per-user and a per-machine
 *  install coexist: the installer cannot tell which one launched it, so the app pins it. */
export function isPerUserCopy(exePath: string, perUserLocation: string | null): boolean {
	if (perUserLocation === null) {
		throw new Error("Could not confirm the Windows installation type. Please retry the update.");
	}
	// path.win32.relative compares case-insensitively, as Windows does.
	return path.win32.relative(perUserLocation, path.win32.dirname(exePath)) === "";
}

/** Hand over to the installer. Callers MUST have checked `blockedFromInstalling`. */
export async function installSelfUpdate(canInstall: () => boolean = () => true): Promise<void> {
	const autoUpdater = await getUpdater();
	if (process.platform === "win32") {
		const { installWindowsUpdate, assertWindowsUpdateIdle } = await import("./windows-update");
		// A concurrent check must not fall back to quitting while another UAC is pending.
		assertWindowsUpdateIdle();
		const installed = { HKLM: nsisInstallStatus("HKLM"), HKCU: nsisInstallStatus("HKCU") };
		if (Object.values(installed).some((status) => status !== 0 && status !== 1)) {
			throw new Error("Could not confirm the Windows installation type. Please retry the update.");
		}
		// A bare /S run updates the per-machine copy whenever there is one, so the hive is pinned.
		if (installed.HKLM === 0) {
			const perUser =
				installed.HKCU === 0 && isPerUserCopy(app.getPath("exe"), nsisInstallLocation("HKCU"));
			const download = () => autoUpdater.downloadUpdate();
			await installWindowsUpdate(download, canInstall, perUser ? "HKCU" : "HKLM");
			return;
		}
	}
	if (!canInstall()) return;
	if (process.platform === "darwin" && app.isPackaged) {
		try {
			requestMacMcpShutdown({ executablePath: process.execPath, version: app.getVersion() });
		} catch (error) {
			console.warn("[updater] Could not notify MCP sessions of the update:", error);
		}
	}
	// Silent: the assisted installer would otherwise show its whole wizard (#1437).
	// isForceRunAfter=true so the app comes back up.
	autoUpdater.quitAndInstall(true, true);
}
