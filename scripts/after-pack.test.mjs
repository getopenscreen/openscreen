// The macOS release job packs with `--dir`, which electron-builder treats as "no updater target"
// and so writes no app-update.yml (#1431). after-pack.cjs fills that gap; these pin that it writes
// the file on macOS only, never overwrites electron-builder's own, and writes what electron-updater
// reads.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const afterPack = require("./after-pack.cjs").default;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function context(electronPlatformName) {
	const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "after-pack-"));
	dirs.push(appOutDir);
	const resources = path.join(appOutDir, "Openscreen.app/Contents/Resources");
	fs.mkdirSync(resources, { recursive: true });
	return {
		electronPlatformName,
		appOutDir,
		file: path.join(resources, "app-update.yml"),
		packager: {
			getResourcesDir: () => resources,
			config: { publish: [{ provider: "github", owner: "getopenscreen", repo: "openscreen" }] },
			appInfo: { updaterCacheDirName: "openscreen-updater" },
		},
	};
}

describe("afterPack app-update.yml", () => {
	it("writes the file into a macOS bundle", async () => {
		const ctx = context("darwin");
		await afterPack(ctx);
		expect(fs.readFileSync(ctx.file, "utf8")).toBe(
			"provider: github\nowner: getopenscreen\nrepo: openscreen\nupdaterCacheDirName: openscreen-updater\n",
		);
	});

	it("leaves electron-builder's own file alone", async () => {
		const ctx = context("darwin");
		fs.writeFileSync(ctx.file, "provider: generic\n");
		await afterPack(ctx);
		expect(fs.readFileSync(ctx.file, "utf8")).toBe("provider: generic\n");
	});

	it("writes nothing on Windows or Linux", async () => {
		for (const platform of ["win32", "linux"]) {
			const ctx = context(platform);
			await afterPack(ctx);
			expect(fs.existsSync(ctx.file)).toBe(false);
		}
	});
});
