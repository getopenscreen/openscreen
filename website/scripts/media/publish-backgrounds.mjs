#!/usr/bin/env node
/** Immutable responsive wallpaper cut. Upload before requesting its public URLs.
 * node scripts/media/publish-backgrounds.mjs --cut 2026-10a --dir <encoded files>
 * --no-upload prepares the manifest offline; it does not publish any assets.
 * CF_CLI can name the cf CLI's JS entry point when its executable is not on PATH.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";

import { BACKGROUND_WALLPAPERS, BACKGROUND_WIDTHS } from "../../src/lib/background-media.ts";

const { values } = parseArgs({
	options: {
		cut: { type: "string" },
		dir: { type: "string" },
		"no-upload": { type: "boolean" },
	},
});
if (!values.dir || !values.cut || !/^[0-9a-z-]+$/.test(values.cut)) {
	throw new Error(
		"usage: publish-backgrounds.mjs --cut <folder> --dir <encoded files> [--no-upload]",
	);
}
const root = resolve(import.meta.dirname, "../..");
const dir = resolve(values.dir);
// Reuse the existing public /loops/ namespace and its year-long edge cache.
const prefix = `loops/backgrounds/${values.cut}/`;
const names = BACKGROUND_WALLPAPERS.flatMap((_, index) =>
	BACKGROUND_WIDTHS.flatMap((width) =>
		["avif", "webp"].map((format) => `bg-${index + 1}-${width}.${format}`),
	),
);
const actual = readdirSync(dir).filter((name) => /\.(avif|webp)$/.test(name));
if (actual.length !== names.length || actual.some((name) => !names.includes(name))) {
	throw new Error("Incomplete or unexpected background variants; nothing uploaded or written");
}
const files = {};
const hashes = {};
for (const name of names) {
	const bytes = readFileSync(join(dir, name));
	const image = await sharp(bytes).metadata();
	const width = Number(name.match(/-(\d+)\./)[1]);
	if (
		image.width !== width ||
		image.height !== Math.round((width * 9) / 16) ||
		bytes.length > 120_000
	) {
		throw new Error(`${name}: unexpected dimensions or exceeds 120 KB`);
	}
	files[name] = {
		bytes: bytes.length,
		width: image.width,
		height: image.height,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	hashes[name] = createHash("md5").update(bytes).digest("hex");
}

if (!values["no-upload"]) {
	const cf = (args) =>
		execFileSync(
			process.env.CF_CLI ? process.execPath : "cf",
			process.env.CF_CLI ? [process.env.CF_CLI, ...args] : args,
			{ encoding: "utf8", maxBuffer: 1 << 24 },
		);
	const listed = JSON.parse(
		cf([
			"r2",
			"objects",
			"list",
			"--bucket-name",
			"openscreen-media",
			"--prefix",
			prefix,
			"--per-page",
			"1000",
		]),
	);
	if (!Array.isArray(listed) || listed.length >= 1000)
		throw new Error("Unrecognized or truncated R2 listing");
	const remote = new Map(listed.map((object) => [object.key.slice(prefix.length), object]));
	for (const [name, object] of remote) {
		if (!files[name] || object.etag.replaceAll('"', "") !== hashes[name]) {
			throw new Error(`${prefix} is already published with different bytes; use a new cut`);
		}
	}
	for (const name of names) {
		if (!remote.has(name)) {
			cf([
				"r2",
				"objects",
				"put",
				`${prefix}${name}`,
				"--bucket-name",
				"openscreen-media",
				"--file",
				join(dir, name),
				"--content-type",
				`image/${name.split(".").at(-1)}`,
				"-q",
			]);
		}
		console.log(`${remote.has(name) ? "already there" : "uploaded"}: ${name}`);
	}
}

const base = `https://media.getopenscreen.com/${prefix.slice(0, -1)}`;
const sources = BACKGROUND_WALLPAPERS.map((wallpaper) => {
	const path = `public/wallpapers/wallpaper${wallpaper}.jpg`;
	return {
		path,
		sha256: createHash("sha256")
			.update(readFileSync(resolve(root, "..", path)))
			.digest("hex"),
	};
});
writeFileSync(
	resolve(root, "media/backgrounds.json"),
	`${JSON.stringify(
		{
			cut: values.cut,
			base,
			sources,
			encoder: {
				sharp: sharp.versions.sharp,
				avif: { quality: 80, effort: 6, chromaSubsampling: "4:4:4", bitdepth: 10 },
				webp: { quality: 90, effort: 6, smartSubsample: true },
			},
			files,
		},
		null,
		"\t",
	)}\n`,
);
const libPath = resolve(root, "src/lib/background-media.ts");
writeFileSync(
	libPath,
	readFileSync(libPath, "utf8").replace(
		/export const BACKGROUND_BASE = "[^"]+";/,
		`export const BACKGROUND_BASE = "${base}";`,
	),
);
console.log(
	`${names.length} variants recorded${values["no-upload"] ? " offline; upload before using the CDN URLs" : " and published"}`,
);
