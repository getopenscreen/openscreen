import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	collectCrates,
	collectNpmPackages,
	renderLicenses,
} from "./generate-third-party-licenses.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-licenses-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function write(root, files) {
	for (const [file, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	}
}

const MIT =
	"MIT License\n\nCopyright (c) Someone\n\nPermission is hereby granted, free of charge.\n";
// The same text as another package ships it: CRLF, rewrapped, with a BOM.
const MIT_REWRAPPED =
	"﻿MIT License\r\n\r\nCopyright (c) Someone\r\n\r\nPermission is hereby\r\ngranted,  free of charge.";
const pkg = (name, version, license) => JSON.stringify({ name, version, license });

const NPM_ROOT = path.join(TMP, "npm");
write(NPM_ROOT, {
	"package-lock.json": JSON.stringify({
		lockfileVersion: 3,
		packages: {
			"": { name: "openscreen", version: "2.0.0" },
			"node_modules/alpha": { version: "1.0.0", license: "MIT" },
			"node_modules/beta": { version: "2.0.0", license: "MIT" },
			"node_modules/alpha/node_modules/nested": { version: "0.1.0", license: "Apache-2.0" },
			"node_modules/peer": { version: "1.0.0", license: "ISC", devOptional: true },
			"node_modules/dev-tool": { version: "1.0.0", license: "MIT", dev: true },
			"node_modules/other-platform": { version: "1.0.0", license: "MIT", optional: true },
		},
	}),
	"node_modules/alpha/package.json": pkg("alpha", "1.0.0", "MIT"),
	"node_modules/alpha/LICENSE": MIT,
	"node_modules/alpha/README.md": "not a licence",
	"node_modules/beta/package.json": pkg("beta", "2.0.0", "MIT"),
	"node_modules/beta/licence.md": MIT_REWRAPPED,
	"node_modules/alpha/node_modules/nested/package.json": pkg("nested", "0.1.0", "Apache-2.0"),
	"node_modules/alpha/node_modules/nested/NOTICE": "nested NOTICE",
	"node_modules/alpha/node_modules/nested/LICENSE-APACHE": "Apache License 2.0",
	"node_modules/peer/package.json": pkg("peer", "1.0.0", "ISC"),
	"node_modules/dev-tool/package.json": pkg("dev-tool", "1.0.0", "MIT"),
	"node_modules/dev-tool/LICENSE": "dev only",
});

describe("collectNpmPackages", () => {
	const { entries, skipped } = collectNpmPackages(NPM_ROOT);
	const byLabel = Object.fromEntries(entries.map((entry) => [entry.label, entry.texts]));

	it("keeps the production entries, optional ones included, and drops dev ones", () => {
		expect(Object.keys(byLabel).sort()).toEqual([
			"alpha 1.0.0 (MIT)",
			"beta 2.0.0 (MIT)",
			"nested 0.1.0 (Apache-2.0)",
			"peer 1.0.0 (ISC)",
		]);
	});

	it("skips an entry that is not installed on this machine", () => {
		expect(skipped).toEqual(["node_modules/other-platform"]);
	});

	it("reads LICENSE, LICENCE and NOTICE files in any case, in name order", () => {
		expect(byLabel["alpha 1.0.0 (MIT)"]).toEqual([MIT]);
		expect(byLabel["beta 2.0.0 (MIT)"]).toEqual([MIT_REWRAPPED]);
		expect(byLabel["nested 0.1.0 (Apache-2.0)"]).toEqual(["Apache License 2.0", "nested NOTICE"]);
	});

	it("records a package without a licence file instead of failing", () => {
		expect(byLabel["peer 1.0.0 (ISC)"]).toEqual([]);
		expect(renderLicenses({ npm: entries, crates: [] })).toContain(
			"peer 1.0.0 (ISC)\n\n(no licence file in the package)\n",
		);
	});
});

function crate(name, kind = "lib") {
	const dir = path.join(TMP, "crates", name);
	write(dir, { "LICENSE-MIT": `${name} licence` });
	const manifest_path = path.join(dir, "Cargo.toml");
	return {
		id: `${name} 1.0.0`,
		name,
		version: "1.0.0",
		license: "MIT",
		manifest_path,
		targets: [{ kind: [kind] }],
	};
}
const dep = (name, ...kinds) => ({
	pkg: `${name} 1.0.0`,
	dep_kinds: kinds.map((kind) => ({ kind, target: null })),
});

const METADATA = {
	packages: [
		crate("compositor-view-napi", "cdylib"),
		crate("openscreen-compositor"),
		crate("serde"),
		crate("serde_derive", "proc-macro"),
		crate("syn"),
		crate("cc"),
		crate("shlex"),
		crate("criterion"),
		crate("libc"),
		crate("windows"),
	],
	workspace_members: ["compositor-view-napi 1.0.0", "openscreen-compositor 1.0.0"],
	resolve: {
		nodes: [
			{
				id: "compositor-view-napi 1.0.0",
				deps: [
					dep("openscreen-compositor", null),
					{ pkg: "windows 1.0.0", dep_kinds: [{ kind: null, target: "cfg(windows)" }] },
				],
			},
			{
				id: "openscreen-compositor 1.0.0",
				deps: [
					dep("serde", null),
					dep("cc", "build"),
					dep("criterion", "dev"),
					dep("libc", "build", null),
				],
			},
			{ id: "serde 1.0.0", deps: [dep("serde_derive", null)] },
			{ id: "serde_derive 1.0.0", deps: [dep("syn", null)] },
			{ id: "cc 1.0.0", deps: [dep("shlex", null)] },
			{ id: "syn 1.0.0", deps: [] },
			{ id: "shlex 1.0.0", deps: [] },
			{ id: "criterion 1.0.0", deps: [] },
			{ id: "libc 1.0.0", deps: [] },
			{ id: "windows 1.0.0", deps: [] },
		],
	},
};

describe("collectCrates", () => {
	it("keeps the normal-dependency closure of the addon, on every platform", () => {
		const labels = collectCrates(METADATA).map((entry) => entry.label);
		// Out: the workspace members, the proc-macro and syn behind it, the build-dependency
		// and shlex behind it, the dev-dependency. libc is a build AND a normal dependency.
		expect(labels.sort()).toEqual(["libc 1.0.0 (MIT)", "serde 1.0.0 (MIT)", "windows 1.0.0 (MIT)"]);
	});

	it("reads each crate's licence files from its manifest directory", () => {
		const serde = collectCrates(METADATA).find((entry) => entry.label.startsWith("serde "));
		expect(serde?.texts).toEqual(["serde licence"]);
	});

	it("reads a declared license-file below the top level, and names it without a licence", () => {
		const custom = { ...crate("custom"), license: null, license_file: "legal/TERMS.txt" };
		write(path.dirname(custom.manifest_path), { "legal/TERMS.txt": "custom terms" });
		const metadata = {
			packages: [crate("compositor-view-napi", "cdylib"), custom],
			workspace_members: ["compositor-view-napi 1.0.0"],
			resolve: {
				nodes: [
					{ id: "compositor-view-napi 1.0.0", deps: [dep("custom", null)] },
					{ id: "custom 1.0.0", deps: [] },
				],
			},
		};

		expect(collectCrates(metadata)).toEqual([
			{ label: "custom 1.0.0 (see legal/TERMS.txt)", texts: ["custom licence", "custom terms"] },
		]);
	});
});

describe("renderLicenses", () => {
	const { entries: npm } = collectNpmPackages(NPM_ROOT);
	const crates = collectCrates(METADATA);

	it("prints a text shared after whitespace normalisation once, after its sorted labels", () => {
		const text = renderLicenses({ npm, crates });

		expect(text).toContain("alpha 1.0.0 (MIT)\nbeta 2.0.0 (MIT)\n\nMIT License\n");
		expect(text.split("Permission is hereby").length - 1).toBe(1);
	});

	it("gives the same bytes whatever order the packages arrive in", () => {
		const reversed = renderLicenses({ npm: [...npm].reverse(), crates: [...crates].reverse() });

		expect(reversed).toBe(renderLicenses({ npm, crates }));
		expect(reversed).not.toContain("\r");
	});
});
