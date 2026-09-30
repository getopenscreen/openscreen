// Le gimbal d'un flou de confidentialité. Le masque suit le contenu : le compositeur le pose sur
// le métrage zoomé, et incliné sous la 3D (`privacy_mask`). Le gimbal passe donc par le métrage
// de l'image (`FootageQuad`) : contour, poignées et gestes vivent dans le repère du métrage, et
// chaque point est projeté comme le compositeur le peint. Un `Rnd` droit, posé sur le métrage au
// repos, s'écartait du masque dès le premier zoom.

import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";
import {
	type FootageQuad,
	footageAt,
	footagePoint,
} from "@/lib/ai-edition/annotations/footageQuad";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";

type Region = AxcutAnnotationRegion;

interface MaskGimbalProps {
	annotation: Region;
	/** Le métrage dans l'image, en fractions de l'image. */
	quad: FootageQuad;
	/** L'image de l'aperçu, px. */
	frameWidth: number;
	frameHeight: number;
	onChange: (id: string, patch: Partial<Region>) => void;
	/** Écriture disque, une fois en fin de geste. */
	onCommit?: () => void;
	onClick: (id: string) => void;
	zIndex: number;
}

const GREEN = "#34B27B";
/** Le plus petit masque que laissent les poignées, en % du métrage. */
const MIN_PCT = 1;
/** Les poignées dans l'ordre des coins : TL, TR, BR, BL. */
const CORNER_CURSORS = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;

type Gesture =
	| {
			kind: "move";
			start: readonly [number, number];
			origin: { x: number; y: number };
			moved: boolean;
	  }
	| { kind: "corner"; fixed: readonly [number, number]; moved: boolean };

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export function MaskGimbal({
	annotation,
	quad,
	frameWidth,
	frameHeight,
	onChange,
	onCommit,
	onClick,
	zIndex,
}: MaskGimbalProps) {
	const svgRef = useRef<SVGSVGElement>(null);
	const gesture = useRef<Gesture | null>(null);
	const { position, size } = annotation;
	// Le masque en fractions du métrage.
	const [u0, v0] = [position.x / 100, position.y / 100];
	const [u1, v1] = [u0 + size.width / 100, v0 + size.height / 100];
	const onFrame = (u: number, v: number) => {
		const [x, y] = footagePoint(quad, u, v);
		return [x * frameWidth, y * frameHeight] as const;
	};
	const corners = [
		[u0, v0],
		[u1, v0],
		[u1, v1],
		[u0, v1],
	] as const;
	// Un ovale se dessine en ovale, projeté ; le tracé libre, comme le masque, par sa boîte.
	const outline =
		annotation.blurData?.shape === "oval"
			? Array.from({ length: 48 }, (_, k) => {
					const t = (k / 48) * 2 * Math.PI;
					return onFrame(
						u0 + (u1 - u0) * (0.5 + 0.5 * Math.cos(t)),
						v0 + (v1 - v0) * (0.5 + 0.5 * Math.sin(t)),
					);
				})
			: corners.map(([u, v]) => onFrame(u, v));

	/** Le point du métrage sous le pointeur, en fractions du métrage. */
	const under = (event: ReactPointerEvent): readonly [number, number] => {
		const r = svgRef.current?.getBoundingClientRect();
		if (!r || r.width <= 0 || r.height <= 0) return [0, 0];
		return footageAt(quad, (event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height);
	};

	const begin = (event: ReactPointerEvent<Element>, next: Gesture) => {
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		gesture.current = next;
	};

	const onPointerMove = (event: ReactPointerEvent) => {
		const g = gesture.current;
		if (!g) return;
		const [u, v] = under(event);
		if (g.kind === "move") {
			const x = clamp(g.origin.x + (u - g.start[0]) * 100, 0, 100 - size.width);
			const y = clamp(g.origin.y + (v - g.start[1]) * 100, 0, 100 - size.height);
			g.moved ||= x !== g.origin.x || y !== g.origin.y;
			// En direct : c'est le natif qui peint, il suit le geste. L'écriture disque attend
			// le relâchement (`onCommit`).
			onChange(annotation.id, { position: { x, y } });
			return;
		}
		// Le coin opposé reste en place ; la poignée peut passer de l'autre côté, sans que le
		// masque descende sous le minimum ni sorte du métrage.
		const span = (c: number, fixed: number): [number, number] => {
			const [lo, hi] =
				c < fixed ? [Math.min(c, fixed - MIN_PCT), fixed] : [fixed, Math.max(c, fixed + MIN_PCT)];
			const top = Math.min(hi, 100);
			return [Math.max(0, Math.min(lo, top - MIN_PCT)), top];
		};
		const [x0, x1] = span(clamp(u * 100, 0, 100), g.fixed[0]);
		const [y0, y1] = span(clamp(v * 100, 0, 100), g.fixed[1]);
		g.moved = true;
		onChange(annotation.id, {
			position: { x: x0, y: y0 },
			size: { width: x1 - x0, height: y1 - y0 },
		});
	};

	const onPointerUp = (event: ReactPointerEvent) => {
		const g = gesture.current;
		gesture.current = null;
		if (!g) return;
		(event.target as Element).releasePointerCapture?.(event.pointerId);
		if (g.moved) onCommit?.();
		else if (g.kind === "move") onClick(annotation.id);
	};

	const points = (list: readonly (readonly [number, number])[]) =>
		list.map(([x, y]) => `${x},${y}`).join(" ");

	return (
		<svg
			ref={svgRef}
			className="absolute inset-0"
			width="100%"
			height="100%"
			viewBox={`0 0 ${frameWidth} ${frameHeight}`}
			preserveAspectRatio="none"
			style={{ zIndex: zIndex + 1000, pointerEvents: "none", overflow: "visible" }}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			data-testid="mask-gimbal"
		>
			<polygon
				points={points(outline)}
				fill="transparent"
				stroke={GREEN}
				strokeOpacity={0.8}
				strokeWidth={2}
				strokeLinejoin="round"
				style={{ pointerEvents: "all", cursor: "move" }}
				onPointerDown={(event) =>
					begin(event, { kind: "move", start: under(event), origin: { ...position }, moved: false })
				}
			/>
			{corners.map(([u, v], k) => {
				const [cx, cy] = onFrame(u, v);
				const [ou, ov] = corners[(k + 2) % 4];
				return (
					<circle
						key={k}
						cx={cx}
						cy={cy}
						r={6}
						fill="white"
						stroke={GREEN}
						strokeWidth={2}
						style={{ pointerEvents: "all", cursor: CORNER_CURSORS[k] }}
						onPointerDown={(event) =>
							begin(event, { kind: "corner", fixed: [ou * 100, ov * 100], moved: false })
						}
					/>
				);
			})}
		</svg>
	);
}
