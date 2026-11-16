import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameSyncWithFallback, renameWithRetry, writeFileReplacing } from "./atomic-rename";

// No test machine has two layers of one folder, so the MSIX virtualization (#1255) is
// played by a rename that always answers EXDEV.
const exdev = vi.hoisted(() => ({
	on: false,
	error: () =>
		Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const rename: typeof actual.rename = (from, to) =>
		exdev.on ? Promise.reject(exdev.error()) : actual.rename(from, to);
	return { ...actual, rename, default: { ...actual, rename } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const renameSync: typeof actual.renameSync = (from, to) => {
		if (exdev.on) throw exdev.error();
		actual.renameSync(from, to);
	};
	return { ...actual, renameSync, default: { ...actual, renameSync } };
});

describe("atomic rename across an MSIX-virtualized folder", () => {
	let dir: string;
	let temp: string;
	let target: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "atomic-rename-"));
		temp = path.join(dir, "proj.openscreen.tmp-1");
		target = path.join(dir, "proj.openscreen");
		writeFileSync(temp, "new", "utf8");
		writeFileSync(target, "old", "utf8");
		exdev.on = true;
	});

	afterEach(() => {
		exdev.on = false;
		rmSync(dir, { recursive: true, force: true });
	});

	it("copies over the destination and removes the temp file", async () => {
		await renameWithRetry(temp, target);
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(existsSync(temp)).toBe(false);
	});

	it("does the same synchronously", () => {
		renameSyncWithFallback(temp, target);
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(existsSync(temp)).toBe(false);
	});

	it("never copies a case-only rename onto itself", async () => {
		const preset = path.join(dir, "Studio.json");
		writeFileSync(preset, "preset", "utf8");
		await expect(renameWithRetry(preset, path.join(dir, "studio.json"))).rejects.toMatchObject({
			code: "EXDEV",
		});
		expect(readFileSync(preset, "utf8")).toBe("preset");
	});
});

// v2.3.0-rc.4 D5. POSIX modes only: Windows has no mode to keep. 664 and 666 also catch a
// mode passed to writeFile, which the umask masks.
describe.skipIf(process.platform === "win32")("writeFileReplacing", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "write-replacing-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		0o600, 0o640, 0o664, 0o666, 0o755,
	])("keeps the mode %o of the file it replaces", async (mode) => {
		const target = path.join(dir, "out.wav");
		writeFileSync(target, "old");
		chmodSync(target, mode);
		await writeFileReplacing(target, Buffer.from("new"));
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(statSync(target).mode & 0o777).toBe(mode);
		expect(readdirSync(dir)).toEqual(["out.wav"]);
	});

	it("keeps the file it would replace when the write fails", async () => {
		const target = path.join(dir, "out.m4a");
		writeFileSync(target, "old");
		await expect(writeFileReplacing(target, null as unknown as Uint8Array)).rejects.toThrow();
		expect(readFileSync(target, "utf8")).toBe("old");
		expect(readdirSync(dir)).toEqual(["out.m4a"]);
	});
});
