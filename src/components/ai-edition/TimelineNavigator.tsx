import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startGlobalPointerDrag } from "@/lib/ai-edition/timeline/pointer-drag";
import styles from "./NewEditorShell.module.css";

// T11 — Navigator strip.
// Mini-map of the full source duration showing skip markers + a draggable
// visible-window overlay. Modeled after axcut TimelinePane.tsx
// timeline-navigator + .timeline-navigator-window (start/end handles +
// move handle, all driven by the same global pointer-drag helper).
//
// All sizes are percentages of sourceDurationSec, so the navigator's own
// pixel width doesn't matter — the overlay auto-scales.

interface SkipRange {
	id: string;
	assetId: string;
	startSec: number;
	endSec: number;
}

interface TimelineNavigatorProps {
	skipRanges: SkipRange[];
	sourceDurationSec: number;
	visibleStartSec: number;
	visibleEndSec: number;
	onMoveWindow: (next: number | ((prev: number) => number)) => void;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

type NavigatorDragMode = "move" | "start" | "end";

interface NavigatorDragState {
	mode: NavigatorDragMode;
	startClientX: number;
	overviewWidthPx: number;
	startVisibleStartSec: number;
	startVisibleEndSec: number;
}

export function TimelineNavigator({
	skipRanges,
	sourceDurationSec,
	visibleStartSec,
	visibleEndSec,
	onMoveWindow,
}: TimelineNavigatorProps) {
	const overviewRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<NavigatorDragState | null>(null);
	const [dragging, setDragging] = useState(false);

	const safeSource = Math.max(sourceDurationSec, 0.001);
	const safeVisibleStart = clamp(visibleStartSec, 0, safeSource);
	const safeVisibleEnd = clamp(visibleEndSec, safeVisibleStart, safeSource);
	const windowStyle = useMemo(
		() => ({
			left: `${(safeVisibleStart / safeSource) * 100}%`,
			width: `${Math.max(0, ((safeVisibleEnd - safeVisibleStart) / safeSource) * 100)}%`,
		}),
		[safeSource, safeVisibleStart, safeVisibleEnd],
	);

	useEffect(
		() => () => {
			dragRef.current = null;
		},
		[],
	);

	const startDrag = useCallback(
		(mode: NavigatorDragMode, event: React.PointerEvent<HTMLElement>) => {
			const overview = overviewRef.current;
			if (!overview) return;
			event.preventDefault();
			event.stopPropagation();
			dragRef.current = {
				mode,
				startClientX: event.clientX,
				overviewWidthPx: Math.max(1, overview.clientWidth),
				startVisibleStartSec: safeVisibleStart,
				startVisibleEndSec: safeVisibleEnd,
			};
			setDragging(true);
			startGlobalPointerDrag(event, {
				onMove: (moveEvent) => {
					const current = dragRef.current;
					if (!current) return;
					const deltaFrac = (moveEvent.clientX - current.startClientX) / current.overviewWidthPx;
					const deltaSec = deltaFrac * safeSource;
					if (current.mode === "move") {
						const duration = current.startVisibleEndSec - current.startVisibleStartSec;
						const nextStart = clamp(
							current.startVisibleStartSec + deltaSec,
							0,
							Math.max(0, safeSource - duration),
						);
						onMoveWindow(nextStart);
						return;
					}
					if (current.mode === "start") {
						const maxStart = Math.max(0, current.startVisibleEndSec - 0.1);
						const nextStart = clamp(current.startVisibleStartSec + deltaSec, 0, maxStart);
						onMoveWindow(nextStart);
						return;
					}
					// mode === "end"
					const minEnd = Math.min(safeSource, current.startVisibleStartSec + 0.1);
					const nextEnd = clamp(current.startVisibleEndSec + deltaSec, minEnd, safeSource);
					onMoveWindow((prev) =>
						clamp(prev + (nextEnd - current.startVisibleEndSec), 0, safeSource),
					);
				},
				onEnd: () => {
					dragRef.current = null;
					setDragging(false);
				},
			});
		},
		[safeSource, safeVisibleStart, safeVisibleEnd, onMoveWindow],
	);

	return (
		<div
			ref={overviewRef}
			className={
				dragging ? `${styles.timelineNavigator} ${styles.navigating}` : styles.timelineNavigator
			}
			aria-label="Timeline zoom and pan navigator"
		>
			<div className={styles.timelineNavigatorContent}>
				{skipRanges.map((skip) => (
					<span
						key={skip.id}
						className={styles.timelineNavigatorSkip}
						style={{
							left: `${(skip.startSec / safeSource) * 100}%`,
							width: `${((skip.endSec - skip.startSec) / safeSource) * 100}%`,
						}}
					/>
				))}
			</div>
			<div
				className={styles.timelineNavigatorWindow}
				style={windowStyle}
				onPointerDown={(event) => startDrag("move", event)}
			>
				<span
					className={styles.timelineNavigatorHandleStart}
					onPointerDown={(event) => startDrag("start", event)}
				/>
				<span
					className={styles.timelineNavigatorHandleEnd}
					onPointerDown={(event) => startDrag("end", event)}
				/>
			</div>
		</div>
	);
}
