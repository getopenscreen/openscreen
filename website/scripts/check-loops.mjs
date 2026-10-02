#!/usr/bin/env node
/**
 * Holds the demo loops the site uses to what is actually published.
 *
 *   node scripts/check-loops.mjs          the record agrees with the code
 *   node scripts/check-loops.mjs --live   ... and every file answers, at its size
 *
 * The loops are served from R2, not from git, so nothing else in CI would
 * notice a loop the pages name but nobody uploaded, or a cut folder the code
 * points at that holds the wrong files: the page would just show an empty box.
 *
 * Offline it compares src/lib/demo-loop.ts (the names the pages use, the base
 * URL, the durations the VideoObject markup declares) with media/loops.json
 * (what scripts/media/publish-loops.mjs uploaded). --live then asks the CDN
 * for every file in the record, a HEAD each, and compares the length.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LOOP_BASE, LOOP_DURATIONS, LOOP_NAMES } from "../src/lib/demo-loop.ts";

const ROOT = resolve(import.meta.dirname, "..");
const live = process.argv.includes("--live");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "media/loops.json"), "utf8"));

const problems = [];
const VARIANTS = ["1080-hevc.mp4", "1080-h264.mp4", "720-hevc.mp4", "720-h264.mp4", "poster.webp"];

if (manifest.base !== LOOP_BASE) {
	problems.push(`LOOP_BASE is ${LOOP_BASE}, media/loops.json records ${manifest.base}`);
}
for (const name of LOOP_NAMES) {
	for (const v of VARIANTS) {
		if (!manifest.files[`${name}-${v}`])
			problems.push(`${name}-${v}: used by the site, not published`);
	}
	if (LOOP_DURATIONS[name] !== manifest.durations[name]) {
		problems.push(
			`${name}: duration ${LOOP_DURATIONS[name]} in demo-loop.ts, ${manifest.durations[name]} in media/loops.json`,
		);
	}
}
const used = new Set(LOOP_NAMES);
const unused = Object.keys(manifest.durations).filter((n) => !used.has(n));

if (live && problems.length === 0) {
	const entries = Object.entries(manifest.files);
	// Paced, not just batched: the zone blocks one address for 10 s past 120
	// requests in 10 s, and a CI runner is one address. Six requests every
	// 0.75 s keeps under 80 per window however many loops there are.
	for (let i = 0; i < entries.length; i += 6) {
		if (i > 0) await new Promise((r) => setTimeout(r, 750));
		await Promise.all(
			entries.slice(i, i + 6).map(async ([name, { bytes }]) => {
				const url = `${manifest.base}/${name}`;
				let res;
				for (let attempt = 0; attempt < 2 && !res?.ok; attempt++) {
					try {
						res = await fetch(url, { method: "HEAD" });
					} catch (err) {
						if (attempt === 1) problems.push(`${url}: ${err.message}`);
					}
				}
				if (!res) return;
				const length = Number(res.headers.get("content-length"));
				if (!res.ok) problems.push(`${url}: HTTP ${res.status}`);
				else if (length !== bytes) problems.push(`${url}: ${length} B served, ${bytes} B recorded`);
			}),
		);
	}
}

if (problems.length) {
	console.error(`demo loops: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
	console.error(
		"Publish with scripts/media/publish-loops.mjs (it writes both records), or fix the name in the page.",
	);
	process.exit(1);
}
const files = Object.keys(manifest.files).length;
console.log(
	`demo loops ok — ${LOOP_NAMES.length} loops, ${files} files in ${manifest.cut}${live ? ", all live at their recorded size" : ""}` +
		(unused.length ? ` (published but unused: ${unused.join(", ")})` : ""),
);
