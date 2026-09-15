import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsDirManager } from "./recordingsDirManager";

describe("RecordingsDirManager", () => {
	let userDataDir: string;

	beforeEach(async () => {
		userDataDir = await mkdtemp(path.join(tmpdir(), "openscreen-recordings-dir-manager-"));
	});

	afterEach(async () => {
		await rm(userDataDir, { recursive: true, force: true });
	});

	it("starts at the default dir when nothing was persisted before", () => {
		const manager = new RecordingsDirManager(userDataDir, () => false);
		expect(manager.dir).toBe(manager.defaultDir);
		expect(manager.getInfo()).toEqual({ path: manager.defaultDir, isDefault: true });
	});

	it("switches to a custom dir and reports it as non-default", async () => {
		const manager = new RecordingsDirManager(userDataDir, () => false);
		const customDir = path.join(userDataDir, "custom-recordings");

		const resolved = await manager.setDir(customDir);

		expect(resolved).toBe(customDir);
		expect(manager.dir).toBe(customDir);
		expect(manager.getInfo()).toEqual({ path: customDir, isDefault: false });
	});

	it("resets to the default dir when passed null", async () => {
		const manager = new RecordingsDirManager(userDataDir, () => false);
		await manager.setDir(path.join(userDataDir, "custom-recordings"));

		const resolved = await manager.setDir(null);

		expect(resolved).toBe(manager.defaultDir);
		expect(manager.getInfo().isDefault).toBe(true);
	});

	it("refuses to switch while a recording is in progress", async () => {
		const manager = new RecordingsDirManager(userDataDir, () => true);
		const before = manager.dir;

		await expect(manager.setDir(path.join(userDataDir, "custom-recordings"))).rejects.toThrow(
			/recording is in progress/i,
		);
		expect(manager.dir).toBe(before);
	});

	it("persists the choice so a fresh manager picks it up", async () => {
		const customDir = path.join(userDataDir, "custom-recordings");
		const manager = new RecordingsDirManager(userDataDir, () => false);
		await manager.setDir(customDir);

		const reloaded = new RecordingsDirManager(userDataDir, () => false);
		expect(reloaded.dir).toBe(customDir);
	});

	// The core ordering fix: if persistence fails, the in-memory directory must
	// stay on the old (already-saved) value rather than silently running on an
	// unsaved one until restart.
	it("does not update the live dir when persistence fails", async () => {
		const manager = new RecordingsDirManager(userDataDir, () => false);
		const originalDir = manager.dir;

		// biome-ignore lint/suspicious/noExplicitAny: reaching into the private store to force a write failure
		const store = (manager as any).store;
		vi.spyOn(store, "setCustomDir").mockRejectedValueOnce(new Error("disk full"));

		await expect(manager.setDir(path.join(userDataDir, "custom-recordings"))).rejects.toThrow(
			"disk full",
		);
		expect(manager.dir).toBe(originalDir);
	});

	// A recording that starts mid-switch (after the initial guard, during the
	// mkdir/persist awaits) must not leave the manager pointed at a directory
	// that was never actually committed — memory and disk must both roll back.
	it("rolls back memory and disk if a recording starts during the persist await", async () => {
		let recording = false;
		const manager = new RecordingsDirManager(userDataDir, () => recording);
		const originalDir = manager.dir;

		// biome-ignore lint/suspicious/noExplicitAny: reaching into the private store to flip recording state mid-await
		const store = (manager as any).store;
		const realSetCustomDir = store.setCustomDir.bind(store);
		vi.spyOn(store, "setCustomDir").mockImplementation(async (...args: unknown[]) => {
			recording = true;
			return realSetCustomDir(...(args as [string | null]));
		});

		await expect(manager.setDir(path.join(userDataDir, "custom-recordings"))).rejects.toThrow(
			/recording is in progress/i,
		);
		expect(manager.dir).toBe(originalDir);
		expect(store.getCustomDir()).toBeNull();
	});

	it("serializes overlapping calls instead of interleaving their writes", async () => {
		const manager = new RecordingsDirManager(userDataDir, () => false);
		const dirA = path.join(userDataDir, "dir-a");
		const dirB = path.join(userDataDir, "dir-b");

		const [resultA, resultB] = await Promise.all([manager.setDir(dirA), manager.setDir(dirB)]);

		// Whichever wins the race, the manager must land on exactly one of them —
		// not a half-applied mix of both calls' state.
		expect([dirA, dirB]).toContain(resultA);
		expect(resultB).toBe(dirB);
		expect(manager.dir).toBe(dirB);
	});
});
