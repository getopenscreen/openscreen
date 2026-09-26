// Chrome d'édition d'une annotation : cadre de sélection, glissement, poignées de
// redimensionnement. Les PIXELS de l'annotation — texte, image, flèche, flou — sont peints par le
// compositeur natif, aperçu compris.
//
// Ce fichier était le port du `AnnotationOverlay` de l'éditeur v2 : il rendait les quatre types en
// DOM et portait la saisie du tracé libre, soit ~400 lignes qui ne s'exécutaient plus depuis que
// le natif peint l'aperçu. Les garder ne coûtait pas seulement de la lecture : elles décrivaient un
// rendu concurrent, sur une autre horloge, ce qui avait déjà produit le bug des annotations
// affichées en double (une copie collée au curseur, un fantôme resté en place jusqu'au
// relâchement). Le détail reste dans `git log`.

import { useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { clampToBound } from "@/lib/projectDefaults";
import { cn } from "@/lib/utils";

type Region = AxcutAnnotationRegion;

export interface PxRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface AnnotationOverlayProps {
	annotation: Region;
	isSelected: boolean;
	/** Taille, en px, de l'élément où la boîte se déplace : le cadre, ou le footage pour un flou.
	 *  Chaque écriture est un pourcentage de cet élément. */
	containerWidth: number;
	containerHeight: number;
	/** D'où se lit le rect enregistré, en px dans cet élément : l'élément lui-même, ou le rect du
	 *  footage pour une annotation encore rangée sur lui mais qui se déplace dans le cadre. */
	box: PxRect;
	/** Le patch qui range l'annotation dans le cadre, appliqué avant son premier geste ; `null`
	 *  quand elle y est déjà (ou qu'elle n'en sort jamais, comme un flou). */
	toFrame: Partial<Region> | null;
	/** Texte seulement : la boîte taillée sur le texte, centre conservé. */
	fitText?: (region: Region) => Pick<Region, "position" | "size">;
	onChange: (id: string, patch: Partial<Region>) => void;
	/** Écriture disque, appelée une fois en fin de geste — le drag/resize ne fait que du live. */
	onCommit?: () => void;
	onClick: (id: string) => void;
	zIndex: number;
	isSelectedBoost: boolean;
}

const CORNERS_ONLY = {
	top: false,
	right: false,
	bottom: false,
	left: false,
	topLeft: true,
	topRight: true,
	bottomLeft: true,
	bottomRight: true,
} as const;

export function AnnotationOverlay({
	annotation,
	isSelected,
	containerWidth,
	containerHeight,
	box,
	toFrame,
	fitText,
	onChange,
	onCommit,
	onClick,
	zIndex,
	isSelectedBoost,
}: AnnotationOverlayProps) {
	const committedX = box.x + (annotation.position.x / 100) * box.width;
	const committedY = box.y + (annotation.position.y / 100) * box.height;
	const committedWidth = (annotation.size.width / 100) * box.width;
	const committedHeight = (annotation.size.height / 100) * box.height;
	const blurShape = annotation.type === "blur" ? (annotation.blurData?.shape ?? "rectangle") : null;
	const isText = annotation.type === "text";
	const isDraggingRef = useRef(false);
	// Le geste en cours a-t-il bougé quelque chose ? Un clic sur une annotation sélectionnée passe
	// aussi par le début et la fin d'un glissement : sans mouvement, il n'écrit rien.
	const movedRef = useRef(false);
	// Taille de police et hauteur de boîte au début d'un redimensionnement de texte : les poignées
	// d'un texte agrandissent ses lettres, dans le rapport de la hauteur tirée à la hauteur de départ.
	const resizeStartRef = useRef<{ fontSize: number; height: number } | null>(null);
	const [liveRect, setLiveRect] = useState({
		x: committedX,
		y: committedY,
		width: committedWidth,
		height: committedHeight,
	});

	useEffect(() => {
		setLiveRect({
			x: committedX,
			y: committedY,
			width: committedWidth,
			height: committedHeight,
		});
	}, [committedHeight, committedWidth, committedX, committedY]);

	const { x, y, width, height } = liveRect;

	/** Un rect en px de l'élément, en pourcentages de lui : ce que le document range. */
	const toPct = (rect: PxRect): Pick<Region, "position" | "size"> => ({
		position: { x: (rect.x / containerWidth) * 100, y: (rect.y / containerHeight) * 100 },
		size: {
			width: (rect.width / containerWidth) * 100,
			height: (rect.height / containerHeight) * 100,
		},
	});

	// Une annotation encore sur le footage passe dans le cadre à son premier mouvement, au pixel
	// près : les écritures qui suivent sont des pourcentages du cadre.
	const firstMove = () => {
		if (movedRef.current) return;
		movedRef.current = true;
		if (toFrame) onChange(annotation.id, toFrame);
	};

	/** La taille de police qu'une hauteur de boîte tirée donne à un texte ; rien pour les autres. */
	const scaledText = (nextHeight: number): Partial<Region> => {
		const start = resizeStartRef.current;
		if (!isText || !start) return {};
		const fontSize = Math.round(
			clampToBound((start.fontSize * nextHeight) / start.height, "annotationFontSize"),
		);
		return { style: { ...(toFrame?.style ?? annotation.style), fontSize } };
	};

	// Un texte finit chaque geste taillé sur ses mots, au cas où sa boîte ne l'était pas encore
	// (une annotation d'avant, ou une poignée lâchée entre deux tailles).
	const settle = (patch: Partial<Region>) => {
		const next = { ...annotation, ...toFrame, ...patch } as Region;
		onChange(annotation.id, isText && fitText ? { ...patch, ...fitText(next) } : patch);
		onCommit?.();
	};

	return (
		<Rnd
			position={{ x, y }}
			size={{ width, height }}
			onDragStart={() => {
				isDraggingRef.current = true;
				movedRef.current = false;
			}}
			onDrag={(_e, d) => {
				firstMove();
				setLiveRect((prev) => ({ ...prev, x: d.x, y: d.y }));
				// Pousse la position PENDANT le geste : c'est le natif qui peint, il doit donc suivre
				// le curseur. `onChange` ne met à jour qu'en mémoire ; l'écriture disque se fait une
				// seule fois, au relâchement (`onCommit`).
				onChange(annotation.id, {
					position: toPct({ x: d.x, y: d.y, width, height }).position,
				});
			}}
			onDragStop={(_e, d) => {
				if (movedRef.current) {
					setLiveRect((prev) => ({ ...prev, x: d.x, y: d.y }));
					settle({ position: toPct({ x: d.x, y: d.y, width, height }).position });
				}
				movedRef.current = false;
				setTimeout(() => {
					isDraggingRef.current = false;
				}, 100);
			}}
			onResizeStart={() => {
				movedRef.current = false;
				const fontSize = (toFrame?.style ?? annotation.style).fontSize;
				resizeStartRef.current = { fontSize, height: Math.max(1, height) };
			}}
			onResize={(_e, _direction, ref, _delta, position) => {
				const rect = {
					x: position.x,
					y: position.y,
					width: ref.offsetWidth,
					height: ref.offsetHeight,
				};
				firstMove();
				setLiveRect(rect);
				// Même raison que le drag : le natif doit suivre la poignée en direct.
				onChange(annotation.id, { ...toPct(rect), ...scaledText(rect.height) });
			}}
			onResizeStop={(_e, _direction, ref, _delta, position) => {
				const rect = {
					x: position.x,
					y: position.y,
					width: ref.offsetWidth,
					height: ref.offsetHeight,
				};
				if (movedRef.current) {
					setLiveRect(rect);
					settle({ ...toPct(rect), ...scaledText(rect.height) });
				}
				movedRef.current = false;
				resizeStartRef.current = null;
			}}
			onClick={() => {
				if (isDraggingRef.current) return;
				onClick(annotation.id);
			}}
			bounds="parent"
			// Un texte garde sa forme : sa boîte est celle de ses mots, seule la taille change.
			lockAspectRatio={isText}
			className={cn(
				"cursor-move",
				isSelected &&
					annotation.type !== "blur" &&
					"ring-2 ring-[#34B27B] ring-offset-2 ring-offset-transparent",
			)}
			style={{
				zIndex: isSelectedBoost ? zIndex + 1000 : zIndex,
				pointerEvents: isSelected ? "auto" : "none",
				border:
					isSelected && annotation.type !== "blur" ? "2px solid rgba(52, 178, 123, 0.8)" : "none",
				backgroundColor:
					isSelected && annotation.type !== "blur" ? "rgba(52, 178, 123, 0.1)" : "transparent",
				boxShadow:
					isSelected && annotation.type !== "blur" ? "0 0 0 1px rgba(52, 178, 123, 0.35)" : "none",
			}}
			// Un flou en tracé libre se déplace et se redimensionne comme les autres : ce qui le
			// bloquait, c'était la zone de saisie du tracé qui capturait le pointeur — et elle est
			// partie avec l'outil. Un texte ne se tire que par ses coins, qui agrandissent ses lettres.
			enableResizing={isSelected ? (isText ? CORNERS_ONLY : true) : false}
			disableDragging={!isSelected}
			resizeHandleStyles={{
				topLeft: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					left: "-6px",
					top: "-6px",
					cursor: "nwse-resize",
				},
				topRight: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					right: "-6px",
					top: "-6px",
					cursor: "nesw-resize",
				},
				bottomLeft: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					left: "-6px",
					bottom: "-6px",
					cursor: "nesw-resize",
				},
				bottomRight: {
					width: "12px",
					height: "12px",
					backgroundColor: isSelected ? "white" : "transparent",
					border: isSelected ? "2px solid #34B27B" : "none",
					borderRadius: "50%",
					right: "-6px",
					bottom: "-6px",
					cursor: "nwse-resize",
				},
			}}
		>
			<div
				className={cn(
					"w-full h-full relative",
					annotation.type !== "blur" && "rounded-lg",
					isSelected && annotation.type !== "blur" && "shadow-lg",
				)}
			>
				{/* Le cadre d'un flou sélectionné, à la forme du masque. Les autres types portent le
				    leur sur le `Rnd` lui-même ; un flou n'en a pas, pour ne pas encadrer la zone qu'il
				    est censé cacher — sans ce liseré il n'aurait AUCUN retour de sélection. */}
				{isSelected && annotation.type === "blur" ? (
					<div
						className="absolute inset-0 pointer-events-none border-2 border-[#34B27B]/80"
						style={{ borderRadius: blurShape === "oval" ? "50%" : "8px" }}
					/>
				) : null}
			</div>
		</Rnd>
	);
}
