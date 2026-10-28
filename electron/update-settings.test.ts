import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_MODE, parseUpdateMode } from "./background-update";
import { loadUpdateMode, saveUpdateMode, updateSettingsPath } from "./update-settings";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

function tmp(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "os-update-settings-"));
	temps.push(dir);
	return dir;
}

describe("update settings", () => {
	// Saved as something other than the default, or a load that ignored the file would pass too.
	it("round-trips a saved mode through load", () => {
		const dir = tmp();
		saveUpdateMode(dir, "notify");
		expect(loadUpdateMode(dir)).toBe("notify");
	});

	// Keeping users current is what the setting is for, so a user who never opened it gets the
	// mode that downloads and installs on its own.
	it("defaults to download-and-install when nothing was ever saved", () => {
		expect(DEFAULT_UPDATE_MODE).toBe("download-and-install");
		expect(loadUpdateMode(tmp())).toBe("download-and-install");
	});

	it("falls back to the default on a corrupt settings file instead of throwing", () => {
		const dir = tmp();
		writeFileSync(updateSettingsPath(dir), '{"mode": not-even-json !!}');
		expect(loadUpdateMode(dir)).toBe(DEFAULT_UPDATE_MODE);
	});

	it("refuses garbage mode values rather than trusting the file", () => {
		for (const garbage of ["install-silently", "", 42, null, { mode: "download" }]) {
			expect(parseUpdateMode(garbage)).toBe(DEFAULT_UPDATE_MODE);
		}
		expect(parseUpdateMode("download")).toBe("download");
	});
});
