import { spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow } from "electron";

/** Elevate the verified per-machine installer before quitting (#1461). The bundled
 * helper returns after ShellExecute's UAC decision, without waiting for installation.
 * The prompt names the installer itself; no elevated shell or probe is launched. */
export async function installWindowsUpdate(
	downloadInstaller: () => Promise<string[]>,
): Promise<void> {
	const windows = BrowserWindow.getAllWindows().map((window) => ({
		window,
		enabled: window.isEnabled(),
	}));
	let handedOver = false;
	try {
		// Prevent a new take while elevation is pending, including the gap after accepting it.
		for (const { window } of windows) window.setEnabled(false);
		// The public API reuses and verifies the cached installer.
		const [installerPath] = await downloadInstaller();
		if (!installerPath) throw new Error("No downloaded Windows update installer");
		const { exitCode, stderr } = await new Promise<{
			exitCode: number | null;
			stderr: string;
		}>((resolve, reject) => {
			const child = spawn(
				path.join(process.resourcesPath, "elevate.exe"),
				[installerPath, "--updated", "/S", "--force-run"],
				{ detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
			);
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.once("error", reject);
			// Wait for close so the helper's error output has drained too; do not unref it.
			child.once("close", (exitCode) => resolve({ exitCode, stderr }));
		});
		// electron-builder's bundled helper exits 1 and prints the Win32 error on failure.
		if (exitCode === 1 && stderr.trimEnd().endsWith(" could not be launched: 1223")) return;
		if (exitCode !== 0) {
			throw new Error(`Windows update elevation failed (${exitCode}): ${stderr.trim()}`);
		}
		// Preserve normal before-quit cleanup; NSIS is already elevated and waiting for files.
		app.quit();
		handedOver = true;
	} finally {
		if (!handedOver) {
			for (const { window, enabled } of windows) {
				if (!window.isDestroyed()) window.setEnabled(enabled);
			}
		}
	}
}
