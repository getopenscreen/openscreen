import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDiskSpace } from "./diskSpaceCheck";

describe("checkDiskSpace", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-disk-space-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reports the real filesystem as not low, using a near-zero threshold", async () => {
		const status = await checkDiskSpace(dir, 1);
		expect(status.low).toBe(false);
		expect(status.availableBytes).toBeGreaterThan(0);
	});

	it("reports low when the threshold is set far above any real free space", async () => {
		const status = await checkDiskSpace(dir, Number.MAX_SAFE_INTEGER);
		expect(status.low).toBe(true);
	});

	it("does not throw and reports not-low for a directory that doesn't exist", async () => {
		const status = await checkDiskSpace(path.join(dir, "does-not-exist"));
		expect(status.low).toBe(false);
	});
});
