// Mesurer un texte sans canvas : les chasses lues dans les tables du fichier de police.
//
// L'agent du chat tourne dans le processus principal d'Electron, où il n'y a ni `OffscreenCanvas`
// ni `document.fonts`. `measureTextBlock` y retombait sur une chasse moyenne de 0,56 em, trop
// étroite pour l'Inter gras d'une annotation : « Demo OpenScreen » à 64 px mesurait 538 px pour
// 610 px réels, et le compositeur renvoyait « OpenScreen » à la ligne, hors de la boîte.
//
// Les polices livrées (`public/fonts`) sont des TrueType statiques : `cmap` donne le glyphe d'un
// caractère, `hmtx` sa chasse, `hhea` la hauteur de ligne que Chromium rend dans
// `fontBoundingBoxAscent + fontBoundingBoxDescent`. Le crénage (GPOS) est ignoré : il resserre
// presque toujours, la somme des chasses majore donc la largeur rendue.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { resolveTextFontFamily, type TextFontFamily } from "@/lib/textFonts";
import { type MeasureText, measureTextBlock } from "./placement";

/** Ce qu'il faut d'une police pour mesurer une ligne, en unités de sa grille (`unitsPerEm`). */
export interface FontMetrics {
	unitsPerEm: number;
	/** Hauteur d'une ligne : `hhea.ascender - hhea.descender`. */
	lineHeight: number;
	/** La chasse du glyphe d'un point de code, `null` s'il n'est pas dans la police. */
	advanceOf: (codePoint: number) => number | null;
}

type Table = { offset: number; length: number };

function tablesOf(view: DataView): Map<string, Table> {
	const tables = new Map<string, Table>();
	const count = view.getUint16(4);
	for (let i = 0; i < count; i++) {
		const record = 12 + 16 * i;
		const tag = String.fromCharCode(
			view.getUint8(record),
			view.getUint8(record + 1),
			view.getUint8(record + 2),
			view.getUint8(record + 3),
		);
		tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
	}
	return tables;
}

/** Le glyphe d'un point de code, d'une sous-table `cmap` au format 4 (BMP) ou 12 (tout Unicode). */
function glyphLookup(view: DataView, cmap: Table): ((codePoint: number) => number) | null {
	const count = view.getUint16(cmap.offset + 2);
	let best: { format: number; offset: number } | null = null;
	for (let i = 0; i < count; i++) {
		const record = cmap.offset + 4 + 8 * i;
		const platform = view.getUint16(record);
		const encoding = view.getUint16(record + 2);
		const offset = cmap.offset + view.getUint32(record + 4);
		const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
		if (!unicode) continue;
		const format = view.getUint16(offset);
		if (format === 12) {
			best = { format, offset };
			break;
		}
		if (format === 4 && !best) best = { format, offset };
	}
	if (!best) return null;
	const at = best.offset;
	if (best.format === 12) {
		const groups = view.getUint32(at + 12);
		return (codePoint) => {
			for (let g = 0; g < groups; g++) {
				const group = at + 16 + 12 * g;
				const start = view.getUint32(group);
				if (codePoint < start) return 0;
				if (codePoint <= view.getUint32(group + 4)) {
					return view.getUint32(group + 8) + (codePoint - start);
				}
			}
			return 0;
		};
	}
	const segments = view.getUint16(at + 6) / 2;
	const ends = at + 14;
	const starts = ends + 2 * segments + 2;
	const deltas = starts + 2 * segments;
	const rangeOffsets = deltas + 2 * segments;
	return (codePoint) => {
		if (codePoint > 0xffff) return 0;
		for (let s = 0; s < segments; s++) {
			if (codePoint > view.getUint16(ends + 2 * s)) continue;
			const start = view.getUint16(starts + 2 * s);
			if (codePoint < start) return 0;
			const delta = view.getUint16(deltas + 2 * s);
			const rangeOffset = view.getUint16(rangeOffsets + 2 * s);
			if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
			const glyph = view.getUint16(rangeOffsets + 2 * s + rangeOffset + 2 * (codePoint - start));
			return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
		}
		return 0;
	};
}

/** Les tables d'un fichier TrueType ou OpenType ; `null` pour ce qui n'en est pas un. */
export function readFontMetrics(bytes: Uint8Array): FontMetrics | null {
	try {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const tables = tablesOf(view);
		const head = tables.get("head");
		const hhea = tables.get("hhea");
		const hmtx = tables.get("hmtx");
		const cmap = tables.get("cmap");
		if (!head || !hhea || !hmtx || !cmap) return null;
		const unitsPerEm = view.getUint16(head.offset + 18);
		const lineHeight = view.getInt16(hhea.offset + 4) - view.getInt16(hhea.offset + 6);
		const metrics = view.getUint16(hhea.offset + 34);
		const glyphOf = glyphLookup(view, cmap);
		if (!glyphOf || !(unitsPerEm > 0) || metrics === 0) return null;
		return {
			unitsPerEm,
			lineHeight,
			advanceOf: (codePoint) => {
				const glyph = glyphOf(codePoint);
				if (glyph === 0) return null;
				// Au-delà de `numberOfHMetrics`, chaque glyphe reprend la dernière chasse.
				return view.getUint16(hmtx.offset + 4 * Math.min(glyph, metrics - 1));
			},
		};
	} catch {
		return null;
	}
}

// Un caractère absent de la police est dessiné dans une police de secours (un idéogramme, un
// emoji) : compté pour un cadratin, plutôt large.
const MISSING_ADVANCE_EM = 1;

/**
 * Un `MeasureText` qui lit les chasses dans les polices que le compositeur dessine. `fontFor`
 * donne la police d'une famille et d'une graisse, `null` quand elle manque : ce style-là est
 * alors mesuré par `measureTextBlock`, comme avant.
 */
export function measureWithFontTables(
	fontFor: (family: TextFontFamily, weight: "normal" | "bold") => FontMetrics | null,
): MeasureText {
	return (content: string, style: AxcutAnnotationRegion["style"]) => {
		const font = fontFor(
			resolveTextFontFamily(style.fontFamily),
			style.fontWeight === "bold" ? "bold" : "normal",
		);
		if (!font) return measureTextBlock(content, style);
		const scale = style.fontSize / font.unitsPerEm;
		const lineWidth = (line: string) => {
			let units = 0;
			for (const char of line) {
				const codePoint = char.codePointAt(0) ?? 0;
				units += font.advanceOf(codePoint) ?? MISSING_ADVANCE_EM * font.unitsPerEm;
			}
			return units * scale;
		};
		const lines = content.split("\n");
		try {
			return {
				width: Math.max(0, ...lines.map(lineWidth)),
				height: lines.length * font.lineHeight * scale,
			};
		} catch {
			// Une table tronquée que `readFontMetrics` n'a pas lue (`hmtx` n'est lue qu'à la mesure) :
			// l'estimation, plutôt qu'une erreur qui ferait échouer l'outil de l'agent.
			return measureTextBlock(content, style);
		}
	};
}
