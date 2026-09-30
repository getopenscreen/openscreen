// Où une flèche d'annotation se dessine dans sa boîte. Le compositeur la met à l'échelle du plus
// petit côté de la boîte, centrée, dans un repère 100 × 100 où elle n'occupe que la moitié du
// carré : encadrer la boîte laisserait un grand vide autour d'elle. Son gimbal encadre donc le
// dessin, et écrit la boîte qui le redonne.

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";

type Direction = NonNullable<AxcutAnnotationRegion["figureData"]>["arrowDirection"];

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** L'enveloppe des trois traits de chaque flèche (x0, y0, x1, y1), en unités du repère 100 ×
 *  100 : celle de `arrow_segments_viewbox` (`crates/compositor/src/regions.rs`), qu'un test Rust
 *  tient à cette table. */
export const ARROW_EXTENTS: Record<Direction, readonly [number, number, number, number]> = {
	up: [35, 20, 65, 80],
	down: [35, 20, 65, 80],
	left: [20, 35, 80, 65],
	right: [20, 35, 80, 65],
	"up-right": [25, 25, 75, 75],
	"up-left": [25, 25, 75, 75],
	"down-right": [25, 25, 75, 75],
	"down-left": [25, 25, 75, 75],
};

/** L'enveloppe, bouts ronds du trait compris (la moitié de son épaisseur, dans le même repère). */
function extent(direction: Direction, strokeWidth: number): [number, number, number, number] {
	const [x0, y0, x1, y1] = ARROW_EXTENTS[direction] ?? ARROW_EXTENTS.right;
	const half = Math.max(0, strokeWidth) / 2;
	return [x0 - half, y0 - half, x1 + half, y1 + half];
}

/** La flèche telle que le compositeur la dessine dans `box` : ce que son gimbal encadre. */
export function arrowRect(box: Rect, direction: Direction, strokeWidth: number): Rect {
	const scale = Math.min(box.width, box.height) / 100;
	const offX = (box.width - 100 * scale) / 2;
	const offY = (box.height - 100 * scale) / 2;
	const [x0, y0, x1, y1] = extent(direction, strokeWidth);
	return {
		x: box.x + offX + x0 * scale,
		y: box.y + offY + y0 * scale,
		width: (x1 - x0) * scale,
		height: (y1 - y0) * scale,
	};
}

/** La boîte, carrée, qui dessine la flèche exactement sur `drawn` : l'inverse d'`arrowRect`. */
export function arrowBox(drawn: Rect, direction: Direction, strokeWidth: number): Rect {
	const [x0, y0, x1] = extent(direction, strokeWidth);
	const scale = drawn.width / (x1 - x0);
	return {
		x: drawn.x - x0 * scale,
		y: drawn.y - y0 * scale,
		width: 100 * scale,
		height: 100 * scale,
	};
}
