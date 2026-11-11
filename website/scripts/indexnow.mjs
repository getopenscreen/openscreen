#!/usr/bin/env node
// After a deploy, tell Bing (and every other IndexNow engine) which pages just changed,
// instead of waiting for its next crawl. ChatGPT search answers from Bing's index.
//
// Changed = <lastmod> within the last two days in any locale sitemap of the build. The
// sitemap's lastmod comes from `git log` per file (see docs.yml), so an untouched page
// is not resubmitted on every deploy. Two pages always go: llms.txt, which is in no
// sitemap, and /download/, which a release rebuild changes without touching its source.
//
// Usage: node scripts/indexnow.mjs <build dir> [--dry-run]   (--dry-run lists the URLs, sends nothing)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "getopenscreen.com";
// The key is public by design: IndexNow checks it against /<key>.txt on the host.
const KEY = "233520eba1fb46fd9331a9921e77319d";
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** URLs of a sitemap whose <lastmod> falls within WINDOW_MS of `now`. */
function changedUrls(sitemapXml, now = Date.now()) {
	const urls = [];
	for (const [, block] of sitemapXml.matchAll(/<url>(.*?)<\/url>/gs)) {
		const loc = block.match(/<loc>(.*?)<\/loc>/)?.[1];
		const lastmod = block.match(/<lastmod>(.*?)<\/lastmod>/)?.[1];
		if (loc && lastmod && now - Date.parse(lastmod) <= WINDOW_MS) urls.push(loc);
	}
	return urls;
}

/** Paths of the root sitemap and of each locale sitemap (fr/, zh-cn/, …) present in `dir`. */
function sitemaps(dir) {
	const candidates = [join(dir, "sitemap.xml")];
	for (const name of readdirSync(dir)) {
		if (/^[a-z]{2}(-[a-z]{2})?$/.test(name)) candidates.push(join(dir, name, "sitemap.xml"));
	}
	return candidates.filter((path) => existsSync(path));
}

const build = process.argv[2] ?? "build";
const urls = new Set([`https://${HOST}/llms.txt`, `https://${HOST}/download/`]);
for (const file of sitemaps(build)) {
	for (const url of changedUrls(readFileSync(file, "utf8"))) urls.add(url);
}
if (process.argv.includes("--dry-run")) {
	console.log([...urls].join("\n"));
} else {
	const res = await fetch("https://api.indexnow.org/indexnow", {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			host: HOST,
			key: KEY,
			keyLocation: `https://${HOST}/${KEY}.txt`,
			urlList: [...urls],
		}),
	});
	console.log(`IndexNow: ${urls.size} URL(s) sent, HTTP ${res.status}`);
	// 200 and 202 both mean accepted. Anything else fails the step so the rejection shows
	// in the run; the workflow's continue-on-error keeps it from blocking the deploy.
	if (res.status !== 200 && res.status !== 202) {
		console.log(await res.text());
		process.exitCode = 1;
	}
}
