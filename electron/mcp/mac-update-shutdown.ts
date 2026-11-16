// ShipIt waits for every process from the .app, including an idle `openscreen mcp`.
// A user-requested update lets those servers close themselves through their ordinary
// shutdown path. The signal is shared across userData profiles, scoped to this exact
// executable/version, and expires so a cancelled update cannot disable later sessions.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const UPDATE_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 500;

interface UpdateIdentity {
	executablePath: string;
	version: string;
	/** Tests use a temporary directory; production shares the account's private cache. */
	markerDirectory?: string;
}

function markerPath(identity: UpdateIdentity): string {
	const directory =
		identity.markerDirectory ??
		path.join(os.homedir(), "Library", "Caches", "openscreen-mcp-updates");
	const key = createHash("sha256")
		.update(`${identity.executablePath}\0${identity.version}`)
		.digest("hex");
	return path.join(directory, `${key}.json`);
}

/** Called only when the GUI hands a user-requested update to Squirrel. */
export function requestMacMcpShutdown(identity: UpdateIdentity): void {
	const file = markerPath(identity);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify({ expiresAt: Date.now() + UPDATE_WINDOW_MS }), {
		mode: 0o600,
	});
}

/** Existing and newly started servers yield to an update of their own app/version. */
export function watchForMacMcpShutdown(
	identity: UpdateIdentity,
	onShutdown: () => boolean | void,
): () => void {
	const file = markerPath(identity);
	let stopped = false;
	let requested = false;
	const poll = () => {
		if (stopped) return;
		if (!requested) {
			let expiresAt: unknown;
			try {
				expiresAt = (JSON.parse(readFileSync(file, "utf8")) as { expiresAt?: unknown })?.expiresAt;
			} catch {
				return;
			}
			const remainingMs = typeof expiresAt === "number" ? expiresAt - Date.now() : 0;
			// Also ignore a request far in the future after a system-clock rollback.
			if (!(remainingMs > 0 && remainingMs <= UPDATE_WINDOW_MS)) return;
			requested = true;
		}
		// Once observed, remember the request while an active take/export finishes,
		// even if that takes longer than the window for newly launched servers.
		if (onShutdown() === false) return;
		stopped = true;
		clearInterval(timer);
	};
	const timer = setInterval(poll, POLL_INTERVAL_MS);
	timer.unref();
	poll();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
