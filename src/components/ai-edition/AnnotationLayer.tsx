// Port of the annotation-rendering block inline in `VideoPlayback.tsx`
// (lines ~1988-2115 on main) as a standalone component. Main splits
// "annotation" and "blur" into two separate arrays/selection ids; the new
// editor's schema keeps all annotation types (including blur) in one
// `document.annotations[]` array, so this uses a single filtered+sorted
// list and a single selection id instead.
//
// The layer covers the whole preview frame: text, images and arrows are placed on the frame
// and move anywhere in it, padding included. A privacy blur stays on the footage, so its boxes
// live in a child sized to the footage rect and cannot leave it (see
// `lib/ai-edition/annotations/placement.ts`).

import { belongsInFrame, fitTextBox, toFrameSpace } from "@/lib/ai-edition/annotations/placement";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { AnnotationOverlay, type PxRect } from "./AnnotationOverlay";

interface AnnotationLayerProps {
	annotations: AxcutAnnotationRegion[];
	selectedAnnotationId: string | null;
	currentTimeSec: number;
	/** The preview frame, px. */
	frameWidth: number;
	frameHeight: number;
	/** The footage rect inside the frame, px (`layout.screenRect`). */
	footage: PxRect;
	onSelectAnnotation: (id: string) => void;
	onChange: (id: string, patch: Partial<AxcutAnnotationRegion>) => void;
	onCommit: () => void;
}

export function AnnotationLayer({
	annotations,
	selectedAnnotationId,
	currentTimeSec,
	frameWidth,
	frameHeight,
	footage,
	onSelectAnnotation,
	onChange,
	onCommit,
}: AnnotationLayerProps) {
	const currentTimeMs = Math.round(currentTimeSec * 1000);

	const visible = annotations
		.filter((annotation) => {
			if (typeof annotation.startMs !== "number" || typeof annotation.endMs !== "number") {
				return false;
			}
			if (annotation.id === selectedAnnotationId) return true;
			return currentTimeMs >= annotation.startMs && currentTimeMs < annotation.endMs;
		})
		.sort((a, b) => a.zIndex - b.zIndex);

	const handleClick = (clickedId: string) => {
		if (clickedId === selectedAnnotationId && visible.length > 1) {
			const currentIndex = visible.findIndex((a) => a.id === clickedId);
			const nextIndex = (currentIndex + 1) % visible.length;
			onSelectAnnotation(visible[nextIndex].id);
		} else {
			onSelectAnnotation(clickedId);
		}
	};

	if (frameWidth <= 0 || frameHeight <= 0 || footage.width <= 0 || footage.height <= 0) {
		return null;
	}

	const frameBox: PxRect = { x: 0, y: 0, width: frameWidth, height: frameHeight };
	const footageBox: PxRect = { x: 0, y: 0, width: footage.width, height: footage.height };
	// The footage as fractions of the frame: the form the conversions in `placement.ts` take.
	const footageInFrame = {
		x: footage.x / frameWidth,
		y: footage.y / frameHeight,
		width: footage.width / frameWidth,
		height: footage.height / frameHeight,
	};
	const fitText = (region: AxcutAnnotationRegion) => fitTextBox(region, frameWidth / frameHeight);

	const overlay = (annotation: AxcutAnnotationRegion, inFrame: boolean) => {
		const width = inFrame ? frameWidth : footage.width;
		const height = inFrame ? frameHeight : footage.height;
		return (
			<AnnotationOverlay
				// La clé ne porte plus les champs de `blurData` : ils forçaient un remontage à
				// chaque réglage du flou, pour resynchroniser un canvas de mosaïque qui n'existe
				// plus. La taille du conteneur y reste, elle, parce qu'elle change le rect en px.
				key={`${annotation.id}-${width}-${height}`}
				annotation={annotation}
				isSelected={annotation.id === selectedAnnotationId}
				containerWidth={width}
				containerHeight={height}
				// Still on the footage but moving in the frame: its stored rect reads from there
				// until its first gesture moves it into the frame.
				box={!inFrame ? footageBox : annotation.space === "frame" ? frameBox : footage}
				toFrame={inFrame ? toFrameSpace(annotation, footageInFrame) : null}
				fitText={annotation.type === "text" ? fitText : undefined}
				onChange={onChange}
				onCommit={onCommit}
				onClick={handleClick}
				zIndex={annotation.zIndex}
				isSelectedBoost={annotation.id === selectedAnnotationId}
			/>
		);
	};

	return (
		<div className="absolute inset-0" style={{ pointerEvents: "none" }}>
			{visible.filter((a) => belongsInFrame(a.type)).map((a) => overlay(a, true))}
			<div
				style={{
					position: "absolute",
					left: footage.x,
					top: footage.y,
					width: footage.width,
					height: footage.height,
					pointerEvents: "none",
				}}
			>
				{visible.filter((a) => !belongsInFrame(a.type)).map((a) => overlay(a, false))}
			</div>
		</div>
	);
}
