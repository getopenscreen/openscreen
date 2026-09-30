// Port of the annotation-rendering block inline in `VideoPlayback.tsx`
// (lines ~1988-2115 on main) as a standalone component. Main splits
// "annotation" and "blur" into two separate arrays/selection ids; the new
// editor's schema keeps all annotation types (including blur) in one
// `document.annotations[]` array, so this uses a single filtered+sorted
// list and a single selection id instead.
//
// The layer covers the whole preview frame: text, images and arrows are placed on the frame
// and move anywhere in it, padding included. A privacy blur stays on the footage and follows
// it: the compositor paints the mask on the zoomed footage, leaning under 3D, so its gimbal goes
// through the footage of the frame on screen (`MaskGimbal`, `FootageQuad`), and cannot leave it
// (see `lib/ai-edition/annotations/placement.ts`).

import { rectQuad } from "@/lib/ai-edition/annotations/footageQuad";
import { belongsInFrame, fitTextBox, toFrameSpace } from "@/lib/ai-edition/annotations/placement";
import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import { useFootageQuad } from "@/native/footageQuadStore";
import { AnnotationOverlay, type PxRect } from "./AnnotationOverlay";
import { MaskGimbal } from "./MaskGimbal";

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
	// Where the footage lies in the frame on screen; at rest (no frame yet), its layout rect.
	const liveFootage = useFootageQuad();

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
	// The footage as fractions of the frame: the form the conversions in `placement.ts` take.
	const footageInFrame = {
		x: footage.x / frameWidth,
		y: footage.y / frameHeight,
		width: footage.width / frameWidth,
		height: footage.height / frameHeight,
	};
	const fitText = (region: AxcutAnnotationRegion) => fitTextBox(region, frameWidth / frameHeight);

	const overlay = (annotation: AxcutAnnotationRegion) => (
		<AnnotationOverlay
			// La clé ne porte plus les champs de `blurData` : ils forçaient un remontage à chaque
			// réglage du flou, pour resynchroniser un canvas de mosaïque qui n'existe plus. La
			// taille du conteneur y reste, elle, parce qu'elle change le rect en px.
			key={`${annotation.id}-${frameWidth}-${frameHeight}`}
			annotation={annotation}
			isSelected={annotation.id === selectedAnnotationId}
			containerWidth={frameWidth}
			containerHeight={frameHeight}
			// Still on the footage but moving in the frame: its stored rect reads from there
			// until its first gesture moves it into the frame.
			box={annotation.space === "frame" ? frameBox : footage}
			toFrame={toFrameSpace(annotation, footageInFrame)}
			fitText={annotation.type === "text" ? fitText : undefined}
			onChange={onChange}
			onCommit={onCommit}
			onClick={handleClick}
			zIndex={annotation.zIndex}
			isSelectedBoost={annotation.id === selectedAnnotationId}
		/>
	);
	const quad =
		liveFootage ??
		rectQuad(footageInFrame.x, footageInFrame.y, footageInFrame.width, footageInFrame.height);

	return (
		<div className="absolute inset-0" style={{ pointerEvents: "none" }}>
			{visible.filter((a) => belongsInFrame(a.type)).map(overlay)}
			{/* Only the selected blur has a gimbal: the mask itself is painted by the compositor. */}
			{visible
				.filter((a) => !belongsInFrame(a.type) && a.id === selectedAnnotationId)
				.map((a) => (
					<MaskGimbal
						key={a.id}
						annotation={a}
						quad={quad}
						frameWidth={frameWidth}
						frameHeight={frameHeight}
						onChange={onChange}
						onCommit={onCommit}
						onClick={handleClick}
						zIndex={a.zIndex}
					/>
				))}
		</div>
	);
}
