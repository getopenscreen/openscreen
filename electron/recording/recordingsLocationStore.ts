// Persists the user's chosen recordings folder across restarts. Stored next to
// llm-config.json in userData rather than inside the recordings folder itself,
// since the whole point is that folder can move.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

interface RecordingsLocationConfig {
	recordingsDir: string | null;
}

export class RecordingsLocationStore {
	private readonly configPath: string;
	private config: RecordingsLocationConfig = { recordingsDir: null };

	constructor(userDataPath: string) {
		this.configPath = path.join(userDataPath, "recordings-location.json");
		this.loadSync();
	}

	private loadSync(): void {
		try {
			const raw = readFileSync(this.configPath, "utf8");
			const parsed = JSON.parse(raw);
			const candidate = parsed.recordingsDir;
			// An empty or relative string would make fs.mkdir("") fail at startup,
			// or resolve recordings relative to the process's working directory —
			// neither is a state a hand-edited or corrupted config file should be
			// able to force. setRecordingsDir() only ever writes an absolute path.
			this.config = {
				recordingsDir:
					typeof candidate === "string" && candidate.length > 0 && path.isAbsolute(candidate)
						? candidate
						: null,
			};
		} catch {
			this.config = { recordingsDir: null };
		}
	}

	/** The user's custom folder, or null to use the default (userData/recordings). */
	getCustomDir(): string | null {
		return this.config.recordingsDir;
	}

	async setCustomDir(dir: string | null): Promise<void> {
		// Build the next config but don't commit it to `this.config` until the
		// write has actually landed — otherwise getCustomDir() could report a
		// directory that was never persisted (e.g. RecordingsDirManager's
		// rollback path reads this value expecting it to reflect disk).
		const nextConfig: RecordingsLocationConfig = { recordingsDir: dir };
		// Write-then-rename, not a direct write: fs.rename is atomic on the same
		// filesystem, so a crash or power loss mid-write can never leave
		// recordings-location.json truncated or malformed. Same pattern as
		// mediaLinksRegistry.ts's writeRegistry().
		const tmpPath = `${this.configPath}.tmp-${process.pid}-${Date.now()}`;
		try {
			await fs.writeFile(tmpPath, JSON.stringify(nextConfig, null, 2), "utf8");
			await fs.rename(tmpPath, this.configPath);
			this.config = nextConfig;
		} catch (error) {
			// Best-effort: don't let a cleanup failure hide the real error, and
			// don't leave a stale .tmp-* file behind for every failed attempt.
			await fs.rm(tmpPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}
}
