import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStableInstanceLock } from "./singleInstanceLock";

const testDirs: string[] = [];

function createTestLockDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-lock-test-"));
	testDirs.push(dir);
	return path.join(dir, "app.lock");
}

afterEach(() => {
	for (const dir of testDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("acquireStableInstanceLock", () => {
	it("prevents a second lock while the owning process is still running", () => {
		const lockDir = createTestLockDir();
		const firstLock = acquireStableInstanceLock({ lockDir });

		expect(firstLock).not.toBeNull();
		expect(acquireStableInstanceLock({ lockDir })).toBeNull();

		firstLock?.release();
	});

	it("reclaims a stale lock when its process is gone", () => {
		const lockDir = createTestLockDir();
		fs.mkdirSync(lockDir);
		fs.writeFileSync(path.join(lockDir, "pid"), "99999999\n");

		const lock = acquireStableInstanceLock({ lockDir });

		expect(lock).not.toBeNull();
		expect(fs.readFileSync(path.join(lockDir, "pid"), "utf8")).toBe(`${process.pid}\n`);

		lock?.release();
	});

	it("does not remove a fresh empty lock directory", () => {
		const lockDir = createTestLockDir();
		fs.mkdirSync(lockDir);

		expect(acquireStableInstanceLock({ lockDir })).toBeNull();
		expect(fs.existsSync(lockDir)).toBe(true);
	});
});
