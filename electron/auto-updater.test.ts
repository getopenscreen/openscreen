import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	blockedFromInstalling,
	checkForSelfUpdate,
	downloadSelfUpdate,
	type InstallReadiness,
	installNeedsElevation,
	installSelfUpdate,
	setInstallOnQuit,
} from "./auto-updater";

const mocks = vi.hoisted(() => ({
	// Deliberately initialised to electron-updater's DEFAULTS, so a test asserting they are
	// false proves our configuration ran rather than reading a value that was never touched.
	autoUpdater: {
		autoDownload: true,
		autoInstallOnAppQuit: true,
		logger: {} as unknown,
		checkForUpdates: vi.fn(),
		downloadUpdate: vi.fn(),
		quitAndInstall: vi.fn(),
	},
	app: { isPackaged: true, getVersion: vi.fn(() => "1.9.2") },
}));

vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.autoUpdater }));

function state(overrides: Partial<InstallReadiness> = {}): InstallReadiness {
	return { recording: false, inApplicationsFolder: true, platform: "linux", ...overrides };
}

describe("blockedFromInstalling", () => {
	it("allows an install when nothing is in the way", () => {
		for (const platform of ["win32", "darwin", "linux"] as const) {
			expect(blockedFromInstalling(state({ platform }))).toBeNull();
		}
	});

	// Quitting mid-recording loses the take. On Windows it is worse than losing it: the capture
	// helpers spawn from inside the install directory, and NSIS cannot overwrite a running .exe.
	it("refuses while a recording is in progress, on every platform", () => {
		for (const platform of ["win32", "darwin", "linux"] as const) {
			expect(blockedFromInstalling(state({ platform, recording: true }))).toBe("recording");
		}
	});

	// App Translocation: a quarantined app runs from a read-only image where Squirrel cannot
	// replace the bundle. Pinned per-platform because CI is Linux-only and an unpinned branch
	// would be green here and wrong on the one platform it applies to.
	it("refuses a macOS install running outside /Applications", () => {
		expect(blockedFromInstalling(state({ platform: "darwin", inApplicationsFolder: false }))).toBe(
			"not-in-applications",
		);
	});

	it("does not apply the Applications-folder rule off macOS", () => {
		for (const platform of ["win32", "linux"] as const) {
			expect(blockedFromInstalling(state({ platform, inApplicationsFolder: false }))).toBeNull();
		}
	});

	it("reports the recording veto first when both apply", () => {
		expect(
			blockedFromInstalling(
				state({ platform: "darwin", recording: true, inApplicationsFolder: false }),
			),
		).toBe("recording");
	});
});

describe("self-update flow", () => {
	beforeEach(() => {
		mocks.app.isPackaged = true;
		// Back to electron-updater's DEFAULTS before every test, so "these are false" can only
		// pass because this test's call configured them — not because an earlier test did.
		mocks.autoUpdater.autoDownload = true;
		mocks.autoUpdater.autoInstallOnAppQuit = true;
		mocks.autoUpdater.checkForUpdates.mockReset();
		mocks.autoUpdater.downloadUpdate.mockReset();
		mocks.autoUpdater.quitAndInstall.mockReset();
	});

	it("never touches the updater on a channel a package manager owns", async () => {
		for (const channel of ["store", "flatpak", "snap", "nix"] as const) {
			await expect(checkForSelfUpdate(channel)).resolves.toEqual({ kind: "unsupported" });
		}
		expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
	});

	it("refuses to self-update an unpacked build", async () => {
		mocks.app.isPackaged = false;
		await expect(checkForSelfUpdate("nsis")).resolves.toEqual({ kind: "unsupported" });
		expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
	});

	// These three settings are the difference between an update and a lost recording, and each
	// looks like harmless boilerplate to delete. `window-all-closed` quits this app and the HUD
	// is a window, so the stock autoInstallOnAppQuit would fire a ~243 MB installer when the
	// user merely closed the HUD.
	it("disables auto-download and install-on-quit before doing anything", async () => {
		// Asserted INSIDE the mock: checking after the call would still pass if the settings
		// were applied late, and "late" is the whole failure — a check that starts downloading
		// before autoDownload is turned off has already pulled ~243 MB the user never asked for.
		const settingsWhenChecked: Array<boolean> = [];
		mocks.autoUpdater.checkForUpdates.mockImplementation(() => {
			settingsWhenChecked.push(
				mocks.autoUpdater.autoDownload,
				mocks.autoUpdater.autoInstallOnAppQuit,
			);
			return Promise.resolve({ updateInfo: { version: "1.9.2" } });
		});

		await checkForSelfUpdate("nsis");

		expect(settingsWhenChecked).toEqual([false, false]);
	});

	it("reports current when the feed offers the running version", async () => {
		mocks.autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: "1.9.2" } });
		await expect(checkForSelfUpdate("appimage")).resolves.toEqual({ kind: "current" });
	});

	it("reports current when no feed resolves, rather than claiming an update", async () => {
		mocks.autoUpdater.checkForUpdates.mockResolvedValue(null);
		await expect(checkForSelfUpdate("deb")).resolves.toEqual({ kind: "current" });
	});

	it("surfaces an available version", async () => {
		mocks.autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: "1.10.0" } });
		await expect(checkForSelfUpdate("dmg")).resolves.toEqual({
			kind: "downloaded",
			version: "1.10.0",
		});
	});

	// A release published before the update feeds existed has no latest*.yml. That must degrade
	// to the release-page fallback, not throw into main-process-errors, which re-throws.
	it("reports a missing or broken feed as failed instead of throwing", async () => {
		mocks.autoUpdater.checkForUpdates.mockRejectedValue(new Error("404 latest.yml"));
		const result = await checkForSelfUpdate("nsis");
		expect(result.kind).toBe("failed");
		expect(result).toMatchObject({ error: { message: "404 latest.yml" } });
	});

	it("reports a failed download instead of throwing", async () => {
		mocks.autoUpdater.downloadUpdate.mockRejectedValue(new Error("connection reset"));
		const result = await downloadSelfUpdate();
		expect(result.kind).toBe("failed");
		expect(result).toMatchObject({ error: { message: "connection reset" } });
	});

	// isSilent=false so a per-machine Windows install can show its UAC prompt — a silent upgrade
	// of a Program Files install hits elevation and, if dismissed, quits having done nothing.
	// isForceRunAfter=true so the app comes back.
	it("hands over to the installer non-silently and relaunches", async () => {
		await installSelfUpdate();
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
	});

	// electron-updater only registers its quit handler if the flag is on when the download ends,
	// and only installs if it is still on at quit. Both halves have to follow the switch.
	it("applies install-on-quit at the next call and flips it live once loaded", async () => {
		mocks.autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: "1.9.2" } });
		try {
			setInstallOnQuit(true);
			await checkForSelfUpdate("nsis");
			expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
			// From before-quit: synchronous, no updater call in between.
			setInstallOnQuit(false);
			expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
		} finally {
			setInstallOnQuit(false);
		}
	});
});

describe("installNeedsElevation", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});
	function installDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "os-install-"));
		dirs.push(dir);
		return dir;
	}

	it("always needs it for a package the system package manager installed", () => {
		for (const channel of ["deb", "rpm", "pacman"] as const) {
			expect(installNeedsElevation(channel, path.join(installDir(), "openscreen"))).toBe(true);
		}
	});

	it("never asks on macOS, where Squirrel installs", () => {
		expect(installNeedsElevation("dmg", "/nonexistent/Openscreen.app/Contents/MacOS/x")).toBe(
			false,
		);
	});

	it("needs none where the install directory is writable, and leaves nothing behind", () => {
		const dir = installDir();
		expect(installNeedsElevation("nsis", path.join(dir, "Openscreen.exe"))).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("needs it where the install directory cannot be written", () => {
		const missing = path.join(installDir(), "gone", "Openscreen.exe");
		expect(installNeedsElevation("nsis", missing)).toBe(true);
	});

	it("probes the AppImage's own folder, not the mount it runs from", () => {
		const dir = installDir();
		const mount = path.join(dir, "missing-mount", "openscreen");
		expect(installNeedsElevation("appimage", mount, path.join(dir, "Openscreen.AppImage"))).toBe(
			false,
		);
	});
});
