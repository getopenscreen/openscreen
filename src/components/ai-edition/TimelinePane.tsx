import { Pencil, Trash2 } from "lucide-react";
import {
	type DragEvent as ReactDragEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { formatSeconds } from "@/lib/ai-edition/timeline/virtual-preview";
import styles from "./TimelinePane.module.css";

// Multi-clip track view — matches design/openscreen-editor.html .tracks-wrapper:
// each clip is a .trackBlock flexed by its timeline duration, side by side, with
// keep/cut sub-segments, filename + range, a pencil (Edit Clip) and a delete
// button. Media assets dragged from the left panel drop here to insert a clip
// at the drop position; clip blocks drag to reorder.

const ASSET_MIME = "application/x-axcut-asset";
const CLIP_MIME = "application/x-axcut-clip-index";

interface AssetMeta {
	id: string;
	label: string;
	durationSec?: number;
}

interface SkipRange {
	id: string;
	assetId: string;
	startSec: number;
	endSec: number;
}

interface TimelinePaneProps {
	clips: AxcutClip[];
	assets: AssetMeta[];
	skipRanges: SkipRange[];
	currentTimeSec: number;
	selectedClipId: string | null;
	onSelectClip: (id: string) => void;
	onSeek: (timelineSec: number) => void;
	onInsertAsset: (assetId: string, index: number) => void;
	onMoveClip: (clipId: string, toIndex: number) => void;
	onEditClip: (clip: AxcutClip) => void;
	onRemoveClip: (clipId: string) => void;
}

type Segment = { kind: "keep" | "cut"; len: number };

// Split a clip's source span into keep/cut segments using the asset's skip
// ranges. Purely visual — flexes each segment by its second-length.
function clipSegments(clip: AxcutClip, skips: SkipRange[]): Segment[] {
	const s0 = clip.sourceStartSec;
	const s1 = clip.sourceEndSec ?? s0;
	const span = Math.max(0.001, s1 - s0);
	const cuts = skips
		.filter((k) => k.assetId === clip.assetId && k.endSec > s0 && k.startSec < s1)
		.map((k) => ({ start: Math.max(s0, k.startSec), end: Math.min(s1, k.endSec) }))
		.sort((a, b) => a.start - b.start);
	const segs: Segment[] = [];
	let cur = s0;
	for (const c of cuts) {
		if (c.start > cur) segs.push({ kind: "keep", len: c.start - cur });
		segs.push({ kind: "cut", len: c.end - c.start });
		cur = Math.max(cur, c.end);
	}
	if (cur < s1) segs.push({ kind: "keep", len: s1 - cur });
	if (segs.length === 0) segs.push({ kind: "keep", len: span });
	return segs;
}

function rulerTicks(total: number): number[] {
	const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
	const target = total / 8;
	const step = steps.find((s) => s >= target) ?? 600;
	const ticks: number[] = [];
	for (let t = 0; t <= total + 0.001; t += step) ticks.push(Number(t.toFixed(3)));
	return ticks;
}

export function TimelinePane({
	clips,
	assets,
	skipRanges,
	currentTimeSec,
	selectedClipId,
	onSelectClip,
	onSeek,
	onInsertAsset,
	onMoveClip,
	onEditClip,
	onRemoveClip,
}: TimelinePaneProps) {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);

	const totalDuration = useMemo(
		() => clips.reduce((m, c) => Math.max(m, c.timelineEndSec), 0.001),
		[clips],
	);
	const ticks = useMemo(() => rulerTicks(totalDuration), [totalDuration]);
	const assetLabel = useCallback(
		(assetId: string) => assets.find((a) => a.id === assetId)?.label ?? "Untitled source",
		[assets],
	);
	const playheadPct = Math.max(0, Math.min(100, (currentTimeSec / totalDuration) * 100));

	// Compute the clip index a drop at clientX should land at, by comparing
	// against each block's horizontal midpoint.
	const indexFromClientX = useCallback((clientX: number): number => {
		const blocks = Array.from(
			wrapRef.current?.querySelectorAll<HTMLElement>("[data-clip-idx]") ?? [],
		);
		for (let i = 0; i < blocks.length; i++) {
			const r = blocks[i].getBoundingClientRect();
			if (clientX < r.left + r.width / 2) return i;
		}
		return blocks.length;
	}, []);

	const handleDragOver = useCallback(
		(e: ReactDragEvent<HTMLDivElement>) => {
			const dt = e.dataTransfer;
			const isAsset = dt.types.includes(ASSET_MIME);
			const isClip = dt.types.includes(CLIP_MIME);
			if (!isAsset && !isClip) return;
			e.preventDefault();
			dt.dropEffect = isClip ? "move" : "copy";
			setDropIndex(indexFromClientX(e.clientX));
		},
		[indexFromClientX],
	);

	const handleDrop = useCallback(
		(e: ReactDragEvent<HTMLDivElement>) => {
			const index = indexFromClientX(e.clientX);
			const assetId = e.dataTransfer.getData(ASSET_MIME);
			const clipIdxRaw = e.dataTransfer.getData(CLIP_MIME);
			setDropIndex(null);
			if (assetId) {
				e.preventDefault();
				onInsertAsset(assetId, index);
				return;
			}
			if (clipIdxRaw !== "") {
				e.preventDefault();
				const from = Number(clipIdxRaw);
				const clip = clips[from];
				if (!clip) return;
				// Dropping after its own slot is a no-op; account for the removal shift.
				const to = index > from ? index - 1 : index;
				if (to !== from) onMoveClip(clip.id, to);
			}
		},
		[clips, indexFromClientX, onInsertAsset, onMoveClip],
	);

	const seekFromClientX = useCallback(
		(clientX: number) => {
			const el = wrapRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const pct = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
			onSeek(pct * totalDuration);
		},
		[onSeek, totalDuration],
	);

	const handleRulerPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			seekFromClientX(e.clientX);
			const move = (ev: PointerEvent) => seekFromClientX(ev.clientX);
			const end = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", end);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", end, { once: true });
		},
		[seekFromClientX],
	);

	return (
		<section className={styles.pane}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: ruler is a scrub affordance, keyboard seek is handled by transport controls */}
			<div className={styles.ruler} onPointerDown={handleRulerPointerDown}>
				{ticks.map((t) => (
					<span
						key={t}
						className={styles.rulerTick}
						style={{ left: `${(t / totalDuration) * 100}%` }}
					>
						{formatSeconds(t)}
					</span>
				))}
			</div>

			{clips.length === 0 ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: drop target for media assets; primary insert path is the Insert-source controls
				<div
					className={styles.empty}
					onDragOver={handleDragOver}
					onDrop={handleDrop}
					data-drop-active={dropIndex !== null}
				>
					Drag a video from the media panel here to start your timeline.
				</div>
			) : (
				// biome-ignore lint/a11y/noStaticElementInteractions: tracks area is a drop target + scrub surface
				<div
					ref={wrapRef}
					className={styles.tracksWrapper}
					onDragOver={handleDragOver}
					onDragLeave={() => setDropIndex(null)}
					onDrop={handleDrop}
				>
					{dropIndex !== null ? (
						<div
							className={styles.dropMarker}
							style={{ order: dropIndex * 2 }}
							aria-hidden="true"
						/>
					) : null}

					{clips.map((clip, i) => {
						const durationSec = Math.max(0.001, clip.timelineEndSec - clip.timelineStartSec);
						const segs = clipSegments(clip, skipRanges);
						const segTotal = segs.reduce((m, s) => m + s.len, 0) || 1;
						const selected = clip.id === selectedClipId;
						return (
							<div
								key={clip.id}
								data-clip-idx={i}
								className={selected ? `${styles.trackBlock} ${styles.selected}` : styles.trackBlock}
								style={{ flexGrow: durationSec, order: i * 2 + 1 }}
								draggable
								onDragStart={(e) => {
									e.dataTransfer.setData(CLIP_MIME, String(i));
									e.dataTransfer.effectAllowed = "move";
								}}
								onClick={() => onSelectClip(clip.id)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										onSelectClip(clip.id);
									}
								}}
								// biome-ignore lint/a11y/useSemanticElements: draggable block can't be a <button> (nested interactive controls)
								role="button"
								tabIndex={0}
								aria-pressed={selected}
								title={`${assetLabel(clip.assetId)} · ${formatSeconds(clip.timelineStartSec)}–${formatSeconds(clip.timelineEndSec)}`}
							>
								<div className={styles.trackVisual} aria-hidden="true">
									{segs.map((s, si) => (
										<div
											key={si}
											className={
												s.kind === "cut"
													? `${styles.segment} ${styles.cut}`
													: `${styles.segment} ${styles.keep}`
											}
											style={{ flexGrow: (s.len / segTotal) * 100 }}
										/>
									))}
								</div>
								<div className={styles.trackInfo}>
									<button
										type="button"
										className={styles.editIcon}
										aria-label="Edit clip"
										title="Edit clip in/out points"
										onClick={(e) => {
											e.stopPropagation();
											onEditClip(clip);
										}}
									>
										<Pencil size={13} />
									</button>
									<div className={styles.trackText}>
										<h3 className={styles.trackTitle}>{assetLabel(clip.assetId)}</h3>
										<p className={styles.trackSubtitle}>
											{formatSeconds(clip.timelineStartSec)} — {formatSeconds(clip.timelineEndSec)}{" "}
											<span>•</span> source {formatSeconds(clip.sourceStartSec)}–
											{formatSeconds(clip.sourceEndSec ?? clip.sourceStartSec)}
										</p>
									</div>
									<button
										type="button"
										className={styles.clipDelete}
										aria-label="Remove clip"
										title="Remove clip from timeline"
										onClick={(e) => {
											e.stopPropagation();
											onRemoveClip(clip.id);
										}}
									>
										<Trash2 size={13} />
									</button>
								</div>
							</div>
						);
					})}
					<div className={styles.playhead} style={{ left: `${playheadPct}%` }} aria-hidden="true" />
				</div>
			)}
		</section>
	);
}
