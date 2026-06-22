import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_DIR_PREFIX = "openscreen-single-instance";
const PID_FILE_NAME = "pid";
const EMPTY_LOCK_STALE_MS = 30_000;

export type StableInstanceLock = {
	lockDir: string;
	release: () => void;
};

type LockOptions = {
	lockDir?: string;
	pid?: number;
	now?: () => number;
};

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLockPid(lockDir: string): number | null {
	try {
		const rawPid = fs.readFileSync(path.join(lockDir, PID_FILE_NAME), "utf8").trim();
		const pid = Number(rawPid);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isEmptyLockStale(lockDir: string, now: () => number): boolean {
	try {
		const stat = fs.statSync(lockDir);
		return now() - stat.mtimeMs > EMPTY_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function releaseLock(lockDir: string, pid: number) {
	if (readLockPid(lockDir) !== pid) {
		return;
	}
	fs.rmSync(lockDir, { recursive: true, force: true });
}

function getCurrentUserLockKey() {
	if (typeof process.getuid === "function") {
		return `uid-${process.getuid()}`;
	}

	try {
		const username = os.userInfo().username.replace(/[^a-zA-Z0-9._-]/g, "_");
		return username || "default";
	} catch {
		return "default";
	}
}

export function getStableInstanceLockDir() {
	return path.join(os.tmpdir(), `${LOCK_DIR_PREFIX}-${getCurrentUserLockKey()}.lock`);
}

export function acquireStableInstanceLock(options: LockOptions = {}): StableInstanceLock | null {
	const lockDir = options.lockDir ?? getStableInstanceLockDir();
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			fs.mkdirSync(lockDir, { mode: 0o700 });
			fs.writeFileSync(path.join(lockDir, PID_FILE_NAME), `${pid}\n`, { flag: "wx" });
			return {
				lockDir,
				release: () => releaseLock(lockDir, pid),
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw error;
			}

			const existingPid = readLockPid(lockDir);
			if (existingPid && isProcessRunning(existingPid)) {
				return null;
			}
			if (!existingPid && !isEmptyLockStale(lockDir, now)) {
				return null;
			}

			fs.rmSync(lockDir, { recursive: true, force: true });
		}
	}

	return null;
}
