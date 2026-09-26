// Le fond d'un bloc de texte : un booléen côté utilisateur, une couleur côté rendu.
//
// Tous les moteurs de rendu (compositeur natif, exporteur canvas, aperçu DOM) lisent
// `style.backgroundColor` et traitent `"transparent"` comme « pas de fond ». Éteindre le fond
// écrase donc la couleur choisie, et le rallumer n'avait plus rien à restaurer : il revenait
// toujours au noir. `lastBackgroundColor` conserve cette couleur, ce qui rend la bascule
// réversible sans donner un second sens à `backgroundColor`.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { textForPlate } from "@/lib/ai-edition/textContrast";

type AnnotationStyle = AxcutAnnotationRegion["style"];

/** Couleur d'un premier allumage, quand l'annotation n'a jamais eu de fond. */
export const DEFAULT_TEXT_BACKGROUND = "#000000";

export function hasTextBackground(style: AnnotationStyle): boolean {
	const color = style.backgroundColor;
	return !!color && color !== "transparent";
}

/**
 * Couleur à afficher dans le sélecteur, fond allumé ou éteint : éteint, on montre la couleur
 * mémorisée plutôt qu'un noir qui ne veut rien dire — c'est bien celle que le rallumage rendra.
 */
export function textBackgroundColor(style: AnnotationStyle): string {
	if (hasTextBackground(style)) return style.backgroundColor;
	const remembered = style.lastBackgroundColor;
	return remembered && remembered !== "transparent" ? remembered : DEFAULT_TEXT_BACKGROUND;
}

/** Style résultant de la bascule du fond, la couleur conservée dans les deux sens. */
export function toggleTextBackground(style: AnnotationStyle, next: boolean): AnnotationStyle {
	const remembered = textBackgroundColor(style);
	return {
		...style,
		backgroundColor: next ? remembered : "transparent",
		lastBackgroundColor: remembered,
	};
}

/**
 * Style résultant du choix d'une couleur de fond. Choisir une couleur allume le fond : c'est ce
 * que le geste veut dire, et laisser le fond éteint donnerait un sélecteur sans effet visible.
 */
export function setTextBackgroundColor(style: AnnotationStyle, color: string): AnnotationStyle {
	return { ...style, backgroundColor: color, lastBackgroundColor: color };
}

/**
 * Les plaques nommées d'une annotation : aucune, sombre, claire. Trois états qu'on voit, au lieu
 * d'une roue qui laissait choisir une plaque de la couleur même du texte. `rgba()` et non un hex
 * à 8 chiffres, la forme que lit le compositeur (`parse_hex`). La sombre est celle que #793 donne
 * à toute annotation neuve.
 */
export const TEXT_PLATES = {
	none: "transparent",
	dark: "rgba(0, 0, 0, 0.7)",
	light: "rgba(255, 255, 255, 0.85)",
} as const;

export type TextPlate = keyof typeof TEXT_PLATES;

const compact = (css: string) => css.replace(/\s+/g, "").toLowerCase();

/**
 * La plaque nommée que porte ce style, ou `"custom"` pour une couleur libre d'un projet plus
 * ancien : elle s'ouvre inchangée, et le choix reste montré tant qu'elle est là.
 */
export function textPlateOf(style: AnnotationStyle): TextPlate | "custom" {
	if (!hasTextBackground(style)) return "none";
	const color = compact(style.backgroundColor);
	if (color === compact(TEXT_PLATES.dark)) return "dark";
	if (color === compact(TEXT_PLATES.light)) return "light";
	return "custom";
}

/** Style résultant du choix d'une plaque : un texte devenu illisible dessus change avec elle. */
export function setTextPlate(style: AnnotationStyle, plate: TextPlate): AnnotationStyle {
	const backgroundColor = TEXT_PLATES[plate];
	return {
		...style,
		backgroundColor,
		color: textForPlate(style.color ?? "#ffffff", backgroundColor),
	};
}
