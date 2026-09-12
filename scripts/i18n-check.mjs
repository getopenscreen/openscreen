#!/usr/bin/env node
/**
 * Validates that all locale translation files have identical key structures.
 * Compares all locale folders (except en) against the en baseline for every namespace.
 *
 * Usage: node scripts/i18n-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { objectBody, stripJson5Comments } from "./macos-floor.mjs";

const LOCALES_DIR = path.resolve("src/i18n/locales");
const BASE_LOCALE = "en";

function getKeys(obj, prefix = "") {
	const keys = [];
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			keys.push(...getKeys(value, fullKey));
		} else {
			keys.push(fullKey);
		}
	}
	return keys.sort();
}

let hasErrors = false;

const baseDir = path.join(LOCALES_DIR, BASE_LOCALE);
const namespaces = fs
	.readdirSync(baseDir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => f.replace(".json", ""));

const compareLocales = fs
	.readdirSync(LOCALES_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((locale) => locale !== BASE_LOCALE)
	.sort((a, b) => a.localeCompare(b));

for (const namespace of namespaces) {
	const basePath = path.join(baseDir, `${namespace}.json`);
	const baseData = JSON.parse(fs.readFileSync(basePath, "utf-8"));
	const baseKeys = getKeys(baseData);

	for (const locale of compareLocales) {
		const localePath = path.join(LOCALES_DIR, locale, `${namespace}.json`);

		if (!fs.existsSync(localePath)) {
			console.error(`MISSING: ${locale}/${namespace}.json does not exist`);
			hasErrors = true;
			continue;
		}

		const localeData = JSON.parse(fs.readFileSync(localePath, "utf-8"));
		const localeKeys = getKeys(localeData);

		const missing = baseKeys.filter((k) => !localeKeys.includes(k));
		const extra = localeKeys.filter((k) => !baseKeys.includes(k));

		if (missing.length > 0) {
			console.error(`MISSING in ${locale}/${namespace}.json:`);
			for (const key of missing) {
				console.error(`  - ${key}`);
			}
			hasErrors = true;
		}

		if (extra.length > 0) {
			console.error(`EXTRA in ${locale}/${namespace}.json:`);
			for (const key of extra) {
				console.error(`  + ${key}`);
			}
			hasErrors = true;
		}
	}
}

// Validate that SUPPORTED_LOCALES (src/i18n/config.ts), appx.languages, and
// electronLanguages (electron-builder.json5) all agree on the supported locales.
function readSupportedLocales() {
	const configContent = fs.readFileSync(path.resolve("src/i18n/config.ts"), "utf-8");
	const match = configContent.match(/SUPPORTED_LOCALES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/);
	if (!match) throw new Error("Could not find SUPPORTED_LOCALES in src/i18n/config.ts");
	return match[1]
		.split(",")
		.map((s) => s.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function readBuilderLanguages() {
	const content = fs.readFileSync(path.resolve("electron-builder.json5"), "utf-8");
	const stripped = stripJson5Comments(content);

	const electronLanguagesMatch = stripped.match(/"electronLanguages"\s*:\s*\[([\s\S]*?)\]/);
	if (!electronLanguagesMatch)
		throw new Error("Could not find electronLanguages in electron-builder.json5");
	const electronLanguages = electronLanguagesMatch[1]
		.split(",")
		.map((s) => s.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);

	const appxBlock = objectBody(stripped, "appx");
	if (!appxBlock) throw new Error("Could not find appx block in electron-builder.json5");
	const appxLanguagesMatch = appxBlock.match(/"languages"\s*:\s*\[([\s\S]*?)\]/);
	if (!appxLanguagesMatch)
		throw new Error("Could not find appx.languages in electron-builder.json5");
	const appxLanguages = appxLanguagesMatch[1]
		.split(",")
		.map((s) => s.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);

	return { electronLanguages, appxLanguages };
}

const supportedLocales = readSupportedLocales();
const { electronLanguages, appxLanguages } = readBuilderLanguages();

// 1. Check all disk locales in src/i18n/locales match SUPPORTED_LOCALES
const diskLocales = [BASE_LOCALE, ...compareLocales].sort();
const sortedSupported = [...supportedLocales].sort();

const missingOnDisk = sortedSupported.filter((l) => !diskLocales.includes(l));
const extraOnDisk = diskLocales.filter((l) => !sortedSupported.includes(l));

if (missingOnDisk.length > 0) {
	console.error(
		`MISSING on disk (declared in SUPPORTED_LOCALES but no folder in src/i18n/locales): ${missingOnDisk.join(", ")}`,
	);
	hasErrors = true;
}
if (extraOnDisk.length > 0) {
	console.error(
		`EXTRA on disk (folder in src/i18n/locales but missing in SUPPORTED_LOCALES): ${extraOnDisk.join(", ")}`,
	);
	hasErrors = true;
}

// 2. Check appx.languages matches SUPPORTED_LOCALES
// AppX uses BCP-47 / Windows store language tags: en-US for en, fr-FR for fr, and bare/region tags for the rest.
for (const locale of supportedLocales) {
	const expectedAppx = locale === "en" ? "en-US" : locale === "fr" ? "fr-FR" : locale;
	if (!appxLanguages.includes(expectedAppx)) {
		console.error(
			`MISSING in electron-builder.json5 appx.languages: "${expectedAppx}" (for ${locale})`,
		);
		hasErrors = true;
	}
}

// 3. Check electronLanguages matches SUPPORTED_LOCALES
// Electron/Chromium pak files:
// en -> en-US
// ja-JP -> ja (Chromium ja.pak / macOS ja.lproj)
// ko-KR -> ko (Chromium ko.pak / macOS ko.lproj)
// pt-BR -> requires both "pt-BR" (Windows/Linux) and "pt_BR" (macOS)
// zh-CN -> requires both "zh-CN" and "zh_CN"
// zh-TW -> requires both "zh-TW" and "zh_TW"
// ar, es, it, ru, tr, vi, fr -> matches bare tag
for (const locale of supportedLocales) {
	let expectedElectron = [];
	if (locale === "en") expectedElectron = ["en-US"];
	else if (locale === "ja-JP") expectedElectron = ["ja"];
	else if (locale === "ko-KR") expectedElectron = ["ko"];
	else if (locale === "pt-BR") expectedElectron = ["pt-BR", "pt_BR"];
	else if (locale === "zh-CN") expectedElectron = ["zh-CN", "zh_CN"];
	else if (locale === "zh-TW") expectedElectron = ["zh-TW", "zh_TW"];
	else expectedElectron = [locale];

	for (const expected of expectedElectron) {
		if (!electronLanguages.includes(expected)) {
			console.error(
				`MISSING in electron-builder.json5 electronLanguages: "${expected}" (for ${locale})`,
			);
			hasErrors = true;
		}
	}
}

if (hasErrors) {
	console.error(
		"\ni18n check FAILED — translation files or packaging locale lists are out of sync.",
	);
	process.exit(1);
} else {
	console.log(
		`i18n check PASSED — all ${compareLocales.length} locales match ${BASE_LOCALE} across ${namespaces.length} namespaces, and all ${supportedLocales.length} SUPPORTED_LOCALES align with appx.languages and electronLanguages.`,
	);
}
