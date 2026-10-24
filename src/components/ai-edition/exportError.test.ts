import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAvailableLocales, translate } from "@/i18n/loader";
import { exportErrorMessage } from "./exportError";

const cases = [
	[
		"No video frames were exported. Check that the clips contain readable video before exporting again.",
		"noReadableFrames",
	],
	[
		"Cannot export clip 12: the camera video ends before this clip starts. Record the camera again or remove its track before exporting.",
		"cameraEnded",
	],
	[
		"Cannot export clip 12: the camera video has no readable frame at the clip's start. Record the camera again or remove its track before exporting.",
		"cameraUnreadable",
	],
	[
		"Cannot export clip 12: the screen video has no readable frame at the clip's start.",
		"screenUnreadable",
	],
	["Cannot export clip 12: could not read the screen video.", "screenUnreadable"],
] as const;

describe("native export error presentation", () => {
	it.each(cases)("localizes %s in every supported language", (message, key) => {
		const native = readFileSync("crates/compositor/src/timeline_walk.rs", "utf8");
		// The bridge currently carries anyhow text. Catch native wording drift here.
		expect(native).toContain(message.replace("clip 12:", "clip {}:"));
		for (const locale of getAvailableLocales()) {
			const t = (key: string, vars?: Record<string, string | number>) =>
				translate(locale, "editor", key, vars);
			const expected = t(`exportDialog.${key}`, { clip: 12 });
			expect(exportErrorMessage(message, t)).toBe(expected);
			expect(expected).not.toContain("exportDialog.");
			expect(expected).not.toContain("{{");
			if (key !== "noReadableFrames") expect(expected).toContain("12");
			if (locale !== "en")
				expect(expected).not.toBe(translate("en", "editor", `exportDialog.${key}`, { clip: 12 }));
		}
	});

	it("translates recognized context chains without exposing decoder internals", () => {
		const t = (key: string, vars?: Record<string, string | number>) =>
			translate("zh-CN", "editor", key, vars);
		for (const [message, key] of cases.slice(2)) {
			expect(exportErrorMessage(`${message}: decoder failed: invalid data`, t)).toBe(
				t(`exportDialog.${key}`, { clip: 12 }),
			);
		}
		for (const detail of [
			"No decoder is available for the exported video.",
			"open exported video: invalid data",
			"The exported video has no decodable displayable frames. The destination has not been replaced.",
		]) {
			for (const locale of getAvailableLocales()) {
				const scoped = (key: string) => translate(locale, "editor", key);
				expect(exportErrorMessage(`validating exported video: ${detail}`, scoped)).toBe(
					scoped("exportDialog.validationFailed"),
				);
			}
		}
	});

	it.each([
		"disk full",
		"Cannot export clip 12: unknown encoder error",
		"cleanup failed: validating exported video: invalid data",
		"[pipeline] warning: shortened clip",
		"Cannot export clip 0: could not read the screen video.",
	])("preserves unrelated errors: %s", (message) => {
		expect(exportErrorMessage(message, () => "wrong diagnosis")).toBe(message);
	});
});
