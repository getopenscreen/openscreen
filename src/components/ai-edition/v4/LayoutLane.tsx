import { type RefObject, useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { moveLayoutBoundary } from "@/lib/ai-edition/document/layout";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { formatSec } from "@/lib/ai-edition/timeline/format";
import styles from "./Layouts.module.css";

export function LayoutLane({
	tl,
	total,
	canvasRef,
	pxPerSec,
}: {
	tl: ReturnType<typeof useTimeline>;
	total: number;
	canvasRef: RefObject<HTMLDivElement | null>;
	pxPerSec: number;
}) {
	const t = useScopedT("timeline");
	const cleanup = useRef<(() => void) | null>(null);
	const [dragging, setDragging] = useState(false);
	useEffect(() => () => cleanup.current?.(), []);
	const runs = tl.layoutSegments;
	if (runs.length <= 1 && !runs[0]?.member.legacyCamera) return null;
	return (
		<div
			className={styles.lane}
			role="group"
			aria-label={t("layouts.title")}
			data-testid="layout-lane"
		>
			{runs.map((run, index) => (
				<div key={run.ids[0]}>
					<button
						type="button"
						className={styles.segment}
						style={{
							left: `${(run.start / total) * 100}%`,
							width: `${((run.end - run.start) / total) * 100}%`,
						}}
						aria-pressed={tl.selection?.kind === "layout" && run.ids.includes(tl.selection.id)}
						aria-label={`${t(`layouts.${run.member.preset}`)} · ${formatSec(run.start)} – ${formatSec(run.end)}`}
						title={`${t(`layouts.${run.member.preset}`)} · ${formatSec(run.start)} – ${formatSec(run.end)}`}
						onPointerDown={(e) => e.stopPropagation()}
						onClick={(e) => {
							e.stopPropagation();
							if (!dragging) tl.selectRegion("layout", run.ids[0]);
						}}
					>
						<span className={styles.mini} data-layout={run.member.preset} aria-hidden="true" />
						{(run.end - run.start) * pxPerSec > 110 ? t(`layouts.${run.member.preset}`) : null}
					</button>
					{index > 0 ? (
						<button
							type="button"
							className={styles.boundary}
							style={{ left: `${(run.start / total) * 100}%` }}
							aria-label={t("layouts.moveBoundary", { time: formatSec(run.start) })}
							onClick={(e) => e.stopPropagation()}
							onKeyDown={(e) => {
								if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
								e.preventDefault();
								e.stopPropagation();
								void tl.moveLayoutBoundary(
									run.ids[0],
									run.start + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1),
								);
							}}
							onPointerDown={(e) => {
								if (e.button !== 0) return;
								e.preventDefault();
								e.stopPropagation();
								const base = useProjectStore.getState().document;
								const rect = canvasRef.current?.getBoundingClientRect();
								if (!base || !rect) return;
								const startX = e.clientX;
								let next: AxcutDocument = base;
								let moved = false;
								let pendingX: number | null = null;
								let frame: number | null = null;
								const flush = () => {
									if (pendingX === null) return;
									if (useProjectStore.getState().document !== next) {
										cancel();
										return;
									}
									let time = run.start + ((pendingX - startX) / rect.width) * total;
									pendingX = null;
									// Same six-screen-pixel snap tolerance as the rest of the timeline.
									const targets = tl.clips.flatMap((c) => [c.timelineStartSec, c.timelineEndSec]);
									const target = targets.find((value) => Math.abs(value - time) * pxPerSec < 6);
									if (target !== undefined) time = target;
									next = moveLayoutBoundary(base, run.ids[0], time);
									useProjectStore.getState().setDocument(next, { history: false });
								};
								const move = (event: PointerEvent) => {
									if (!moved && Math.abs(event.clientX - startX) < 3) return;
									if (!moved) setDragging(true);
									moved = true;
									pendingX = event.clientX;
									if (frame === null)
										frame = requestAnimationFrame(() => {
											frame = null;
											flush();
										});
								};
								const detach = () => {
									if (frame !== null) cancelAnimationFrame(frame);
									frame = null;
									document.removeEventListener("pointermove", move);
									document.removeEventListener("pointerup", finish);
									document.removeEventListener("pointercancel", cancel);
									document.removeEventListener("keydown", keydown);
									cleanup.current = null;
								};
								const cancel = () => {
									detach();
									if (useProjectStore.getState().document === next)
										useProjectStore.getState().setDocument(base, { history: false });
									setDragging(false);
								};
								const finish = () => {
									flush();
									detach();
									setDragging(false);
									if (!moved || useProjectStore.getState().document !== next) return;
									void useProjectStore
										.getState()
										.saveDocument(next, { history: true, historyBase: base })
										.then((ok) => {
											if (!ok && useProjectStore.getState().document === next)
												useProjectStore.getState().setDocument(base, { history: false });
										});
								};
								const keydown = (event: KeyboardEvent) => {
									if (event.key === "Escape") {
										event.preventDefault();
										cancel();
									}
								};
								cleanup.current = cancel;
								document.addEventListener("pointermove", move);
								document.addEventListener("pointerup", finish);
								document.addEventListener("pointercancel", cancel);
								document.addEventListener("keydown", keydown);
							}}
						/>
					) : null}
				</div>
			))}
		</div>
	);
}
