import * as Slider from "@radix-ui/react-slider";
import {
	ChevronDown,
	FileText,
	MessageSquare,
	Pencil,
	Scissors,
	Timer,
	WandSparkles,
	ZoomIn,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { AnnotationRegion } from "@/components/video-editor/types";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { ASPECT_RATIOS, type AspectRatio } from "@/utils/aspectRatioUtils";
import { EditClipModal } from "./Modals";
import styles from "./NewEditorShell.module.css";
import {
	RegionItem,
	RegionRow,
	RegionTimelineProvider,
	RegionTimelineSurface,
	type Span,
} from "./RegionTimeline";
import { TimelinePane } from "./TimelinePane";
import type { VideoSource } from "./VirtualPreview";

type RegionKind = "zoom" | "skip" | "annotation" | "speed";

interface RegionHandle {
	kind: RegionKind;
	id: string;
}

interface BottombarProps {
	clips: AxcutClip[];
	videoSources: VideoSource[];
	currentTimeSec: number;
	onSeek: (timelineSec: number) => void;
	zoomRegions: AxcutDocument["zoomRanges"];
	skipRanges: AxcutDocument["timeline"]["skipRanges"];
	annotationRegions: AnnotationRegion[];
	speedRegions: Array<{ id: string; startMs: number; endMs: number; speed: number }>;
	selection: RegionHandle | null;
	hasDoc: boolean;
	onAddZoom: () => void;
	onAddSkip: () => void;
	onAddAnnotation: () => void;
	onAddSpeed: () => void;
	onSelectRegion: (kind: RegionKind, id: string) => void;
	onCaptions: () => void;
}

const RATIO_LABELS: Record<AspectRatio, string> = {
	"16:9": "16:9",
	"9:16": "9:16",
	"1:1": "1:1",
	"4:3": "4:3",
	"4:5": "4:5",
	"16:10": "16:10",
	"10:16": "10:16",
	native: "Original",
};

const ZOOM_LABEL: Record<number, string> = {
	1: "1.25×",
	2: "1.5×",
	3: "1.8×",
	4: "2.2×",
	5: "3.5×",
	6: "5×",
};

export function Bottombar({
	clips,
	videoSources,
	currentTimeSec,
	onSeek,
	zoomRegions,
	skipRanges,
	annotationRegions,
	speedRegions,
	selection,
	hasDoc,
	onAddZoom,
	onAddSkip,
	onAddAnnotation,
	onAddSpeed,
	onSelectRegion,
	onCaptions,
}: BottombarProps) {
	const { settings, set } = useEditorSettings();
	const tl = useTimeline();
	const [ratioOpen, setRatioOpen] = useState(false);
	const [zoomRange, setZoomRange] = useState<[number, number]>([0, 100]);
	const [editClipTarget, setEditClipTarget] = useState<AxcutClip | null>(null);
	const firstClip = clips[0] ?? null;
	const totalMs = useMemo(
		() => Math.round(Math.max(0.001, ...clips.map((c) => c.timelineEndSec)) * 1000),
		[clips],
	);
	const handleRegionSpanChange = (id: string, span: Span) => {
		if (zoomRegions.some((z) => z.id === id)) void tl.updateZoomSpan(id, span.start, span.end);
		else if (speedRegions.some((s) => s.id === id))
			void tl.updateSpeedSpan(id, span.start, span.end);
		else void tl.updateAnnotationSpan(id, span.start, span.end);
	};
	const editClipAsset = editClipTarget
		? (tl.assets.find((a) => a.id === editClipTarget.assetId) ?? null)
		: null;
	return (
		<footer className={styles.bottombar} aria-label="Timeline and properties">
			<section
				style={{ minWidth: 0, display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: 0 }}
			>
				<header className={styles.timelineHead}>
					<div className={styles.viewTools} role="toolbar" aria-label="View tools">
						<VtBtn label="Add zoom" title="Add zoom (Z)" onClick={onAddZoom} disabled={!hasDoc}>
							<ZoomIn size={17} />
						</VtBtn>
						<VtBtn
							label="Auto focus"
							title="Auto focus on for all zoom"
							on={settings.autoFocusAll}
							onClick={() => {
								void set({ autoFocusAll: !settings.autoFocusAll });
							}}
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.75"
								strokeLinecap="round"
								strokeLinejoin="round"
								width={17}
								height={17}
							>
								<path d="M4 8V4h4" />
								<path d="M16 4h4v4" />
								<path d="M4 16v4h4" />
								<path d="M16 20h4v-4" />
								<path d="M6 12c1.5-2.2 3.6-3.4 6-3.4s4.5 1.2 6 3.4c-1.5 2.2-3.6 3.4-6 3.4S7.5 14.2 6 12z" />
								<circle cx="12" cy="12" r="1.6" />
							</svg>
						</VtBtn>
						<VtBtn label="Trim" title="Press T to add trim" onClick={onAddSkip} disabled={!hasDoc}>
							<Scissors size={17} />
						</VtBtn>
						<VtBtn
							label="Annotation"
							title="Press A to add annotation"
							onClick={onAddAnnotation}
							disabled={!hasDoc}
						>
							<MessageSquare size={17} />
						</VtBtn>
						<VtBtn
							label="Speed"
							title="Press S to add speed"
							onClick={onAddSpeed}
							disabled={!hasDoc}
						>
							<Timer size={17} />
						</VtBtn>
						<VtBtn label="Captions" title="Auto captions" onClick={onCaptions} disabled={!hasDoc}>
							<FileText size={17} />
						</VtBtn>
						<VtBtn label="Magic" title="Auto zoom suggestions" disabled>
							<WandSparkles size={17} />
						</VtBtn>
						<div style={{ position: "relative" }}>
							<button
								type="button"
								className={styles.ratio}
								onClick={() => setRatioOpen((v) => !v)}
								aria-haspopup="menu"
								aria-expanded={ratioOpen}
							>
								<span>{RATIO_LABELS[settings.aspectRatio]}</span>
								<ChevronDown size={10} className="caret" />
							</button>
							{ratioOpen ? (
								<div
									role="menu"
									style={{
										position: "absolute",
										top: "calc(100% + 4px)",
										left: 0,
										minWidth: 120,
										background: "var(--surface)",
										border: "1px solid var(--border)",
										borderRadius: "var(--r-md)",
										boxShadow: "var(--elev-pop)",
										padding: 4,
										zIndex: 60,
									}}
								>
									{ASPECT_RATIOS.map((r) => (
										<button
											type="button"
											key={r}
											role="menuitem"
											style={menuItemStyle(r === settings.aspectRatio)}
											disabled={!hasDoc}
											onClick={() => {
												void set({ aspectRatio: r });
												setRatioOpen(false);
											}}
										>
											{RATIO_LABELS[r]}
										</button>
									))}
								</div>
							) : null}
						</div>
					</div>
					<div className={styles.hintRow}>
						<span className={styles.hint}>
							<span className={styles.kbd}>Scroll</span>
							<span>Pan</span>
						</span>
						<span className={styles.hint}>
							<span className={styles.kbd}>Ctrl</span>
							<span className={styles.kbd}>+ Scroll</span>
							<span>Zoom</span>
						</span>
						<button
							type="button"
							className={styles.vtBtn}
							style={{
								marginLeft: 8,
								height: 28,
								width: "auto",
								padding: "0 10px",
								gap: 6,
								borderRadius: "var(--r-sm)",
							}}
							onClick={() => firstClip && setEditClipTarget(firstClip)}
							disabled={!firstClip}
							title={firstClip ? "Edit the first clip's in/out points" : "Add a clip first"}
							aria-label="Edit clip"
						>
							<Pencil size={14} />
							Edit clip…
						</button>
					</div>
				</header>
				<div className={styles.timelineBody}>
					{/* Region lanes: annotation / speed / zoom — drag-resize via dnd-timeline */}
					<div className={styles.lanes}>
						<div className={styles.laneLabelCol}>
							<div className={styles.laneLabelCell}>
								<span className={styles.laneLabel}>Annotations</span>
								<span className={styles.laneMeta}>{annotationRegions.length}</span>
							</div>
							<div className={styles.laneLabelCell}>
								<span className={styles.laneLabel}>Speed</span>
								<span className={styles.laneMeta}>{speedRegions.length}</span>
							</div>
							<div className={styles.laneLabelCell}>
								<span className={styles.laneLabel}>Zoom</span>
								<span className={styles.laneMeta}>{zoomRegions.length}</span>
							</div>
						</div>
						<RegionTimelineProvider
							totalMs={totalMs}
							collidableSpans={[
								...zoomRegions.map((z) => ({ id: z.id, start: z.startMs, end: z.endMs })),
								...speedRegions.map((s) => ({ id: s.id, start: s.startMs, end: s.endMs })),
							]}
							onItemSpanChange={(id, span) => handleRegionSpanChange(id, span)}
						>
							<RegionTimelineSurface>
								<RegionRow id="annotation" empty="No annotations yet">
									{annotationRegions.map((a) => (
										<RegionItem
											key={a.id}
											id={a.id}
											rowId="annotation"
											span={{ start: a.startMs, end: a.endMs }}
											label={a.textContent?.slice(0, 40) || "Annotation"}
											icon={<PillIcon kind="annotation" />}
											selected={selection?.kind === "annotation" && selection.id === a.id}
											onSelect={() => onSelectRegion("annotation", a.id)}
											variant="annotation"
										/>
									))}
								</RegionRow>
								<RegionRow id="speed" empty="Constant speed">
									{speedRegions.map((s) => (
										<RegionItem
											key={s.id}
											id={s.id}
											rowId="speed"
											span={{ start: s.startMs, end: s.endMs }}
											label={`${s.speed.toFixed(1)}×`}
											icon={<PillIcon kind="speed" />}
											selected={selection?.kind === "speed" && selection.id === s.id}
											onSelect={() => onSelectRegion("speed", s.id)}
											variant="speed"
										/>
									))}
								</RegionRow>
								<RegionRow id="zoom" empty="No zoom regions">
									{zoomRegions.map((z) => (
										<RegionItem
											key={z.id}
											id={z.id}
											rowId="zoom"
											span={{ start: z.startMs, end: z.endMs }}
											label={
												z.customScale
													? `${z.customScale.toFixed(1)}×`
													: (ZOOM_LABEL[z.depth] ?? "1.8×")
											}
											icon={<PillIcon kind="zoom" />}
											selected={selection?.kind === "zoom" && selection.id === z.id}
											onSelect={() => onSelectRegion("zoom", z.id)}
											variant="zoom"
										/>
									))}
								</RegionRow>
							</RegionTimelineSurface>
						</RegionTimelineProvider>
					</div>
					<div className="timelinePaneWrap" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
						<TimelinePane
							clips={clips}
							assets={tl.assets}
							skipRanges={skipRanges}
							currentTimeSec={currentTimeSec}
							selectedClipId={tl.clipSelection}
							onSelectClip={tl.selectClip}
							onSeek={onSeek}
							onInsertAsset={(assetId, index) => void tl.insertClipAt(assetId, index)}
							onMoveClip={(clipId, toIndex) => void tl.moveClip(clipId, toIndex)}
							onEditClip={(clip) => setEditClipTarget(clip)}
							onRemoveClip={(clipId) => void tl.removeClip(clipId)}
							onUpdateSkipRange={(skipId, s, e) => void tl.updateSkipRange(skipId, s, e)}
							onRemoveSkipRange={(skipId) => void tl.removeRegion("skip", skipId)}
						/>
					</div>
				</div>
				<div className={styles.zoombar} role="group" aria-label="Zoom range">
					<Slider.Root
						className={styles.sliderRoot}
						value={zoomRange}
						min={0}
						max={100}
						step={1}
						minStepsBetweenThumbs={1}
						onValueChange={(v) => setZoomRange([v[0] ?? 0, v[1] ?? 100])}
						aria-label="Timeline visible range"
					>
						<Slider.Track className={styles.sliderTrack}>
							<Slider.Range className={styles.sliderRange} />
						</Slider.Track>
						<Slider.Thumb className={styles.sliderThumb} aria-label="Zoom in start" />
						<Slider.Thumb className={styles.sliderThumb} aria-label="Zoom in end" />
					</Slider.Root>
				</div>
			</section>
			<EditClipModal
				open={editClipTarget !== null}
				onClose={() => setEditClipTarget(null)}
				clip={editClipTarget}
				assetMeta={
					editClipAsset
						? { label: editClipAsset.label, durationSec: editClipAsset.durationSec }
						: null
				}
				videoSources={videoSources}
				onApply={(sourceStartSec, sourceEndSec) => {
					if (editClipTarget) {
						void tl.updateClipSourceRange(editClipTarget.id, sourceStartSec, sourceEndSec);
					}
				}}
			/>
		</footer>
	);
}

function VtBtn({
	label,
	title,
	onClick,
	on,
	disabled,
	children,
}: {
	label: string;
	title: string;
	onClick?: () => void;
	on?: boolean;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.vtBtn} ${on ? styles.isOn : ""}`}
			aria-label={label}
			aria-pressed={on}
			title={title}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	);
}

function PillIcon({ kind }: { kind: "annotation" | "speed" | "zoom" }) {
	return (
		<svg
			className={styles.pillIcon}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{kind === "annotation" ? (
				<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
			) : kind === "speed" ? (
				<>
					<path d="M3.5 14a8.5 8.5 0 0 1 17 0" />
					<path d="M12 14l4-3.5" />
					<circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none" />
				</>
			) : (
				<>
					<circle cx="11" cy="11" r="7" />
					<line x1="21" y1="21" x2="16.5" y2="16.5" />
					<line x1="11" y1="8" x2="11" y2="14" />
					<line x1="8" y1="11" x2="14" y2="11" />
				</>
			)}
		</svg>
	);
}

function menuItemStyle(active: boolean): React.CSSProperties {
	return {
		display: "block",
		width: "100%",
		textAlign: "left",
		padding: "6px 10px",
		border: 0,
		background: active ? "var(--accent-wash)" : "transparent",
		color: "var(--fg-2)",
		borderRadius: "var(--r-sm)",
		cursor: "pointer",
		font: "500 12px var(--font-body)",
	};
}
