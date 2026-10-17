import assert from "node:assert/strict";
import { test } from "node:test";

import { ASSET_PATTERNS, type AssetKind, findAsset, type LatestRelease } from "./release.ts";

const release = (...names: string[]): LatestRelease => ({
	tag: "v0.0.0",
	published: "",
	publishedIso: "",
	assets: names.map((name) => ({ name, url: `https://example.test/${name}`, size: 1 })),
});

// The asset list of v2.1.0, updater files included: the first release with an arm64 installer.
const V2_1_0 = release(
	"latest-linux.yml",
	"latest-mac.yml",
	"latest.yml",
	"Openscreen-Linux-2.1.0.AppImage",
	"Openscreen-Linux-2.1.0.AppImage.zsync",
	"Openscreen-Linux-2.1.0.deb",
	"Openscreen-Linux-2.1.0.pacman",
	"Openscreen-Linux-2.1.0.rpm",
	"Openscreen-Mac-arm64-2.1.0.zip",
	"Openscreen-Mac-x64-2.1.0.zip",
	"Openscreen-macOS-Apple-Silicon-2.1.0.dmg",
	"Openscreen-macOS-Intel-2.1.0.dmg",
	"Openscreen.Setup.2.1.0-arm64.exe",
	"Openscreen.Setup.2.1.0-arm64.exe.blockmap",
	"Openscreen.Setup.2.1.0-x64.exe",
	"Openscreen.Setup.2.1.0-x64.exe.blockmap",
);

test("each kind resolves to exactly one v2.1.0 asset", () => {
	const expected: Record<AssetKind, string> = {
		macArm: "Openscreen-macOS-Apple-Silicon-2.1.0.dmg",
		macIntel: "Openscreen-macOS-Intel-2.1.0.dmg",
		windows: "Openscreen.Setup.2.1.0-x64.exe",
		windowsArm: "Openscreen.Setup.2.1.0-arm64.exe",
		deb: "Openscreen-Linux-2.1.0.deb",
		rpm: "Openscreen-Linux-2.1.0.rpm",
		pacman: "Openscreen-Linux-2.1.0.pacman",
		appImage: "Openscreen-Linux-2.1.0.AppImage",
	};
	for (const kind of Object.keys(ASSET_PATTERNS) as AssetKind[]) {
		assert.equal(findAsset(V2_1_0, kind)?.name, expected[kind], kind);
		const matches = V2_1_0?.assets.filter((a) => ASSET_PATTERNS[kind].test(a.name)) ?? [];
		assert.equal(matches.length, 1, `${kind} is ambiguous`);
	}
});

test("the 1.7.0 .dmg names still resolve", () => {
	const old = release("Openscreen-Mac-arm64-1.7.0.dmg", "Openscreen-Mac-x64-1.7.0.dmg");
	assert.equal(findAsset(old, "macArm")?.name, "Openscreen-Mac-arm64-1.7.0.dmg");
	assert.equal(findAsset(old, "macIntel")?.name, "Openscreen-Mac-x64-1.7.0.dmg");
});

test("a missing asset or a failed lookup gives null, which the page turns into /releases/latest", () => {
	assert.equal(findAsset(release("Openscreen.Setup.1.11.0.exe"), "macArm"), null);
	assert.equal(findAsset(null, "windows"), null);
});
