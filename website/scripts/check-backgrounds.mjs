#!/usr/bin/env node
/** Hold the responsive wallpaper URLs to their immutable publication manifest. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	BACKGROUND_BASE,
	BACKGROUND_WALLPAPERS,
	BACKGROUND_WIDTHS,
} from "../src/lib/background-media.ts";

const manifest = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../media/backgrounds.json"), "utf8"),
);
const live = process.argv.includes("--live");
const problems = [];
if (manifest.base !== BACKGROUND_BASE)
	problems.push("background manifest and code point at different cuts");
const names = BACKGROUND_WALLPAPERS.flatMap((_, index) =>
	BACKGROUND_WIDTHS.flatMap((width) =>
		["avif", "webp"].map((format) => `bg-${index + 1}-${width}.${format}`),
	),
);
if (Object.keys(manifest.files).length !== names.length)
	problems.push("unexpected number of variants");
for (const name of names) {
	const file = manifest.files[name];
	const width = Number(name.match(/-(\d+)\./)[1]);
	if (
		!file ||
		file.width !== width ||
		file.height !== Math.round((width * 9) / 16) ||
		file.bytes <= 0 ||
		file.bytes > 120_000 ||
		!/^[a-f0-9]{64}$/.test(file.sha256)
	) {
		problems.push(`${name}: missing or invalid publication record`);
	}
}
if (live && problems.length === 0) {
	// Share the video's conservative pacing, below the zone's 120 requests / 10 s.
	for (let offset = 0; offset < names.length; offset += 6) {
		if (offset) await new Promise((resolve) => setTimeout(resolve, 750));
		await Promise.all(
			names.slice(offset, offset + 6).map(async (name) => {
				try {
					const response = await fetch(`${BACKGROUND_BASE}/${name}`, {
						method: "HEAD",
						signal: AbortSignal.timeout(15_000),
					});
					if (!response.ok) problems.push(`${name}: HTTP ${response.status}`);
					else if (
						Number(response.headers.get("content-length")) !== manifest.files[name].bytes ||
						response.headers.get("content-type")?.split(";")[0] !==
							`image/${name.split(".").at(-1)}`
					) {
						problems.push(`${name}: served size or format differs from its record`);
					}
				} catch (error) {
					problems.push(`${name}: ${error.message}`);
				}
			}),
		);
	}
}
if (problems.length) throw new Error(`Backgrounds: ${problems.join("\n")}`);
console.log(
	`Backgrounds OK: ${names.length} variants${live ? ", all live at their recorded sizes" : ""}`,
);
