// Le métrage dans l'image de l'aperçu : ses coins et son warp, tels que le compositeur les publie
// avec chaque image (`FootageQuad`, `crates/compositor/src/frame_geometry.rs`). Un flou de
// confidentialité suit le contenu, zoom et perspective compris : son gimbal passe par ici pour
// tomber sur le masque que le compositeur peint.

export type Point = readonly [number, number];

export interface FootageQuad {
	/** TL, TR, BR, BL, en fractions de l'image. */
	corners: readonly [Point, Point, Point, Point];
	/** Le métrage suit l'homographie de ses coins (caméra réelle), pas leur interpolation
	 *  bilinéaire. */
	projective: boolean;
}

/** Le quad d'un rect droit, en fractions de l'image : le métrage au repos. */
export function rectQuad(x: number, y: number, width: number, height: number): FootageQuad {
	return {
		corners: [
			[x, y],
			[x + width, y],
			[x + width, y + height],
			[x, y + height],
		],
		projective: false,
	};
}

/** Les huit nombres qu'une image du compositeur porte (TL, TR, BR, BL), en quad. */
export function quadFromPacket(
	footage: readonly number[] | null | undefined,
	projective = false,
): FootageQuad | null {
	if (!footage || footage.length !== 8 || !footage.every(Number.isFinite)) return null;
	const at = (i: number): Point => [footage[2 * i], footage[2 * i + 1]];
	return { corners: [at(0), at(1), at(2), at(3)], projective };
}

/** L'homographie qui envoie le carré unité sur les coins : la forme de Heckbert de
 *  `square_to_quad` (`regions.rs`), en matrice 3 × 3 ligne par ligne. */
function homography(q: FootageQuad): number[] {
	const [c0, c1, c2, c3] = q.corners;
	const p = (c: Point) => [c[0] - c0[0], c[1] - c0[1]];
	const [p1, p2, p3] = [p(c1), p(c2), p(c3)];
	const d1 = [p1[0] - p2[0], p1[1] - p2[1]];
	const d2 = [p3[0] - p2[0], p3[1] - p2[1]];
	const d3 = [p2[0] - p1[0] - p3[0], p2[1] - p1[1] - p3[1]];
	const den = d1[0] * d2[1] - d2[0] * d1[1];
	const g = (d3[0] * d2[1] - d2[0] * d3[1]) / den;
	const h = (d1[0] * d3[1] - d3[0] * d1[1]) / den;
	return [
		p1[0] * (1 + g) + c0[0] * g,
		p3[0] * (1 + h) + c0[0] * h,
		c0[0],
		p1[1] * (1 + g) + c0[1] * g,
		p3[1] * (1 + h) + c0[1] * h,
		c0[1],
		g,
		h,
		1,
	];
}

function bilinear(q: FootageQuad, u: number, v: number): Point {
	const [tl, tr, br, bl] = q.corners;
	const top = [tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u];
	const bottom = [bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u];
	return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
}

/** Où tombe le point `(u, v)` du métrage (0..1 depuis son coin haut-gauche) dans l'image :
 *  miroir de `TiltedQuad::point_px`. */
export function footagePoint(q: FootageQuad, u: number, v: number): Point {
	if (!q.projective) return bilinear(q, u, v);
	const m = homography(q);
	const w = m[6] * u + m[7] * v + 1;
	return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
}

/** Le point du métrage sous le point `(x, y)` de l'image : l'inverse de `footagePoint`. */
export function footageAt(q: FootageQuad, x: number, y: number): Point {
	if (q.projective) {
		const [a, b, c, d, e, f, g, h, i] = homography(q);
		// L'adjugée suffit : le facteur commun du déterminant s'en va à la division par `w`.
		const u = (e * i - f * h) * x + (c * h - b * i) * y + (b * f - c * e);
		const v = (f * g - d * i) * x + (a * i - c * g) * y + (c * d - a * f);
		const w = (d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d);
		return [u / w, v / w];
	}
	// Bilinéaire : pas de forme close commode, Newton converge en quelques pas sur un quad
	// convexe, prolongements hors de 0..1 compris.
	const [tl, tr, br, bl] = q.corners;
	let [u, v] = [0.5, 0.5];
	for (let step = 0; step < 16; step++) {
		const [px, py] = bilinear(q, u, v);
		const dxu = (tr[0] - tl[0]) * (1 - v) + (br[0] - bl[0]) * v;
		const dyu = (tr[1] - tl[1]) * (1 - v) + (br[1] - bl[1]) * v;
		const dxv = (bl[0] - tl[0]) * (1 - u) + (br[0] - tr[0]) * u;
		const dyv = (bl[1] - tl[1]) * (1 - u) + (br[1] - tr[1]) * u;
		const det = dxu * dyv - dxv * dyu;
		if (Math.abs(det) < 1e-12) break;
		const [ex, ey] = [px - x, py - y];
		u -= (ex * dyv - ey * dxv) / det;
		v -= (ey * dxu - ex * dyu) / det;
	}
	return [u, v];
}
