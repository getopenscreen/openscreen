// Où vit une annotation sur l'image, et les conversions entre ses deux repères.
//
// Texte, image et flèche se placent sur le CADRE de sortie (`space: "frame"`), comme les
// sous-titres depuis #396 : ni le padding ni la taille du footage ne les déplacent, et elles vont
// où l'on veut, fond compris. Le flou reste mesuré sur le FOOTAGE (pas de `space`) : un masque de
// confidentialité doit rester sur ce qu'il cache quand le padding redimensionne l'enregistrement
// dessous, et le compositeur le fait suivre le zoom et l'inclinaison 3D sur cette base
// (`FrameGeometry::privacy_mask`).
//
// Une annotation enregistrée avant ce changement n'a pas de `space` et se dessine toujours sur le
// footage, comme avant. L'éditeur la passe dans le cadre la première fois qu'on touche à sa
// géométrie (`toFrameSpace`) : c'est le seul moment où la conversion ne peut surprendre personne.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { clampToBound } from "@/lib/projectDefaults";
import { resolveTextFontFamily } from "@/lib/textFonts";
import { ANNOTATION_REFERENCE_HEIGHT } from "../annotationScale";

type Region = AxcutAnnotationRegion;
type Geometry = Pick<Region, "position" | "size">;

/** Un rect en fractions (0..1) du cadre de sortie : la forme de `layout.screenRect` dans la scène. */
export interface FrameRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Un rect en pourcentages de sa boîte de référence, comme `position` et `size` dans le document. */
interface PctRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Taille d'une image, d'une flèche ou d'un flou neufs, en % de leur boîte de référence. */
export const DEFAULT_ANNOTATION_BOX = { width: 30, height: 20 } as const;

/** Le repère d'un type : le cadre, sauf pour le flou. */
export function belongsInFrame(type: Region["type"]): boolean {
	return type !== "blur";
}

const rectOf = (region: Geometry): PctRect => ({
	x: region.position.x,
	y: region.position.y,
	width: region.size.width,
	height: region.size.height,
});

const centerOf = (rect: PctRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Un rect de `width` × `height` centré sur `center`, poussé dans sa boîte tant qu'il y tient. Plus
 * grand qu'elle, il part du bord gauche ou haut : le schéma refuse une position négative.
 */
function around(center: { x: number; y: number }, width: number, height: number): Geometry {
	const w = Math.max(width, 0.1);
	const h = Math.max(height, 0.1);
	return {
		position: {
			x: clamp(center.x - w / 2, 0, Math.max(0, 100 - w)),
			y: clamp(center.y - h / 2, 0, Math.max(0, 100 - h)),
		},
		size: { width: w, height: h },
	};
}

const within = (rect: PctRect): Geometry => around(centerOf(rect), rect.width, rect.height);

/** Un rect en % du footage, reporté en % du cadre. */
function footageToFrame(rect: PctRect, footage: FrameRect): PctRect {
	return {
		x: footage.x * 100 + rect.x * footage.width,
		y: footage.y * 100 + rect.y * footage.height,
		width: rect.width * footage.width,
		height: rect.height * footage.height,
	};
}

/** Un rect en % du cadre, reporté en % du footage. */
function frameToFootage(rect: PctRect, footage: FrameRect): PctRect {
	return {
		x: (rect.x - footage.x * 100) / footage.width,
		y: (rect.y - footage.y * 100) / footage.height,
		width: rect.width / footage.width,
		height: rect.height / footage.height,
	};
}

/**
 * Le patch qui passe une annotation du footage au cadre sans la bouger d'un pixel : son rect est
 * reporté dans le cadre à travers `footage`, et la taille du texte, mesurée sur la hauteur de la
 * boîte de référence (`annotationScale.ts`), suit le même rapport. `null` pour une annotation déjà
 * dans le cadre, et pour un flou, qui n'en sort jamais.
 */
export function toFrameSpace(region: Region, footage: FrameRect): Partial<Region> | null {
	if (region.space === "frame" || !belongsInFrame(region.type)) return null;
	if (!(footage.width > 0 && footage.height > 0)) return null;
	return {
		space: "frame",
		...within(footageToFrame(rectOf(region), footage)),
		style: {
			...region.style,
			fontSize: Math.round(
				clampToBound(region.style.fontSize * footage.height, "annotationFontSize"),
			),
		},
	};
}

/** Le bloc qu'un texte occupe, en px à `ANNOTATION_REFERENCE_HEIGHT` : l'unité de `fontSize`. */
export interface TextBlock {
	width: number;
	height: number;
}

export type MeasureText = (content: string, style: Region["style"]) => TextBlock;

// Sans canvas (les tests), une estimation : chasse moyenne d'une police proportionnelle,
// interligne des familles livrées.
const FALLBACK_ADVANCE_EM = 0.56;
const FALLBACK_LINE_EM = 1.25;

let measuringContext: OffscreenCanvasRenderingContext2D | null | undefined;

/** `OffscreenCanvas` : il lit les polices de `document.fonts`, et jsdom n'en a pas. */
function measuringCanvas(): OffscreenCanvasRenderingContext2D | null {
	if (measuringContext === undefined) {
		measuringContext =
			typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
	}
	return measuringContext;
}

/** La police CSS d'un style, dans la famille que le compositeur dessinera vraiment. */
export function textCssFont(style: Region["style"]): string {
	const italic = style.fontStyle === "italic" ? "italic " : "";
	const bold = style.fontWeight === "bold" ? "bold " : "";
	return `${italic}${bold}${style.fontSize}px "${resolveTextFontFamily(style.fontFamily)}"`;
}

/**
 * Mesure un texte dans les fichiers de police que le compositeur charge lui aussi
 * (`registerTextFontFaces`). Une ligne par retour à la ligne saisi : une annotation ne revient
 * jamais à la ligne d'elle-même, sa boîte est taillée sur sa ligne la plus longue.
 */
export const measureTextBlock: MeasureText = (content, style) => {
	const size = style.fontSize;
	const lines = content.split("\n");
	const ctx = measuringCanvas();
	if (!ctx) {
		const longest = Math.max(0, ...lines.map((line) => [...line].length));
		return {
			width: longest * FALLBACK_ADVANCE_EM * size,
			height: lines.length * FALLBACK_LINE_EM * size,
		};
	}
	ctx.font = textCssFont(style);
	const font = ctx.measureText("");
	const line = font.fontBoundingBoxAscent + font.fontBoundingBoxDescent;
	return {
		width: Math.max(0, ...lines.map((text) => ctx.measureText(text).width)),
		height: lines.length * (Number.isFinite(line) && line > 0 ? line : FALLBACK_LINE_EM * size),
	};
};

// La plaque déborde du texte de 0,2 em à gauche et à droite, de 0,1 em dessus et dessous
// (`crates/compositor/src/text_plate.rs`) : la boîte la contient, sinon le compositeur la rogne.
const PLATE_PAD_X_EM = 0.2;
const PLATE_PAD_Y_EM = 0.1;
// Marge de mesure. Le compositeur compose le texte dans la boîte et passe à la ligne dès qu'une
// ligne dépasse : mesurée ici par Chromium, là par DirectWrite, CoreText ou cosmic-text, une
// largeur peut différer d'un cheveu, et une boîte juste à un cheveu près envoie le dernier mot à
// la ligne suivante.
const MEASURE_SLACK_EM = 0.25;
// Une annotation vidée garde une boîte qu'on peut encore attraper.
const MIN_TEXT_WIDTH_EM = 1;

/**
 * Le rect d'un texte dans le cadre, taillé sur ses mots : ce qu'on sélectionne est le texte, pas
 * une boîte cinq fois plus grande que lui. Le centre ne bouge pas. `frameAspect` = largeur sur
 * hauteur du cadre de sortie.
 */
export function fitTextBox(
	region: Region,
	frameAspect: number,
	measure: MeasureText = measureTextBlock,
): Geometry {
	const size = region.style.fontSize;
	// Le même texte que celui que la scène envoie au compositeur (`sceneDescription.ts`).
	const block = measure(region.content || region.textContent || "", region.style);
	const widthPx =
		Math.max(block.width, MIN_TEXT_WIDTH_EM * size) +
		(2 * PLATE_PAD_X_EM + MEASURE_SLACK_EM) * size;
	const heightPx = block.height + (2 * PLATE_PAD_Y_EM + MEASURE_SLACK_EM / 2) * size;
	const aspect = frameAspect > 0 ? frameAspect : 16 / 9;
	return around(
		centerOf(rectOf(region)),
		(widthPx / (ANNOTATION_REFERENCE_HEIGHT * aspect)) * 100,
		(heightPx / ANNOTATION_REFERENCE_HEIGHT) * 100,
	);
}

/**
 * Patch à appliquer quand l'utilisateur change le type d'une annotation.
 *
 * `content` est un slot UNIQUE partagé par le texte et l'image : la zone de saisie y écrit, et le
 * rendu d'image y lit une data URL. Changer de type sans déplacer la valeur déversait donc le
 * base64 de l'image, souvent plusieurs mégaoctets, dans le champ texte. Chaque contenu est rangé
 * dans son slot typé (`textContent` / `imageContent`) en sortant et restauré en entrant, si bien
 * qu'un aller-retour entre deux types ne perd rien.
 *
 * La géométrie change de repère avec le type (le flou vit sur le footage, le reste dans le cadre)
 * sans bouger à l'image, à travers `footage`, le rect du footage dans le cadre. Une boîte de texte
 * épouse ses mots, bien trop petite pour une image, une flèche ou un flou : ceux-là repartent de la
 * taille par défaut, centrés au même endroit. `footage` inconnu (aucun clip sous l'annotation) :
 * les nombres restent tels quels, et un flou quitte le cadre quand même.
 */
export function convertAnnotationKind(
	region: Region,
	next: Region["type"],
	context: { footage: FrameRect | null; frameAspect: number; measure?: MeasureText },
): Partial<Region> {
	if (region.type === next) return {};
	const parked: Partial<Region> =
		region.type === "text"
			? { textContent: region.content ?? "" }
			: region.type === "image"
				? { imageContent: region.content ?? "" }
				: {};
	// Flèche et flou n'ont pas de contenu : on vide `content` plutôt que d'y laisser traîner le
	// texte ou le base64 du type précédent.
	const restored =
		next === "text"
			? (region.textContent ?? "")
			: next === "image"
				? (region.imageContent ?? "")
				: "";
	const content: Partial<Region> = { ...parked, type: next, content: restored };

	const { footage } = context;
	const usable = footage && footage.width > 0 && footage.height > 0 ? footage : null;
	const onFrame =
		region.space === "frame"
			? rectOf(region)
			: usable
				? footageToFrame(rectOf(region), usable)
				: null;
	// Sans footage par où convertir, les nombres restent ; mais un flou ne vit jamais dans le cadre.
	if (!onFrame || !usable) return belongsInFrame(next) ? content : { ...content, space: undefined };
	const center = centerOf(onFrame);
	const fromText = region.type === "text";

	if (!belongsInFrame(next)) {
		const inFootage = frameToFootage(onFrame, usable);
		return {
			...content,
			space: undefined,
			...(fromText
				? around(centerOf(inFootage), DEFAULT_ANNOTATION_BOX.width, DEFAULT_ANNOTATION_BOX.height)
				: within(inFootage)),
		};
	}
	if (next === "text") {
		const placed: Region = {
			...region,
			...content,
			position: { x: onFrame.x, y: onFrame.y },
			size: { width: onFrame.width, height: onFrame.height },
		};
		return {
			...content,
			space: "frame",
			...fitTextBox(placed, context.frameAspect, context.measure),
		};
	}
	return {
		...content,
		space: "frame",
		...(fromText
			? around(center, DEFAULT_ANNOTATION_BOX.width, DEFAULT_ANNOTATION_BOX.height)
			: within(onFrame)),
	};
}

/**
 * Les annotations du cadre après un changement de format, de `fromAspect` à `toAspect` (largeur
 * sur hauteur). Chacune garde son centre, et sa forme à l'image : sa largeur est mesurée, comme
 * la police, sur la hauteur du cadre. Sans ça, un texte taillé en 16:9 garde en 9:16 le même
 * pourcentage d'une largeur trois fois plus petite en pixels, et le compositeur le renvoie à la
 * ligne ; une flèche penche. Celle qui ne tiendrait plus en largeur est réduite pour y tenir. Le
 * reste ne bouge pas : un flou suit le footage, qui garde son ratio.
 */
export function refitFrameAnnotations<T extends Region>(
	annotations: T[],
	fromAspect: number,
	toAspect: number,
): T[] {
	if (!(fromAspect > 0 && toAspect > 0) || Math.abs(fromAspect - toAspect) < 1e-6) {
		return annotations;
	}
	const scale = fromAspect / toAspect;
	return annotations.map((annotation) => {
		if (annotation.space !== "frame") return annotation;
		const rect = rectOf(annotation);
		const width = rect.width * scale;
		// Plus large que le nouveau cadre : réduite d'un bloc, son texte avec elle, pour rester à
		// l'image au lieu d'en déborder.
		const shrink = Math.min(1, 100 / width);
		const refit = {
			...annotation,
			...around(centerOf(rect), width * shrink, rect.height * shrink),
		};
		if (shrink === 1 || annotation.type !== "text") return refit;
		// Arrondie vers le bas : un texte plus grand d'un cheveu que sa boîte réduite passerait à la
		// ligne.
		const fontSize = clampToBound(
			Math.floor(annotation.style.fontSize * shrink),
			"annotationFontSize",
		);
		return { ...refit, style: { ...annotation.style, fontSize } };
	});
}
