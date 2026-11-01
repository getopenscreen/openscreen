import { spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow } from "electron";

/** Elevate the verified per-machine installer before quitting (#1461). Start-Process
 * returns after ShellExecute's UAC decision, without waiting for the installation.
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
		const quotedPath = `'${installerPath.replace(/'/g, "''")}'`;
		const script = `
$ErrorActionPreference = 'Stop'
try {
 Start-Process -FilePath ${quotedPath} -ArgumentList @('--updated', '/S', '--force-run') -Verb RunAs -WindowStyle Hidden -PassThru | Out-Null
 exit 0
} catch {
 $errorCause = $_.Exception
 while ($errorCause -and $errorCause -isnot [System.ComponentModel.Win32Exception]) {
  $errorCause = $errorCause.InnerException
 }
 if ($errorCause -and $errorCause.NativeErrorCode -eq 1223) { exit 1223 }
 exit 1
}`;
		const powershell = path.join(
			process.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(
				powershell,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					Buffer.from(script, "utf16le").toString("base64"),
				],
				{ detached: true, stdio: "ignore", windowsHide: true },
			);
			child.once("error", reject);
			child.once("exit", resolve);
			child.unref();
		});
		if (exitCode === 1223) return; // User declined: retain the app and ready update badge.
		if (exitCode !== 0) throw new Error(`Windows update elevation failed (${exitCode})`);
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
