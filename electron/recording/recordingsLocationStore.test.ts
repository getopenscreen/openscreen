import fsPromises, { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsLocationStore } from "./recordingsLocationStore";

describe("RecordingsLocationStore", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-recordings-location-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("has no custom dir before anything is saved", () => {
		const store = new RecordingsLocationStore(dir);
		expect(store.getCustomDir()).toBeNull();
	});

	it("persists a custom dir and reloads it in a fresh instance", async () => {
		const store = new RecordingsLocationStore(dir);
		const customDir = path.join(dir, "my-recordings");
		await store.setCustomDir(customDir);
		expect(store.getCustomDir()).toBe(customDir);

		const reloaded = new RecordingsLocationStore(dir);
		expect(reloaded.getCustomDir()).toBe(customDir);
	});

	it("clears the custom dir when set back to null", async () => {
		const store = new RecordingsLocationStore(dir);
		await store.setCustomDir(path.join(dir, "my-recordings"));
		await store.setCustomDir(null);

		const reloaded = new RecordingsLocationStore(dir);
		expect(reloaded.getCustomDir()).toBeNull();
	});

	it("ignores an empty string left in the config file", async () => {
		await writeFile(
			path.join(dir, "recordings-location.json"),
			JSON.stringify({ recordingsDir: "" }),
			"utf8",
		);
		const store = new RecordingsLocationStore(dir);
		expect(store.getCustomDir()).toBeNull();
	});

	it("ignores a relative path left in the config file", async () => {
		await writeFile(
			path.join(dir, "recordings-location.json"),
			JSON.stringify({ recordingsDir: "relative/recordings" }),
			"utf8",
		);
		const store = new RecordingsLocationStore(dir);
		expect(store.getCustomDir()).toBeNull();
	});

	it("ignores a malformed config file", async () => {
		await writeFile(path.join(dir, "recordings-location.json"), "not json", "utf8");
		const store = new RecordingsLocationStore(dir);
		expect(store.getCustomDir()).toBeNull();
	});

	it("writes valid JSON that round-trips through readFile", async () => {
		const store = new RecordingsLocationStore(dir);
		const customDir = path.join(dir, "my-recordings");
		await store.setCustomDir(customDir);

		const raw = await readFile(path.join(dir, "recordings-location.json"), "utf8");
		expect(JSON.parse(raw)).toEqual({ recordingsDir: customDir });
	});

	// The atomicity fix: a crash or power loss can only ever be caught before
	// the temp file exists or after the rename lands — never partway through
	// recordings-location.json itself, since the write goes to a distinct
	// temp path first.
	it("writes through a temp file and leaves no temp file behind on success", async () => {
		const store = new RecordingsLocationStore(dir);
		await store.setCustomDir(path.join(dir, "my-recordings"));

		const entries = await readdir(dir);
		expect(entries).toEqual(["recordings-location.json"]);
	});

	// getCustomDir() must never report a directory that failed to reach disk —
	// a caller (RecordingsDirManager's rollback path in particular) relies on
	// this to reflect what was actually persisted.
	it("does not report a new dir as current if the write fails", async () => {
		const store = new RecordingsLocationStore(dir);
		const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("disk full"));

		await expect(store.setCustomDir(path.join(dir, "my-recordings"))).rejects.toThrow("disk full");
		expect(store.getCustomDir()).toBeNull();

		renameSpy.mockRestore();
	});

	// A failed write must not leave a .tmp-* file behind — repeated failures
	// (e.g. a persistently full disk) would otherwise accumulate garbage in
	// the user-data directory forever.
	it("cleans up the temp file when the rename fails", async () => {
		const store = new RecordingsLocationStore(dir);
		const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("disk full"));

		await expect(store.setCustomDir(path.join(dir, "my-recordings"))).rejects.toThrow("disk full");

		const entries = await readdir(dir);
		expect(entries).toEqual([]);

		renameSpy.mockRestore();
	});
});
