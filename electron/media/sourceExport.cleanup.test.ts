import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock("electron", () => ({ app: undefined }));
vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			if (failure.enabled && args[1] === "subtitle bytes") {
				await actual.writeFile(args[0], "partial");
				throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			}
			return actual.writeFile(...args);
		},
	};
});

import { exportSourceSrtFile } from "./sourceExport";

it("removes a partially written SRT after a disk-full error without publishing it", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "openscreen-srt-cleanup-"));
	try {
		const source = path.join(dir, "source.mp4");
		await writeFile(source, "source");
		failure.enabled = true;
		await expect(
			exportSourceSrtFile(source, path.join(dir, "source.srt"), "subtitle bytes"),
		).rejects.toThrow("disk full");
		expect(await readdir(dir)).toEqual(["source.mp4"]);
	} finally {
		failure.enabled = false;
		await rm(dir, { recursive: true, force: true });
	}
});
