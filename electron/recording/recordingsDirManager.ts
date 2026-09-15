// Owns the mutable, persisted "where do recordings live" state so it can be
// unit-tested without importing all of electron/main.ts (a top-level Electron
// entrypoint with process-wide side effects — single-instance lock, tray,
// menus — that a test has no business triggering).
import fs from "node:fs/promises";
import path from "node:path";
import { RecordingsLocationStore } from "./recordingsLocationStore";

export class RecordingsDirManager {
	readonly defaultDir: string;
	private readonly store: RecordingsLocationStore;
	private readonly isRecording: () => boolean;
	private current: string;
	// Serializes setDir() calls (e.g. a doubled-up click) so two in-flight
	// switches can't interleave their filesystem/persistence writes.
	private pending: Promise<unknown> = Promise.resolve();

	constructor(userDataPath: string, isRecording: () => boolean) {
		this.defaultDir = path.join(userDataPath, "recordings");
		this.store = new RecordingsLocationStore(userDataPath);
		this.isRecording = isRecording;
		this.current = this.store.getCustomDir() ?? this.defaultDir;
	}

	get dir(): string {
		return this.current;
	}

	getInfo() {
		return { path: this.current, isDefault: this.current === this.defaultDir };
	}

	async ensureExists(): Promise<void> {
		await fs.mkdir(this.current, { recursive: true });
	}

	/**
	 * Switches where recordings are read from and written to, going forward.
	 * Pass `null` to reset to the default. Does not move any existing files —
	 * the old location is left untouched.
	 *
	 * Refuses to run while a recording is active: a capture in progress builds
	 * its output path from the current directory up front, so swapping it
	 * mid-take would split one session's video and manifest across two
	 * directories. The check runs both before and after the filesystem/persist
	 * awaits (rolling back the persisted value if the second check trips), which
	 * closes the window for a switch that started before a recording did. It
	 * does NOT close the reverse case — a recording that starts, computes its
	 * output path, and flips `isRecording` to true during this function's
	 * awaits — because recording-start in handlers.ts reads `RECORDINGS_DIR`
	 * directly and does not coordinate with this class. Fixing that fully means
	 * every native capture-start path taking the same lock; out of scope here
	 * (see PR discussion). In practice the window is one `fs.mkdir` + one small
	 * JSON write, and a settings change racing the exact instant a recording is
	 * being kicked off is an edge case, not the common "changed the folder
	 * mid-recording" mistake this guard exists to prevent.
	 */
	async setDir(customDir: string | null): Promise<string> {
		const run = this.pending.then(() => this.setDirUnserialized(customDir));
		// Never let a rejection here poison the chain for the next caller.
		this.pending = run.catch(() => undefined);
		return run;
	}

	private async setDirUnserialized(customDir: string | null): Promise<string> {
		if (this.isRecording()) {
			throw new Error("Cannot change the recordings folder while a recording is in progress.");
		}
		const previousCustomDir = this.store.getCustomDir();
		const resolved = customDir ? path.resolve(customDir) : this.defaultDir;
		await fs.mkdir(resolved, { recursive: true });
		// Persist before committing in-memory state: if this write fails, keep
		// using the old (already-saved) directory rather than silently running
		// on an unsaved one until restart.
		await this.store.setCustomDir(customDir ? resolved : null);
		if (this.isRecording()) {
			// A recording started while the above awaited — undo the persisted
			// change too, so disk and memory don't disagree about the directory.
			await this.store.setCustomDir(previousCustomDir);
			throw new Error("Cannot change the recordings folder while a recording is in progress.");
		}
		this.current = resolved;
		return this.current;
	}
}
