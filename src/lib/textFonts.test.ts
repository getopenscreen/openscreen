import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TEXT_FONT_FAMILY,
	resolveTextFontFamily,
	TEXT_FONT_FAMILIES,
	textFontFile,
} from "./textFonts";

// `import.meta.url` isn't a file: URL under the test environment's transform.
const PUBLIC_DIR = path.resolve(process.cwd(), "public");

/** English (Windows, Unicode BMP) records of a TrueType file's `name` table, by nameID. */
function fontNames(file: string): Map<number, string> {
	const font = fs.readFileSync(file);
	let table = -1;
	for (let i = 0; i < font.readUInt16BE(4); i++) {
		const record = 12 + i * 16;
		if (font.toString("latin1", record, record + 4) === "name") {
			table = font.readUInt32BE(record + 8);
		}
	}
	const strings = table + font.readUInt16BE(table + 4);
	const names = new Map<number, string>();
	for (let i = 0; i < font.readUInt16BE(table + 2); i++) {
		const [platform, encoding, language, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((at) =>
			font.readUInt16BE(table + 6 + i * 12 + at),
		);
		if (platform === 3 && encoding === 1 && language === 0x409) {
			const utf16be = Buffer.from(font.subarray(strings + offset, strings + offset + length));
			names.set(nameId, utf16be.swap16().toString("utf16le"));
		}
	}
	return names;
}

describe("the text font files", () => {
	it("ship a regular and a bold file per family, each named inside as the picker names it", () => {
		// DirectWrite, CoreText and fontdb all find these files by the family name INSIDE them,
		// so a file whose name table disagrees with the list draws the fallback face again.
		for (const family of TEXT_FONT_FAMILIES) {
			for (const [weight, style] of [
				["normal", "Regular"],
				["bold", "Bold"],
			] as const) {
				const names = fontNames(path.join(PUBLIC_DIR, textFontFile(family, weight)));
				expect(names.get(1)).toBe(family);
				expect(names.get(2)).toBe(style);
			}
		}
	});

	it("ship nothing the picker does not offer, and each family's licence beside it", () => {
		const dir = path.join(PUBLIC_DIR, "fonts");
		const shipped = fs.readdirSync(dir).filter((file) => /\.(ttf|otf)$/i.test(file));
		const offered = TEXT_FONT_FAMILIES.flatMap((family) =>
			(["normal", "bold"] as const).map((weight) => path.basename(textFontFile(family, weight))),
		);
		expect(shipped.sort()).toEqual(offered.sort());
		for (const family of TEXT_FONT_FAMILIES) {
			const licence = fs.readFileSync(
				path.join(dir, `${family.replace(/ /g, "")}-OFL.txt`),
				"utf8",
			);
			expect(licence).toContain("SIL Open Font License, Version 1.1");
		}
	});
});

describe("resolveTextFontFamily", () => {
	it("keeps every family that ships", () => {
		for (const family of TEXT_FONT_FAMILIES) {
			expect(resolveTextFontFamily(family)).toBe(family);
		}
	});

	it("reads a family that no longer ships, or garbage, as the default", () => {
		for (const stored of ["Bebas Neue", "Geist", "Playfair Display", "Arial", "", null, 42]) {
			expect(resolveTextFontFamily(stored)).toBe(DEFAULT_TEXT_FONT_FAMILY);
		}
	});
});
