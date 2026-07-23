import { useMemo, useRef } from "react";
import type { CursorMotionAnchorKind } from "@/lib/cursor/cursorMotion";

export interface CursorMotionEditorPoint {
	x: number;
	y: number;
}

interface CursorMotionEditorOverlayProps {
	width: number;
	height: number;
	trajectory: readonly CursorMotionEditorPoint[];
	recordedTrajectory?: readonly CursorMotionEditorPoint[];
	controlPoint: CursorMotionEditorPoint;
	startAnchorKind?: CursorMotionAnchorKind;
	endAnchorKind?: CursorMotionAnchorKind;
	editable?: boolean;
	onControlPointChange: (clientX: number, clientY: number) => void;
	onControlPointCommit: () => void;
}

function pointsAttribute(points: readonly CursorMotionEditorPoint[]) {
	return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function CursorMotionAnchorMarker({
	point,
	kind,
}: {
	point: CursorMotionEditorPoint;
	kind: CursorMotionAnchorKind;
}) {
	const label =
		kind === "click"
			? "Recorded click anchor"
			: kind === "rest"
				? "Cursor stop anchor"
				: "Manual cursor anchor";
	return (
		<g aria-label={label}>
			{kind === "rest" ? (
				<rect
					x={point.x - 6}
					y={point.y - 6}
					width={12}
					height={12}
					rx={3}
					fill="#f59e0b"
					stroke="#ffffff"
					strokeWidth={2}
					vectorEffect="non-scaling-stroke"
				/>
			) : (
				<>
					<circle
						cx={point.x}
						cy={point.y}
						r={kind === "click" ? 7 : 5}
						fill={kind === "click" ? "#a78bfa" : "#111827"}
						stroke={kind === "click" ? "#ffffff" : "#c4b5fd"}
						strokeWidth={2}
						vectorEffect="non-scaling-stroke"
					/>
					{kind === "click" && <circle cx={point.x} cy={point.y} r={2.25} fill="#312e81" />}
				</>
			)}
		</g>
	);
}

export function CursorMotionEditorOverlay({
	width,
	height,
	trajectory,
	recordedTrajectory = [],
	controlPoint,
	startAnchorKind = "manual",
	endAnchorKind = "click",
	editable = true,
	onControlPointChange,
	onControlPointCommit,
}: CursorMotionEditorOverlayProps) {
	const activePointerIdRef = useRef<number | null>(null);
	const start = trajectory[0] ?? null;
	const end = trajectory.at(-1) ?? null;
	const pathPoints = useMemo(() => pointsAttribute(trajectory), [trajectory]);
	const recordedPathPoints = useMemo(
		() => pointsAttribute(recordedTrajectory),
		[recordedTrajectory],
	);

	if (!start || !end || width <= 0 || height <= 0) {
		return null;
	}

	const stopDrag = (event: React.PointerEvent<SVGCircleElement>) => {
		if (activePointerIdRef.current !== event.pointerId) return;
		activePointerIdRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		onControlPointCommit();
		event.stopPropagation();
	};

	return (
		<svg
			className="absolute inset-0 h-full w-full overflow-visible select-none"
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			style={{ zIndex: 40, pointerEvents: "none" }}
			aria-label="Cursor motion path editor"
		>
			{recordedTrajectory.length > 1 && (
				<polyline
					points={recordedPathPoints}
					fill="none"
					stroke="rgba(255,255,255,0.35)"
					strokeWidth={1.5}
					strokeDasharray="4 5"
					vectorEffect="non-scaling-stroke"
				/>
			)}
			<polyline
				points={pathPoints}
				fill="none"
				stroke="rgba(8,12,18,0.9)"
				strokeWidth={5}
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
			<polyline
				points={pathPoints}
				fill="none"
				stroke="#a78bfa"
				strokeWidth={2.5}
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
			{editable && (
				<line
					x1={controlPoint.x}
					y1={controlPoint.y}
					x2={(start.x + end.x) / 2}
					y2={(start.y + end.y) / 2}
					stroke="rgba(196,181,253,0.8)"
					strokeWidth={1.5}
					strokeDasharray="3 4"
					vectorEffect="non-scaling-stroke"
				/>
			)}
			<CursorMotionAnchorMarker point={start} kind={startAnchorKind} />
			<CursorMotionAnchorMarker point={end} kind={endAnchorKind} />
			{editable && (
				<circle
					cx={controlPoint.x}
					cy={controlPoint.y}
					r={12}
					fill="rgba(167,139,250,0.18)"
					stroke="rgba(255,255,255,0.95)"
					strokeWidth={2}
					vectorEffect="non-scaling-stroke"
					style={{ pointerEvents: "auto", cursor: "grab", touchAction: "none" }}
					aria-label="Motion curve handle"
					onPointerDown={(event) => {
						if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
						activePointerIdRef.current = event.pointerId;
						event.currentTarget.setPointerCapture(event.pointerId);
						onControlPointChange(event.clientX, event.clientY);
						event.preventDefault();
						event.stopPropagation();
					}}
					onPointerMove={(event) => {
						if (activePointerIdRef.current !== event.pointerId) return;
						onControlPointChange(event.clientX, event.clientY);
						event.preventDefault();
						event.stopPropagation();
					}}
					onPointerUp={stopDrag}
					onPointerCancel={stopDrag}
					onLostPointerCapture={(event) => {
						if (activePointerIdRef.current !== event.pointerId) return;
						activePointerIdRef.current = null;
						onControlPointCommit();
					}}
				/>
			)}
		</svg>
	);
}
