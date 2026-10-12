// A CLI run keeps the app's userData (projects, recordings, settings, models) but
// must not open the GUI's Chromium profile: its Local Storage, caches and GPU cache
// are single-process, so whichever of the two starts first holds them and the other
// silently runs on in-memory storage (#1137). Each CLI run gets a fresh sessionData
// folder of its own, so concurrent CLI runs do not fight over one either.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";

const CLI_SESSIONS_DIR = "cli-sessions";
const OWNER_FILE = "owner.json";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A live run refreshes its owner file daily, so one this old belongs to no live run. */
const ABANDONED_AFTER_MS = 7 * DAY_MS;

/** Who a run folder belongs to. A pid only means something on its own host and pid namespace. */
export interface SessionOwner {
	host: string;
	/** `/proc/self/ns/pid` on Linux, where a Flatpak sandbox has a namespace of its own. */
	pidNamespace: string;
	pid: number;
}

function currentOwner(): SessionOwner {
	let pidNamespace = "";
	try {
		pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
	} catch {
		// Not Linux: one namespace per host.
	}
	return { host: os.hostname(), pidNamespace, pid: process.pid };
}

/**
 * Whether another run's folder can be deleted. Either its owner provably exited (same
 * host and pid namespace, and no such pid), or it has gone unrefreshed for longer than
 * any live run allows. `owner` is null when the folder has no readable owner file.
 */
export function isAbandonedSession(
	owner: SessionOwner | null,
	ageMs: number,
	self: SessionOwner,
	isAlive: (pid: number) => boolean,
): boolean {
	if (ageMs > ABANDONED_AFTER_MS) return true;
	if (!owner) return false;
	return (
		owner.host === self.host &&
		owner.pidNamespace === self.pidNamespace &&
		owner.pid !== self.pid &&
		!isAlive(owner.pid)
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Only ESRCH proves there is no such process; EPERM and anything else may hide a live one.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readOwner(dir: string): Promise<{ owner: SessionOwner | null; ageMs: number }> {
	const ownerPath = path.join(dir, OWNER_FILE);
	try {
		const [text, stat] = await Promise.all([
			fs.promises.readFile(ownerPath, "utf8"),
			fs.promises.stat(ownerPath),
		]);
		return { owner: JSON.parse(text) as SessionOwner, ageMs: Date.now() - stat.mtimeMs };
	} catch {
		// No owner file: a run that died before writing it. Only age can retire it.
		const stat = await fs.promises.stat(dir);
		return { owner: null, ageMs: Date.now() - stat.mtimeMs };
	}
}

async function sweepAbandonedSessions(root: string, ownDir: string, self: SessionOwner) {
	for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
		const dir = path.join(root, entry.name);
		if (!entry.isDirectory() || dir === ownDir) continue;
		try {
			const { owner, ageMs } = await readOwner(dir);
			if (isAbandonedSession(owner, ageMs, self, isProcessAlive)) {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
		} catch {
			// Still locked or already gone; the next run tries again.
		}
	}
}

/**
 * Point this process's Chromium session storage at a fresh folder of its own, then
 * delete the folders of CLI runs that are gone. Must run before `app` is ready.
 */
export function isolateCliSessionData(app: Pick<App, "getPath" | "setPath">): void {
	const root = path.join(app.getPath("userData"), CLI_SESSIONS_DIR);
	const self = currentOwner();
	let ownDir: string;
	try {
		fs.mkdirSync(root, { recursive: true });
		// Fresh per run: a recycled pid must never inherit an earlier run's storage.
		ownDir = fs.mkdtempSync(path.join(root, `${self.pid}-`));
		const ownerPath = path.join(ownDir, OWNER_FILE);
		fs.writeFileSync(ownerPath, JSON.stringify(self));
		app.setPath("sessionData", ownDir);
		setInterval(() => {
			const now = new Date();
			fs.promises.utimes(ownerPath, now, now).catch(() => {
				// Missed once; the next day's refresh is still far inside the margin.
			});
		}, DAY_MS).unref();
	} catch (error) {
		// A throw here, at module load, would surface as Electron's error dialog. The
		// shared profile is the lesser harm.
		console.warn("[cli] could not isolate the Chromium session data:", error);
		return;
	}

	// A crashed run cannot clean up after itself, and a live one cannot delete what its
	// own Chromium still holds open, so every run sweeps for the runs before it.
	sweepAbandonedSessions(root, ownDir, self).catch((error) => {
		console.warn("[cli] could not sweep old CLI session data:", error);
	});
}
