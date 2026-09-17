#!/usr/bin/env node
/**
 * Keeps the seven translations in step with the English site.
 *
 *   node scripts/i18n.mjs check          which translations are behind (CI: warnings only)
 *   node scripts/i18n.mjs sync           add new code.json ids, drop removed ones, copy descriptions
 *   node scripts/i18n.mjs sync --accept  after translating: record the English strings as done
 *
 * Two kinds of source, two ways of telling that a translation is behind:
 *
 *   Markdown (docs/, src/pages/): git. A translation is behind when its English
 *   source was last changed by a later commit than the translation was. "Later"
 *   is the order in `git log`, not the commit time: a rebase-merge gives every
 *   commit of a pull request the same timestamp. Translating a
 *   file means committing it, which is also what clears the flag. A missing
 *   translation is not reported here: docusaurus.config.ts fails the build.
 *
 *   Strings (<Translate> in .tsx, gathered into each locale's code.json): git
 *   cannot see an id change inside a JSON file, so i18n/code.source.json keeps
 *   the English message every translation was last brought up to. An id whose
 *   English differs from that snapshot, or is not in it yet, is behind in every
 *   locale until `sync --accept` records it. The snapshot lives outside
 *   i18n/en/ on purpose: Docusaurus would serve an i18n/en/code.json to English
 *   readers, stale strings included.
 *
 * `check` never fails. A typo fixed in English should not block a deploy; the
 * warnings say what to hand to a translator (i18n/TRANSLATING.md).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const I18N = join(ROOT, "i18n");
const SNAPSHOT = join(I18N, "code.source.json");

// Keep in step with TRANSLATED_SOURCES in docusaurus.config.ts.
const MARKDOWN = [
	{ source: "docs", target: "docusaurus-plugin-content-docs/current" },
	{ source: "src/pages", target: "docusaurus-plugin-content-pages" },
];

const isThemeId = (id) => id.startsWith("theme.");
const locales = () =>
	readdirSync(I18N, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "en")
		.map((entry) => entry.name)
		.sort();
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

function docusaurus(args, locale) {
	execFileSync(
		process.execPath,
		[join(ROOT, "node_modules/@docusaurus/core/bin/docusaurus.mjs"), ...args],
		{
			cwd: ROOT,
			// write-translations does not set it itself, and the config reads it.
			env: { ...process.env, DOCUSAURUS_CURRENT_LOCALE: locale },
			stdio: ["ignore", "ignore", "inherit"],
		},
	);
}

/** The English <Translate> strings as the source code has them now. */
function englishStrings() {
	const dir = join(I18N, "en");
	const existed = existsSync(dir);
	docusaurus(["write-translations", "--locale", "en"], "en");
	try {
		return readJson(join(dir, "code.json"));
	} finally {
		if (!existed) rmSync(dir, { recursive: true, force: true });
	}
}

/** For every file under the website, how many commits ago it last changed (0 = HEAD). */
function lastChangeAge() {
	const log = execFileSync("git", ["log", "--format=%x00", "--name-only", "--", "."], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
		cwd: ROOT,
		encoding: "utf8",
	}).trim();
	const ages = new Map();
	for (const [age, entry] of log.split("\0").slice(1).entries()) {
		for (const file of entry.trim().split("\n")) {
			const path = file.startsWith(prefix) ? file.slice(prefix.length) : file;
			if (path && !ages.has(path)) ages.set(path, age);
		}
	}
	return ages;
}

function check() {
	const stale = [];
	const ages = lastChangeAge();
	for (const { source, target } of MARKDOWN) {
		const files = readdirSync(join(ROOT, source), { recursive: true, encoding: "utf8" })
			.map((file) => file.replaceAll("\\", "/"))
			.filter((file) => /\.mdx?$/.test(file));
		for (const file of files) {
			// Uncommitted English counts as the newest change of all.
			const sourceAge = ages.get(`${source}/${file}`) ?? -1;
			for (const locale of locales()) {
				const translation = `i18n/${locale}/${target}/${file}`;
				const translationAge = ages.get(translation);
				if (translationAge !== undefined && sourceAge < translationAge) {
					stale.push({
						file: translation,
						why: `${source}/${file} changed since it was translated`,
					});
				}
			}
		}
	}

	const english = englishStrings();
	const done = existsSync(SNAPSHOT) ? readJson(SNAPSHOT) : {};
	const changed = Object.keys(english).filter(
		(id) => !isThemeId(id) && english[id].message !== done[id],
	);
	if (changed.length > 0) {
		const shown = changed.slice(0, 8).join(", ");
		const more = changed.length > 8 ? ` and ${changed.length - 8} more` : "";
		stale.push({
			file: "i18n/code.source.json",
			why: `${changed.length} English string(s) changed or added since the last \`npm run i18n:sync -- --accept\`, in every locale's code.json: ${shown}${more}`,
		});
	}

	for (const { file, why } of stale) {
		const line = `${file}: ${why}`;
		console.log(process.env.GITHUB_ACTIONS ? `::warning file=website/${file}::${why}` : line);
	}
	console.log(
		stale.length === 0
			? "Translations are up to date."
			: `${stale.length} translation(s) behind English; see i18n/TRANSLATING.md.`,
	);
}

function sync(accept) {
	const english = englishStrings();
	for (const locale of locales()) {
		// Adds the ids the source gained, with their English message as a placeholder.
		docusaurus(["write-translations", "--locale", locale], locale);
		const file = join(I18N, locale, "code.json");
		const strings = readJson(file);
		for (const id of Object.keys(strings)) {
			if (!(id in english)) {
				delete strings[id];
				continue;
			}
			const { description } = english[id];
			if (description === undefined) delete strings[id].description;
			else strings[id].description = description;
		}
		writeJson(file, strings);
		const untranslated = Object.keys(strings).filter(
			(id) => !isThemeId(id) && strings[id].message === english[id].message,
		);
		console.log(`${locale}: ${untranslated.length} string(s) still equal to the English`);
	}
	if (accept) {
		const snapshot = Object.fromEntries(
			Object.entries(english)
				.filter(([id]) => !isThemeId(id))
				.map(([id, { message }]) => [id, message]),
		);
		writeJson(SNAPSHOT, snapshot);
		console.log(
			`Recorded ${Object.keys(snapshot).length} English strings in i18n/code.source.json.`,
		);
	}
}

const [command, flag] = process.argv.slice(2);
if (command === "check") check();
else if (command === "sync") sync(flag === "--accept");
else {
	console.error("usage: node scripts/i18n.mjs check | sync [--accept]");
	process.exit(2);
}
