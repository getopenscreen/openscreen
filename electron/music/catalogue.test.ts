// The property worth testing here is the CONFINEMENT, not the listing. `id` arrives from
// the renderer and is turned into a path that then gets read approval, so a resolver that
// could be walked out of the catalogue directory would turn the music library into an
// arbitrary-file approver. The happy path is almost incidental by comparison.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assetBase = { dir: "" };

vi.mock("../assetBaseDir", () => ({
	assetBaseDir: () => assetBase.dir,
}));

async function loadModule() {
	vi.resetModules();
	return import("./catalogue");
}

function writeCatalogue(tracks: unknown[]): void {
	const dir = path.join(assetBase.dir, "music");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "catalogue.json"), JSON.stringify({ tracks }));
}

const TRACK = {
	id: "sleepy-clouds",
	file: "sleepy-clouds.ogg",
	title: "Sleepy Clouds",
	author: "fupi",
	durationSec: 76.3,
	mood: ["ambient"],
	license: "CC0-1.0",
	licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
	sourceUrl: "https://opengameart.org/content/sleepy-clouds",
};

beforeEach(() => {
	assetBase.dir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-music-cat-"));
});

afterEach(() => {
	fs.rmSync(assetBase.dir, { recursive: true, force: true });
});

describe("music catalogue", () => {
	it("lists the manifest's tracks", async () => {
		writeCatalogue([TRACK]);
		const { listMusicCatalogue } = await loadModule();
		const tracks = await listMusicCatalogue();
		expect(tracks).toHaveLength(1);
		expect(tracks[0]).toMatchObject({ id: "sleepy-clouds", license: "CC0-1.0" });
	});

	// A malformed manifest must not take the editor down with it — `npm run music:check`
	// is what enforces the shape, in CI, long before a user sees it.
	it("degrades to an empty library when the manifest is unreadable", async () => {
		const { listMusicCatalogue } = await loadModule();
		await expect(listMusicCatalogue()).resolves.toEqual([]);
	});

	it("drops entries that are not shaped like tracks", async () => {
		writeCatalogue([TRACK, { id: "no-file" }, null, "nonsense"]);
		const { listMusicCatalogue } = await loadModule();
		await expect(listMusicCatalogue()).resolves.toHaveLength(1);
	});

	it("resolves a known id to the file beside the manifest", async () => {
		writeCatalogue([TRACK]);
		fs.writeFileSync(path.join(assetBase.dir, "music", "sleepy-clouds.ogg"), "audio");
		const { resolveMusicTrackPath } = await loadModule();
		await expect(resolveMusicTrackPath("sleepy-clouds")).resolves.toBe(
			path.join(assetBase.dir, "music", "sleepy-clouds.ogg"),
		);
	});

	it("returns null for an id that is not in the catalogue", async () => {
		writeCatalogue([TRACK]);
		const { resolveMusicTrackPath } = await loadModule();
		await expect(resolveMusicTrackPath("../../etc/passwd")).resolves.toBeNull();
	});

	// The manifest is ours, but it is also a file on disk in the install directory. An
	// entry whose `file` climbs out of the catalogue dir resolves to nothing.
	it("refuses a manifest entry whose file escapes the catalogue directory", async () => {
		const outside = path.join(assetBase.dir, "secret.ogg");
		fs.writeFileSync(outside, "audio");
		writeCatalogue([{ ...TRACK, file: "../secret.ogg" }]);
		const { resolveMusicTrackPath } = await loadModule();
		await expect(resolveMusicTrackPath("sleepy-clouds")).resolves.toBeNull();
	});

	// The relink path: a project authored against another install keeps an absolute path
	// into an install directory that no longer exists.
	it("relinks a stale bundled path to the local install", async () => {
		writeCatalogue([TRACK]);
		fs.writeFileSync(path.join(assetBase.dir, "music", "sleepy-clouds.ogg"), "audio");
		const { resolveBundledMusicPath } = await loadModule();
		await expect(
			resolveBundledMusicPath(
				"/Applications/Openscreen.app/Contents/Resources/music/sleepy-clouds.ogg",
			),
		).resolves.toBe(path.join(assetBase.dir, "music", "sleepy-clouds.ogg"));
	});

	// Narrow on purpose: a bare basename match would relink any file that happened to
	// share a name with a catalogue track.
	it("refuses to relink a path that is not inside a music directory", async () => {
		writeCatalogue([TRACK]);
		fs.writeFileSync(path.join(assetBase.dir, "music", "sleepy-clouds.ogg"), "audio");
		const { resolveBundledMusicPath } = await loadModule();
		await expect(
			resolveBundledMusicPath("/home/me/Downloads/sleepy-clouds.ogg"),
		).resolves.toBeNull();
	});

	it("does not relink a file the catalogue never listed", async () => {
		writeCatalogue([TRACK]);
		const { resolveBundledMusicPath } = await loadModule();
		await expect(resolveBundledMusicPath("/elsewhere/music/someone-elses.ogg")).resolves.toBeNull();
	});

	it("returns null when the manifest names a file that is not on disk", async () => {
		writeCatalogue([TRACK]);
		const { resolveMusicTrackPath } = await loadModule();
		await expect(resolveMusicTrackPath("sleepy-clouds")).resolves.toBeNull();
	});
});
