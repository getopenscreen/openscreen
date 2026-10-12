// A CLI run keeps the app's userData (projects, recordings, settings, models) but
// must not open the GUI's Chromium profile: its Local Storage, caches and GPU cache
// are single-process, so whichever of the two starts first holds them and the other
// silently runs on in-memory storage (#1137). Each CLI process gets its own
// sessionData folder, so concurrent CLI runs do not fight over one either.

import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";

const CLI_SESSIONS_DIR = "cli-sessions";

export function cliSessionDataDir(userDataDir: string, pid: number): string {
	return path.join(userDataDir, CLI_SESSIONS_DIR, String(pid));
}

/** The folders, among `names`, left behind by CLI processes that are no longer running. */
export function staleCliSessionDirs(
	names: string[],
	ownPid: number,
	isAlive: (pid: number) => boolean,
): string[] {
	return names.filter(
		(name) => /^\d+$/.test(name) && Number(name) !== ownPid && !isAlive(Number(name)),
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists, it is just not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Point this process's Chromium session storage at its own folder, then delete the
 * folders of CLI runs that have exited. Must run before `app` is ready.
 */
export function isolateCliSessionData(app: Pick<App, "getPath" | "setPath">): void {
	const root = path.join(app.getPath("userData"), CLI_SESSIONS_DIR);
	const own = cliSessionDataDir(app.getPath("userData"), process.pid);
	try {
		fs.mkdirSync(own, { recursive: true });
		app.setPath("sessionData", own);
	} catch (error) {
		// A throw here, at module load, would surface as Electron's error dialog. The
		// shared profile is the lesser harm.
		console.warn("[cli] could not isolate the Chromium session data:", error);
		return;
	}

	// A crashed run cannot clean up after itself, and a live one cannot delete what its
	// own Chromium still holds open, so every run sweeps for the runs before it.
	const stale = staleCliSessionDirs(fs.readdirSync(root), process.pid, isProcessAlive);
	for (const name of stale) {
		fs.promises.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {
			// Still locked or already gone; the next run tries again.
		});
	}
}
