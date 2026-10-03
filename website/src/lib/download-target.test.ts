import assert from "node:assert/strict";
import { test } from "node:test";

import {
	browserDownloadTarget,
	directDownloadUrl,
	downloadTarget,
	STORE_INSTALLER_URL,
} from "./download-target.ts";

test("Windows goes directly to the official Store installer without release metadata", () => {
	const target = downloadTarget({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
	assert.deepEqual(target, { os: "windows", kind: null });
	assert.equal(directDownloadUrl(target, null), STORE_INSTALLER_URL);
});

test("mobile devices and ChromeOS never get a desktop installer", () => {
	for (const signals of [
		{ userAgent: "Mozilla/5.0 (Linux; Android 15)" },
		{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
		{ userAgent: "Mozilla/5.0 (X11; CrOS x86_64)" },
		{
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
			platform: "MacIntel",
			maxTouchPoints: 5,
		},
		{ userAgent: "", uaPlatform: "Linux", mobile: true },
	]) {
		assert.deepEqual(downloadTarget(signals), { os: null, kind: null });
	}
});

test("the Intel token in a Mac user agent does not pick the Intel download", () => {
	assert.deepEqual(
		downloadTarget({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }),
		{
			os: "macos",
			kind: null,
		},
	);
});

test("real architecture hints and Mac GPU names select the right dmg", () => {
	const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };
	for (const architecture of ["arm", "arm64", "aarch64"])
		assert.equal(downloadTarget({ ...mac, architecture }).kind, "macArm");
	for (const architecture of ["x86", "x64", "amd64"])
		assert.equal(downloadTarget({ ...mac, architecture }).kind, "macIntel");
	for (const macRenderer of ["Apple M3", "ANGLE (Apple, Apple M1, Metal)"])
		assert.equal(downloadTarget({ ...mac, macRenderer }).kind, "macArm");
	for (const macRenderer of ["Intel Iris OpenGL Engine", "AMD Radeon Pro 5500M"])
		assert.equal(downloadTarget({ ...mac, macRenderer }).kind, "macIntel");
	assert.equal(
		downloadTarget({ ...mac, architecture: "x86", macRenderer: "Apple M2" }).kind,
		"macArm",
	);
	assert.equal(downloadTarget({ ...mac, macRenderer: "Apple Software Renderer" }).kind, null);
	assert.equal(downloadTarget({ ...mac, macRenderer: "Apple GPU" }).kind, null);
});

test("Linux distribution hints pick deb, rpm or pacman; generic Linux gets AppImage", () => {
	for (const [distro, kind] of [
		["Debian", "deb"],
		["Ubuntu", "deb"],
		["Linux Mint", "deb"],
		["Pop!_OS", "deb"],
		["Fedora", "rpm"],
		["Red Hat", "rpm"],
		["CentOS", "rpm"],
		["Arch Linux", "pacman"],
		["ArchLinux", "pacman"],
		["Manjaro", "pacman"],
		["", "appImage"],
		["openSUSE", "appImage"],
	]) {
		assert.equal(
			downloadTarget({ userAgent: `Mozilla/5.0 (X11; ${distro}; Linux x86_64)` }).kind,
			kind,
		);
	}
});

test("known ARM and 32-bit Linux hosts do not get the x64 packages", () => {
	assert.equal(downloadTarget({ userAgent: "Mozilla/5.0 (Linux aarch64; Ubuntu)" }).kind, null);
	assert.equal(downloadTarget({ userAgent: "Linux", architecture: "arm" }).kind, null);
	assert.equal(downloadTarget({ userAgent: "Mozilla/5.0 (Linux i686; Ubuntu)" }).kind, null);
	assert.equal(downloadTarget({ userAgent: "Linux", platform: "Linux aarch64" }).kind, null);
	assert.equal(downloadTarget({ userAgent: "Linux", platform: "Linux i686" }).kind, null);
});

test("unrecognized platforms and missing release assets fall back to the downloads page", () => {
	assert.deepEqual(downloadTarget({ userAgent: "" }), { os: null, kind: null });
	assert.equal(directDownloadUrl({ os: "macos", kind: "macArm" }, null), null);
	assert.equal(
		directDownloadUrl(
			{ os: "linux", kind: "deb" },
			{
				tag: "v1",
				published: "",
				publishedIso: "",
				assets: [],
			},
		),
		null,
	);
});

test("the detected package resolves to the actual release asset", () => {
	const url = "https://example.test/Openscreen-Linux-2.0.0.deb";
	assert.equal(
		directDownloadUrl(
			{ os: "linux", kind: "deb" },
			{
				tag: "v2.0.0",
				published: "",
				publishedIso: "",
				assets: [{ name: "Openscreen-Linux-2.0.0.deb", url, size: 1 }],
			},
		),
		url,
	);
});

test("architecture detection asks for one hint and tolerates refusal and hidden GPUs", async () => {
	const nav = { userAgent: "Macintosh; Intel Mac OS X", platform: "MacIntel", maxTouchPoints: 0 };
	const result = await browserDownloadTarget({
		...nav,
		userAgentData: {
			platform: "macOS",
			getHighEntropyValues: async (hints) => {
				assert.deepEqual(hints, ["architecture"]);
				return { architecture: "arm" };
			},
		},
	});
	assert.equal(result.kind, "macArm");
	const refused = await browserDownloadTarget(
		{
			...nav,
			userAgentData: {
				getHighEntropyValues: async () => {
					throw new Error("blocked");
				},
			},
		},
		() => {
			throw new Error("hidden");
		},
	);
	assert.deepEqual(refused, { os: "macos", kind: null });
});
