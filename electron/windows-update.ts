import { spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow } from "electron";

let updatePending = false;
export const WINDOWS_UPDATE_PENDING_MESSAGE =
	"A Windows update is pending. Try again after the update completes or is cancelled.";

export function isWindowsUpdatePending(): boolean {
	return updatePending;
}

export function assertWindowsUpdateIdle(): void {
	if (updatePending) throw new Error(WINDOWS_UPDATE_PENDING_MESSAGE);
}

/** Hand the verified installer the copy to update, then quit. Per machine (#1461), the bundled
 * helper elevates it and returns after ShellExecute's UAC decision, without waiting for
 * installation; the prompt names the installer itself, no elevated shell or probe is launched.
 * Per user, the installer needs no elevation and is started directly. */
export async function installWindowsUpdate(
	downloadInstaller: () => Promise<string[]>,
	canInstall: () => boolean = () => true,
	hive: "HKLM" | "HKCU" = "HKLM",
): Promise<void> {
	assertWindowsUpdateIdle();
	updatePending = true;
	let handedOver = false;
	try {
		// A missing cache can require a network download: keep the windows interactive.
		const [installerPath] = await downloadInstaller();
		if (!installerPath) throw new Error("No downloaded Windows update installer");
		// No await between this late readiness check and disabling the current windows.
		if (!canInstall()) return;
		handedOver =
			hive === "HKLM"
				? await elevateInstaller(installerPath)
				: await startPerUserInstaller(installerPath);
	} finally {
		// An accepted handoff remains pending through asynchronous before-quit cleanup.
		if (!handedOver) updatePending = false;
	}
}

/** `/currentuser` pins the per-user copy: with a per-machine install beside it, a bare /S run
 * updates the machine copy behind UAC and uninstalls this one (installer.nsi elevates whenever
 * HKLM has an install; installSection.nsh then removes the HKCU copy). */
async function startPerUserInstaller(installerPath: string): Promise<boolean> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(installerPath, ["--updated", "/S", "--force-run", "/currentuser"], {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			// The installer waits for this app to exit; never wait for it.
			child.unref();
			resolve();
		});
	});
	app.quit();
	return true;
}

async function elevateInstaller(installerPath: string): Promise<boolean> {
	const windows = BrowserWindow.getAllWindows().map((window) => ({
		window,
		enabled: window.isEnabled(),
	}));
	let handedOver = false;
	try {
		// Main-process guards also prevent takes and new HUDs outside these windows.
		for (const { window } of windows) window.setEnabled(false);
		const { exitCode, stderr } = await new Promise<{
			exitCode: number | null;
			stderr: string;
		}>((resolve, reject) => {
			const child = spawn(
				path.join(process.resourcesPath, "elevate.exe"),
				// Pin the confirmed machine copy even if an HKCU install appears during UAC.
				[installerPath, "--updated", "/S", "--force-run", "/allusers"],
				{ detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
			);
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.stderr.on("error", () => {
				// The helper's close result remains authoritative if its stderr pipe fails.
			});
			child.once("error", reject);
			// Wait for close so the helper's error output has drained too; do not unref it.
			child.once("close", (exitCode) => resolve({ exitCode, stderr }));
		});
		// electron-builder's bundled helper exits 1 and prints the Win32 error on failure.
		if (exitCode === 1 && stderr.trimEnd().endsWith(" could not be launched: 1223")) return false;
		if (exitCode !== 0) {
			throw new Error(`Windows update elevation failed (${exitCode}): ${stderr.trim()}`);
		}
		// Preserve normal before-quit cleanup; NSIS is already elevated and waiting for files.
		app.quit();
		handedOver = true;
		return true;
	} finally {
		if (!handedOver) {
			for (const { window, enabled } of windows) {
				if (!window.isDestroyed()) window.setEnabled(enabled);
			}
		}
	}
}
