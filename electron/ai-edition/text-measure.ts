// Text measured in the main process, where the agent's tools run.
//
// The editor sizes a text box with a canvas, in the fonts the compositor draws. Node has no
// canvas, so the agent's `fitTextBox` fell back to an average advance that is too narrow for
// Inter bold, and the compositor wrapped the last word of an agent's title out of its box. This
// reads the same font files instead (`public/fonts` in dev, `<resources>/fonts` packaged, the
// directory `OPENSCREEN_FONTS_DIR` names once the compositor is loaded).

import fs from "node:fs";
import path from "node:path";
import {
	type FontMetrics,
	measureWithFontTables,
	readFontMetrics,
} from "../../src/lib/ai-edition/annotations/fontTables";
import { textFontFile } from "../../src/lib/textFonts";

/** The directories the shipped font files may be in, most specific first. */
function fontDirs(): string[] {
	return [
		process.env.OPENSCREEN_FONTS_DIR,
		process.env.VITE_PUBLIC && path.join(process.env.VITE_PUBLIC, "fonts"),
		process.resourcesPath && path.join(process.resourcesPath, "fonts"),
	].filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
}

const parsed = new Map<string, FontMetrics | null>();

function readFont(file: string): FontMetrics | null {
	if (!parsed.has(file)) {
		let metrics: FontMetrics | null = null;
		try {
			metrics = readFontMetrics(fs.readFileSync(file));
		} catch {
			// Unreadable: measured by the estimate, like a missing file.
		}
		parsed.set(file, metrics);
	}
	return parsed.get(file) ?? null;
}

/** The words of a text annotation, measured in the font files the compositor draws them in. */
export const measureTextInShippedFonts = measureWithFontTables((family, weight) => {
	const name = path.basename(textFontFile(family, weight));
	for (const dir of fontDirs()) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return readFont(file);
	}
	return null;
});
