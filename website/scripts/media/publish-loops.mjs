#!/usr/bin/env node
/**
 * Publishes a cut of the demo loops to R2 and records it.
 *
 *   node scripts/media/publish-loops.mjs --cut 2026-10b --dir <encoded files> [--no-upload]
 *
 * <dir> holds what scripts/media/encode-loops.sh writes: for every loop,
 * <name>-{1080,720}-{hevc,h264}.mp4 and <name>-poster.webp.
 *
 * The bytes never enter git (scripts/check-media-budget.mjs says why). What
 * does is the record of them, written here:
 *
 *   media/loops.json      every published file's size and SHA-256, and each
 *                         loop's duration: scripts/check-loops.mjs holds the
 *                         live files to it in CI.
 *   src/lib/demo-loop.ts  the block between the @generated markers: the cut's
 *                         base URL and the durations the VideoObject markup
 *                         declares.
 *
 * A cut is a folder and is never rewritten: the edge caches it for a year, and
 * an earlier commit's pages still point at the earlier folder. A new encode is
 * a new --cut. Upload BEFORE anything points at the folder: the zone caches a
 * 404 for an hour.
 *
 * Two refusals, both before anything is uploaded or written:
 *   - an incomplete cut: every loop the site names (LOOP_NAMES), and every
 *     loop in <dir>, must have all five files;
 *   - a rewrite: if the folder already holds objects, each must be byte-equal
 *     to the local file of the same name (R2's ETag is the MD5 of a single-part
 *     upload) and the folder must hold nothing <dir> lacks. Equal files are not
 *     re-sent, so re-running after an interrupted upload is safe.
 *
 * Needs the `cf` CLI logged in to the account that owns getopenscreen.com, and
 * ffprobe (FFPROBE, or on PATH) for the durations.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { LOOP_NAMES } from "../../src/lib/demo-loop.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const BUCKET = "openscreen-media";
const ORIGIN = "https://media.getopenscreen.com";

const { values: opts } = parseArgs({
	options: {
		cut: { type: "string" },
		dir: { type: "string" },
		"no-upload": { type: "boolean", default: false },
	},
});
if (!opts.cut || !opts.dir) {
	console.error("usage: publish-loops.mjs --cut <folder> --dir <encoded files> [--no-upload]");
	process.exit(2);
}
if (!/^[0-9a-z-]+$/.test(opts.cut))
	throw new Error(`--cut must be a plain folder name, got ${opts.cut}`);

const dir = resolve(opts.dir);
const names = readdirSync(dir)
	.filter((f) => /\.(mp4|webp)$/.test(f))
	.sort();
const FILE = /^(.+)-(?:(?:1080|720)-(?:hevc|h264)\.mp4|poster\.webp)$/;

const files = {};
const durations = {};
for (const name of names) {
	const m = FILE.exec(name);
	if (!m)
		throw new Error(
			`${name}: not a loop file (<name>-<1080|720>-<hevc|h264>.mp4 or <name>-poster.webp)`,
		);
	const path = join(dir, name);
	files[name] = {
		bytes: statSync(path).size,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
	if (name.endsWith("-1080-h264.mp4")) {
		const out = execFileSync(
			process.env.FFPROBE ?? "ffprobe",
			["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
			{ encoding: "utf8" },
		);
		durations[m[1]] = Math.round(Number.parseFloat(out) * 100) / 100;
	}
}

// ── refuse an incomplete cut ──────────────────────────────────────────────
const VARIANTS = ["1080-hevc.mp4", "1080-h264.mp4", "720-hevc.mp4", "720-h264.mp4", "poster.webp"];
const slugs = new Set([...LOOP_NAMES, ...names.map((n) => FILE.exec(n)[1])]);
const missing = [...slugs].flatMap((slug) =>
	VARIANTS.map((v) => `${slug}-${v}`).filter((f) => !files[f]),
);
if (missing.length) {
	console.error(`incomplete cut, nothing uploaded or written:\n  ${missing.join("\n  ")}`);
	process.exit(1);
}

if (!opts["no-upload"]) {
	// ── refuse to rewrite a published cut ───────────────────────────────────
	const listed = JSON.parse(
		execFileSync(
			"cf",
			[
				"r2",
				"objects",
				"list",
				"--bucket-name",
				BUCKET,
				"--prefix",
				`loops/${opts.cut}/`,
				"--per-page",
				"1000",
			],
			{ encoding: "utf8", maxBuffer: 1 << 26 },
		),
	);
	if (listed.length >= 1000)
		throw new Error("more than 1000 objects under one cut: paginate before trusting this check");
	const remote = new Map(listed.map((o) => [o.key.slice(`loops/${opts.cut}/`.length), o]));
	const md5 = (name) =>
		createHash("md5")
			.update(readFileSync(join(dir, name)))
			.digest("hex");
	const changed = names.filter(
		(n) => remote.has(n) && remote.get(n).etag.replaceAll('"', "") !== md5(n),
	);
	const extra = [...remote.keys()].filter((n) => !files[n]);
	if (changed.length || extra.length) {
		console.error(
			`loops/${opts.cut}/ is already published and differs; a published cut is never rewritten. Use a new --cut.` +
				(changed.length ? `\n  different bytes: ${changed.join(", ")}` : "") +
				(extra.length ? `\n  online but not in --dir: ${extra.join(", ")}` : ""),
		);
		process.exit(1);
	}
	for (const name of names) {
		if (remote.has(name)) {
			console.log("already there", name);
			continue;
		}
		execFileSync(
			"cf",
			[
				"r2",
				"objects",
				"put",
				`loops/${opts.cut}/${name}`,
				"--bucket-name",
				BUCKET,
				"--file",
				join(dir, name),
				"--content-type",
				name.endsWith(".webp") ? "image/webp" : "video/mp4",
				"-q",
			],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		console.log("uploaded", name);
	}
}

const base = `${ORIGIN}/loops/${opts.cut}`;
// The day the cut went up; re-running on the same cut keeps it.
const manifestPath = join(ROOT, "media/loops.json");
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const published =
	previous?.cut === opts.cut ? previous.published : new Date().toISOString().slice(0, 10);
writeFileSync(
	manifestPath,
	`${JSON.stringify({ cut: opts.cut, base, published, durations, files }, null, "\t")}\n`,
);

// The generated block in demo-loop.ts: everything between the two markers is
// rewritten, nothing outside them is touched.
const libPath = join(ROOT, "src/lib/demo-loop.ts");
const lib = readFileSync(libPath, "utf8");
const START = "// @generated by scripts/media/publish-loops.mjs: start";
const END = "// @generated by scripts/media/publish-loops.mjs: end";
const a = lib.indexOf(START);
const b = lib.indexOf(END);
if (a < 0 || b < a) throw new Error(`${libPath}: the @generated markers are missing`);
const block = [
	START,
	`export const LOOP_BASE = "${base}";`,
	"",
	"/** Seconds, from the 1080p H.264 file of each loop. */",
	"export const LOOP_DURATIONS: Record<string, number> = {",
	...Object.entries(durations).map(([k, v]) => `\t"${k}": ${v},`),
	"};",
	"",
	"/** When this cut was published: the VideoObject uploadDate. */",
	`export const LOOP_PUBLISHED = "${published}";`,
].join("\n");
writeFileSync(libPath, lib.slice(0, a) + block + "\n" + lib.slice(b));

console.log(
	`${names.length} files, ${Object.keys(durations).length} loops -> media/loops.json, src/lib/demo-loop.ts`,
);
console.log(
	"Run npx biome format --write src/lib/demo-loop.ts, then npm run check:loops -- --live.",
);
