import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { UUID } from "builder-util-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	blockedFromInstalling,
	checkForSelfUpdate,
	downloadSelfUpdate,
	type InstallReadiness,
	installSelfUpdate,
	installsSilently,
	NSIS_INSTALL_KEY,
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
	installWindowsUpdate: vi.fn(),
	assertWindowsUpdateIdle: vi.fn(),
}));

vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.autoUpdater }));
vi.mock("./windows-update", () => ({
	installWindowsUpdate: mocks.installWindowsUpdate,
	assertWindowsUpdateIdle: mocks.assertWindowsUpdateIdle,
}));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

function missingInstallQuery(_command: string, args?: readonly string[]) {
	const root = args?.[1]?.startsWith("HKLM") ? "HKEY_LOCAL_MACHINE" : "HKEY_CURRENT_USER";
	return {
		status: args?.includes("/v") ? 1 : 0,
		stdout: `\r\n${root}\\Software\\OtherApp\r\n`,
	} as ReturnType<typeof spawnSync>;
}

beforeEach(() => {
	vi.mocked(spawnSync).mockReset().mockImplementation(missingInstallQuery);
});

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

	it("blocks a Windows handoff with unsaved editor changes", () => {
		expect(blockedFromInstalling(state({ platform: "win32", editorHasUnsavedChanges: true }))).toBe(
			"unsaved-changes",
		);
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
		mocks.installWindowsUpdate.mockReset();
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

	// Other platforms retain electron-updater's own quit/relaunch handoff.
	it("retains quitAndInstall on macOS and Linux", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			for (const value of ["darwin", "linux"]) {
				Object.defineProperty(process, "platform", { value });
				await installSelfUpdate();
			}
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(2);
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
		expect(mocks.installWindowsUpdate).not.toHaveBeenCalled();
	});

	it("hands over to the wizard on Windows when both installs answer", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
		try {
			await installSelfUpdate();
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
			vi.mocked(spawnSync).mockImplementation(missingInstallQuery);
		}
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
		expect(mocks.installWindowsUpdate).not.toHaveBeenCalled();
	});

	it("waits for the Windows installer without quitting before the UAC decision", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		const canInstall = vi.fn(() => true);
		let finish: (() => void) | undefined;
		mocks.installWindowsUpdate.mockImplementation(async (download: () => Promise<string[]>) => {
			await download();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		mocks.autoUpdater.downloadUpdate.mockResolvedValue(["verified-installer.exe"]);
		vi.mocked(spawnSync).mockImplementation((command, args) =>
			args?.[1]?.startsWith("HKLM")
				? ({ status: 0 } as ReturnType<typeof spawnSync>)
				: missingInstallQuery(command, args),
		);
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			let settled = false;
			const install = installSelfUpdate(canInstall).then(() => {
				settled = true;
			});
			await vi.waitFor(() => expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce());
			expect(settled).toBe(false);
			expect(mocks.installWindowsUpdate).toHaveBeenCalledWith(expect.any(Function), canInstall);
			expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
			finish?.();
			await install;
		} finally {
			finish?.();
			if (platform) Object.defineProperty(process, "platform", platform);
			vi.mocked(spawnSync).mockImplementation(missingInstallQuery);
		}
	});

	it("does not request elevation for a per-user Windows update", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await installSelfUpdate();
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
		expect(mocks.installWindowsUpdate).not.toHaveBeenCalled();
	});

	it("does not enter a legacy Windows handoff while another elevation is pending", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		mocks.assertWindowsUpdateIdle.mockImplementationOnce(() => {
			throw new Error("A Windows update is pending");
		});
		try {
			await expect(installSelfUpdate()).rejects.toThrow("Windows update is pending");
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(mocks.installWindowsUpdate).not.toHaveBeenCalled();
	});

	it.each(["HKLM", "HKCU"])("keeps the app open when the %s query fails", async (hive) => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.mocked(spawnSync).mockImplementation((command, args) =>
			args?.[1]?.startsWith(hive)
				? ({ status: null } as ReturnType<typeof spawnSync>)
				: missingInstallQuery(command, args),
		);
		try {
			await expect(installSelfUpdate()).rejects.toThrow(
				"Could not confirm the Windows installation type",
			);
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
			vi.mocked(spawnSync).mockImplementation(missingInstallQuery);
		}
		expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(mocks.installWindowsUpdate).not.toHaveBeenCalled();
	});

	it.each([
		"HKLM",
		"HKCU",
	])("does not mistake a failed %s value query for absence", async (hive) => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (!args?.[1]?.startsWith(hive)) return missingInstallQuery(command, args);
			if (args.includes("/v")) return { status: 1 } as ReturnType<typeof spawnSync>;
			const root = hive === "HKLM" ? "HKEY_LOCAL_MACHINE" : "HKEY_CURRENT_USER";
			return {
				status: 0,
				stdout: `${root}\\${NSIS_INSTALL_KEY}\r\n`,
			} as ReturnType<typeof spawnSync>;
		});
		try {
			await expect(installSelfUpdate()).rejects.toThrow("Could not confirm");
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(mocks.installWindowsUpdate).not.toHaveBeenCalled();
	});

	it("keeps the app open when parent enumeration also fails", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
		try {
			await expect(installSelfUpdate()).rejects.toThrow("Could not confirm");
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(mocks.installWindowsUpdate).not.toHaveBeenCalled();
	});
});

describe("installsSilently", () => {
	const installs =
		(...hives: string[]) =>
		(hive: string) =>
			hives.includes(hive);

	it("is silent with a single Windows install, per user or per machine", () => {
		expect(installsSilently("win32", installs("HKCU"))).toBe(true);
		expect(installsSilently("win32", installs("HKLM"))).toBe(true);
	});

	// /S would update the per-machine copy even when the per-user one is running.
	it("lets the wizard ask when a per-user and a per-machine install coexist", () => {
		expect(installsSilently("win32", installs("HKLM", "HKCU"))).toBe(false);
	});

	it("never asks off Windows", () => {
		expect(installsSilently("darwin", installs("HKLM", "HKCU"))).toBe(true);
	});

	it("reads the key electron-builder derives from the appId", () => {
		const appId = fs
			.readFileSync("electron-builder.json5", "utf8")
			.match(/"appId": "([^"]+)"/)?.[1];
		const ns = UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"); // electron-builder's NsisTarget
		expect(NSIS_INSTALL_KEY).toBe(`Software\\${UUID.v5(appId ?? "", ns)}`);
	});
});
