import {
	ArrowDown,
	ArrowDownLeft,
	ArrowDownRight,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ArrowUpLeft,
	ArrowUpRight,
	AudioLines,
	Camera,
	ChevronRight,
	EyeOff,
	FileText,
	ImageIcon,
	type LucideIcon,
	Maximize2,
	MousePointer2,
	Pencil,
	Scissors,
	SlidersHorizontal,
	Trash2,
	Type,
	Undo2,
	X,
	ZoomIn,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { parseCustomPlaybackSpeedInput } from "@/components/video-editor/customPlaybackSpeed";
import {
	effectiveZoomScale,
	FIXED_ROTATION_3D_PRESETS,
	isRotation3DPreset,
	MAX_PLAYBACK_SPEED,
	MAX_ZOOM_SCALE,
	MIN_ZOOM_SCALE,
	MOVING_ROTATION_3D_PRESETS,
	type Rotation3DPreset,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
} from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import { setTextPlate, type TextPlate, textPlateOf } from "@/lib/ai-edition/annotations/background";
import {
	type AnnotationTextAnimation,
	TEXT_ANIMATION_VALUES,
} from "@/lib/ai-edition/annotations/textAnimation";
import type { AxcutAnnotationRegion, AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { rafCoalesce } from "@/lib/ai-edition/store/rafCoalesce";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import { coalescedTrimGroups } from "@/lib/ai-edition/timeline/trim-mapping";
import { clampToBound } from "@/lib/projectDefaults";
import { zoomScaleLimit } from "@/native/sceneDescription";
import { ColorField } from "../ColorField";
import shell from "../NewEditorShell.module.css";
import {
	AudioPane,
	AudioTrackPane,
	ChoiceRow,
	CursorPane,
	LayoutPane,
	SliderCell,
	Toggle,
	TranscriptPane,
	VideoEffectsPane,
} from "../RightPanes";
import { TextColorField } from "../TextColorField";
import styles from "./EditorShellV4.module.css";

type TimelineApi = ReturnType<typeof useTimeline>;

// No "captions" facet: caption settings are a popover on the transcript tab now.
// They were never a separate concern from the transcript — they RENDER it — and two
// tabs meant two entry points to transcription, one of which ("transcribe video",
// on the caption tab) was the only one many users ever found. See issue #560.
export type Facet = "effects" | "layout" | "audio" | "cursor" | "transcript";

const FACETS: Array<{ id: Facet; labelKey: string; icon: typeof SlidersHorizontal }> = [
	// Background is a SECTION of this facet now, not a facet of its own — see
	// VideoEffectsPane for why the split had nowhere to sit.
	{ id: "effects", labelKey: "effects.title", icon: SlidersHorizontal },
	{ id: "layout", labelKey: "layout.title", icon: Camera },
	{ id: "audio", labelKey: "audio.title", icon: AudioLines },
	{ id: "cursor", labelKey: "cursor.title", icon: MousePointer2 },
	{ id: "transcript", labelKey: "facets.transcript", icon: FileText },
];

type TranscriptProps = ComponentProps<typeof TranscriptPane>;

interface FloatingInspectorProps {
	facet: Facet;
	open: boolean;
	onFacetChange: (facet: Facet) => void;
	onToggleOpen: () => void;
	/** Clips on the timeline, for the "Edit clip" picker — crop + trim now live
	 * per-clip (see clipSchema.cropRegion) instead of behind a document-wide
	 * facet, so this button opens EditClipModal directly instead of routing
	 * through a facet body. */
	clips: AxcutClip[];
	onEditClip: (clip: AxcutClip) => void;
	transcriptProps: TranscriptProps;
	/** Drives the selected-element settings pane (zoom/speed/annotation/trim) —
	 * takes over the inspector, forcing it open, whenever a timeline region is
	 * selected. Clicking elsewhere on the timeline clears the selection
	 * (see V4Timeline's empty-area click handler) which closes this pane. */
	tl: TimelineApi;
}

export function FloatingInspector({
	facet,
	open,
	onFacetChange,
	onToggleOpen,
	clips,
	onEditClip,
	transcriptProps,
	tl,
}: FloatingInspectorProps) {
	const ts = useScopedT("settings");
	const te = useScopedT("editor");
	const [clipPickerOpen, setClipPickerOpen] = useState(false);
	const clipPickerRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!clipPickerOpen) return;
		const onDocMouseDown = (e: MouseEvent) => {
			if (clipPickerRef.current && !clipPickerRef.current.contains(e.target as Node)) {
				setClipPickerOpen(false);
			}
		};
		document.addEventListener("mousedown", onDocMouseDown);
		return () => document.removeEventListener("mousedown", onDocMouseDown);
	}, [clipPickerOpen]);
	const selection = tl.selection;
	// An imported audio track is selected (issue #350) — like a region selection it
	// takes over the inspector body with its own pane (see AudioTrackPane).
	const audioTrackSelected = Boolean(tl.selectedAudioTrackId);
	const effectiveOpen = open || selection !== null || audioTrackSelected;
	return (
		<div className={styles.inspectorWrap}>
			{effectiveOpen ? (
				<div className={styles.inspector}>
					{selection ? (
						<SelectionPane tl={tl} onClose={() => tl.clearSelection()} />
					) : audioTrackSelected ? (
						<AudioTrackPane tl={tl} onClose={() => tl.clearSelection()} />
					) : (
						<FacetBody facet={facet} onCollapse={onToggleOpen} transcriptProps={transcriptProps} />
					)}
				</div>
			) : null}
			<div className={styles.facetRail}>
				{FACETS.map(({ id, labelKey, icon: Icon }) => (
					<button
						key={id}
						type="button"
						title={ts(labelKey)}
						aria-label={ts(labelKey)}
						aria-pressed={!selection && !audioTrackSelected && open && facet === id}
						onClick={() => {
							// Switching facets while an element is selected should show
							// the facet, not leave the selection pane on top of it.
							if (selection || audioTrackSelected) tl.clearSelection();
							if (facet === id && open) {
								onToggleOpen();
							} else {
								onFacetChange(id);
							}
						}}
					>
						<Icon size={17} />
					</button>
				))}
				<div ref={clipPickerRef} style={{ position: "relative" }}>
					<button
						type="button"
						title={te("editClipDialog.title")}
						aria-label={te("editClipDialog.title")}
						aria-haspopup={clips.length > 1 ? "menu" : undefined}
						aria-expanded={clips.length > 1 ? clipPickerOpen : undefined}
						onClick={() => {
							if (selection) tl.clearSelection();
							if (clips.length === 0) return;
							if (clips.length === 1) {
								onEditClip(clips[0]);
								return;
							}
							setClipPickerOpen((v) => !v);
						}}
					>
						<Pencil size={17} />
					</button>
					{clipPickerOpen && clips.length > 1 ? (
						<div
							role="menu"
							aria-label={te("editClipDialog.pickClipTitle")}
							style={{
								position: "absolute",
								top: 0,
								right: "calc(100% + 8px)",
								minWidth: 200,
								maxHeight: 320,
								overflowY: "auto",
								background: "var(--surface-1)",
								border: "1px solid var(--border)",
								borderRadius: 12,
								boxShadow: "var(--elev-pop)",
								backdropFilter: "blur(18px)",
								padding: 6,
								zIndex: 30,
							}}
						>
							<p
								style={{
									margin: "4px 8px 6px",
									font: "600 12px/1.3 var(--font-body)",
									color: "var(--fg-2)",
								}}
							>
								{te("editClipDialog.pickClipTitle")}
							</p>
							{clips.map((clip, index) => (
								<button
									key={clip.id}
									type="button"
									role="menuitem"
									onClick={() => {
										setClipPickerOpen(false);
										onEditClip(clip);
									}}
									style={{
										display: "flex",
										flexDirection: "column",
										alignItems: "flex-start",
										width: "100%",
										padding: "7px 8px",
										border: "none",
										borderRadius: 8,
										background: "transparent",
										color: "var(--fg)",
										cursor: "pointer",
										textAlign: "left",
									}}
								>
									<span style={{ font: "600 13px var(--font-display)" }}>
										{te("editClipDialog.clipLabel", { index: index + 1 })}
									</span>
									<span
										style={{
											font: "500 12px var(--font-body)",
											fontVariantNumeric: "tabular-nums",
											color: "var(--muted)",
										}}
									>
										{formatSeconds(clip.timelineStartSec)}–{formatSeconds(clip.timelineEndSec)}
									</span>
								</button>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function paneHeader(icon: React.ReactNode, title: string, onClose: () => void, closeLabel: string) {
	return (
		<header
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "14px 16px 12px",
				borderBottom: "1px solid var(--border-soft)",
				// Le corps défile sous l'en-tête : sans ça, l'en-tête se comprime avec lui.
				flexShrink: 0,
			}}
		>
			<span style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>{icon}</span>
			<h2
				style={{
					margin: 0,
					flex: 1,
					fontSize: 14,
					fontWeight: 600,
					color: "var(--fg-emphasis)",
					letterSpacing: "-0.01em",
				}}
			>
				{title}
			</h2>
			<button
				type="button"
				className={styles.iconBtn}
				title={closeLabel}
				aria-label={closeLabel}
				onClick={onClose}
				style={{
					width: 30,
					height: 30,
				}}
			>
				<X size={16} />
			</button>
		</header>
	);
}

function paneRow(label: string, control: React.ReactNode) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 10,
			}}
		>
			<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>{label}</span>
			{control}
		</div>
	);
}

/** Un libellé au-dessus de son contrôle, pour ceux qui prennent toute la largeur du panneau
 *  (une `ChoiceRow`) : à côté d'un libellé, ils n'auraient plus la place de montrer leurs choix. */
function paneStack(label: string, control: React.ReactNode) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>{label}</span>
			{control}
		</div>
	);
}

/** Clé i18n (`zoom.camera.preset.*`) de chaque caméra 3D. */
const CAMERA_KEYS: Record<Rotation3DPreset, string> = {
	left: "left",
	right: "right",
	"follow-cursor": "followCursor",
};

type AnnotationKind = AxcutAnnotationRegion["type"];
type ArrowDirectionKind = NonNullable<AxcutAnnotationRegion["figureData"]>["arrowDirection"];

/** Les huit directions de `ArrowSvgs.tsx`, dans l'ordre d'une boussole (du haut, dans le sens
 *  des aiguilles d'une montre), chacune avec la flèche qui la montre. Aucune langue n'a de
 *  libellé pour elles, et la valeur brute (« up-right ») s'affichait telle quelle : le caractère
 *  fléché sert de nom accessible. */
const ARROW_DIRECTIONS: Array<{ value: ArrowDirectionKind; glyph: string; Icon: LucideIcon }> = [
	{ value: "up", glyph: "↑", Icon: ArrowUp },
	{ value: "up-right", glyph: "↗", Icon: ArrowUpRight },
	{ value: "right", glyph: "→", Icon: ArrowRight },
	{ value: "down-right", glyph: "↘", Icon: ArrowDownRight },
	{ value: "down", glyph: "↓", Icon: ArrowDown },
	{ value: "down-left", glyph: "↙", Icon: ArrowDownLeft },
	{ value: "left", glyph: "←", Icon: ArrowLeft },
	{ value: "up-left", glyph: "↖", Icon: ArrowUpLeft },
];

/** Défauts du schéma, pour compléter un `blurData` absent sans écraser ce qui existe. */
const BLUR_DEFAULTS = {
	type: "mosaic",
	shape: "rectangle",
	color: "white",
	intensity: 12,
	blockSize: 12,
} as const;

/**
 * Patch à appliquer quand l'utilisateur change le type d'une annotation.
 *
 * `content` est un slot UNIQUE partagé par le texte et l'image : la zone de saisie y écrit, et le
 * rendu d'image y lit une data URL. Changer de type sans déplacer la valeur déversait donc le
 * base64 de l'image, souvent plusieurs mégaoctets, dans le champ texte. Chaque contenu est rangé
 * dans son slot typé (`textContent` / `imageContent`) en sortant et restauré en entrant, si bien
 * qu'un aller-retour entre deux types ne perd rien.
 */
function convertAnnotationKind(
	region: AxcutAnnotationRegion,
	next: AnnotationKind,
): Partial<AxcutAnnotationRegion> {
	if (region.type === next) return {};
	const parked: Partial<AxcutAnnotationRegion> =
		region.type === "text"
			? { textContent: region.content ?? "" }
			: region.type === "image"
				? { imageContent: region.content ?? "" }
				: {};
	// Flèche et flou n'ont pas de contenu : on vide `content` plutôt que d'y laisser traîner le
	// texte ou le base64 du type précédent.
	const restored =
		next === "text"
			? (region.textContent ?? "")
			: next === "image"
				? (region.imageContent ?? "")
				: "";
	return { ...parked, type: next, content: restored };
}

const ZOOM_DEPTHS: readonly ZoomDepth[] = [1, 2, 3, 4, 5, 6];

// The row: the default and one step either side, plus a strong close-up. The two ends of the
// table (1.25×, 5×) and every level between are one entry in the free field below, which is
// why the row stays short. Labels read the table, not a formula: a formula once announced
// "2.0×" where the timeline pill showed "1.80×" and the render applied 1.8.
const ZOOM_PRESETS = ([2, 3, 4, 5] as const).map((depth) => ({
	value: ZOOM_DEPTH_SCALES[depth],
	label: `${ZOOM_DEPTH_SCALES[depth]}×`,
}));

/**
 * The zoom level as a row of presets plus a free field, the same pair as the speed control
 * below. A level is one click away instead of two (open the select, then pick): that is
 * My-Denia's change (#694), and so is everything that keeps rapid clicks and arrow steps in
 * order, below.
 *
 * The control speaks in scales, not depths: a preset and a typed level are the same kind of
 * value, and a typed level the table has (1.8, or 1.25 which is not in the row) is written as
 * its depth, so a document keeps naming its presets. Anything else is a `customScale`.
 */
export function ZoomLevelControl({
	region,
	tl,
	maxScale = MAX_ZOOM_SCALE,
}: {
	region: { id: string; depth: ZoomDepth; customScale?: number };
	tl: Pick<TimelineApi, "updateZoomDepth" | "updateZoomCustomScale">;
	/** The deepest level this region's clip takes before its recording blurs
	 *  (`zoomScaleLimit`). Deeper presets are not offered. */
	maxScale?: number;
}) {
	const ts = useScopedT("settings");
	const current = effectiveZoomScale(region);
	// Last level this instance asked for, and the generation of that request. Levels repeat,
	// so a set of levels cannot tell "our older 2.2 landed" from "the latest request is 2.2" or
	// from an undo that happens to land on 2.2. Each click/key gets a new gen. Every gen
	// belonging to this region epoch is removed from `pending` when it settles: a superseded
	// request must still drain, or `pending` stays non-empty and undo/redo can never overwrite
	// the request. Only the latest gen may change it.
	//
	// The row shows the request, not the document: its no-op guard compares against the value
	// it is given, and against a document still saying 1.8 while a 2.2 is in flight, stepping
	// back to 1.8 would be dropped as a re-press.
	const requestedRef = useRef(current);
	const [requested, setRequested] = useState(current);
	const genRef = useRef(0);
	const pendingRef = useRef(new Set<number>());
	const currentRef = useRef(current);
	currentRef.current = current;
	// "" means the field is idle and shows the live level as its placeholder.
	const [draft, setDraft] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: region.id is the trigger, not a read — the body resets request state; the level is taken from the render's ref so a same-level other pill still clears the previous pill's pending gen.
	useEffect(() => {
		genRef.current += 1;
		pendingRef.current.clear();
		requestedRef.current = currentRef.current;
		setRequested(currentRef.current);
	}, [region.id]);

	useEffect(() => {
		if (pendingRef.current.size > 0) return;
		requestedRef.current = current;
		setRequested(current);
	}, [current]);

	const setScale = (scale: number) => {
		// Re-choosing the current level is not an edit: no save, no undo entry.
		if (scale === requestedRef.current) return;
		requestedRef.current = scale;
		setRequested(scale);
		const gen = ++genRef.current;
		pendingRef.current.add(gen);
		const depth = ZOOM_DEPTHS.find((d) => ZOOM_DEPTH_SCALES[d] === scale);
		const write =
			depth === undefined
				? tl.updateZoomCustomScale(region.id, scale)
				: tl.updateZoomDepth(region.id, depth);
		// A refused write hands the level back to the document, so the same one can be retried.
		const settle = (ok: boolean) => {
			pendingRef.current.delete(gen);
			if (ok || gen !== genRef.current) return;
			requestedRef.current = currentRef.current;
			setRequested(currentRef.current);
		};
		void Promise.resolve(write).then(
			(ok) => settle(ok !== false),
			() => settle(false),
		);
	};

	const commitDraft = () => {
		const text = draft
			.trim()
			.replace(",", ".")
			.replace(/\s*[×x]$/i, "");
		setDraft("");
		// Empty or unparseable reverts to the live level rather than guessing at an intent.
		if (text === "" || !Number.isFinite(Number(text))) return;
		const scale = Math.round(Number(text) * 100) / 100;
		if (scale < MIN_ZOOM_SCALE || scale > maxScale) {
			toast.error(ts("zoom.customScaleRange", { min: MIN_ZOOM_SCALE, max: maxScale }));
			return;
		}
		setScale(scale);
	};

	const presets = ZOOM_PRESETS.filter((preset) => preset.value <= maxScale);

	return (
		<>
			{/* A level outside the row presses no button; the field below shows it. With no
			    preset within reach, the row goes and the field alone remains. */}
			{presets.length > 0
				? paneStack(
						ts("zoom.level"),
						<ChoiceRow<number>
							label={ts("zoom.level")}
							options={presets}
							value={requested}
							onChange={setScale}
						/>,
					)
				: null}
			{paneRow(
				ts("zoom.customScale"),
				<input
					type="text"
					inputMode="decimal"
					aria-label={ts("zoom.customScale")}
					placeholder={`${requested}×`}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitDraft}
					// Enter blurs, and the blur handler commits: one path, so a keyboard commit
					// can't apply the same draft twice.
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
					}}
					className={shell.control}
					style={{ width: 84, textAlign: "right" }}
				/>,
			)}
		</>
	);
}

// The speeds people actually reach for, one row of buttons: slow down, back to normal, and three
// steps up. Every other speed (the shared ladder's 0.25×, 3×, 5×, anything up to
// `MAX_PLAYBACK_SPEED`) is one entry in the free field below, which is why the row stays short.
const SPEED_PRESETS = [0.5, 1, 1.5, 2, 4];

/**
 * Preset select + free numeric field, the speed UX this editor already had translations for
 * (`settings.speed.customPlaybackSpeed` / `maxSpeedError`) but no longer any control for: the V4
 * shell replaced the panel that hosted it with a preset-only `<select>` capped at 3×, while the
 * underlying capability goes to `MAX_PLAYBACK_SPEED` (100×). Only the control was missing, so
 * this rewires it rather than adding anything new. `previewFrameSteppingHint` is deliberately
 * not rendered: it describes the legacy editor, while this preview caps at
 * `MAX_NATIVE_PLAYBACK_RATE` (16×) without frame-stepping or muting (see the note below).
 */
export function SpeedControl({
	region,
	tl,
}: {
	region: { id: string; speed: number };
	tl: Pick<TimelineApi, "updateSpeedValue">;
}) {
	const ts = useScopedT("settings");
	// "" means the field is idle and the select is showing the truth. A non-empty draft is
	// uncommitted text; it's cleared on commit so the placeholder tracks the live speed again.
	const [draft, setDraft] = useState("");

	const commitDraft = () => {
		const result = parseCustomPlaybackSpeedInput(draft);
		if (result.status === "valid") {
			void tl.updateSpeedValue(region.id, result.speed);
		} else if (result.status === "too-fast") {
			toast.error(ts("speed.maxSpeedError", { max: MAX_PLAYBACK_SPEED }));
		}
		// Anything else (empty, unparseable, below the floor) just reverts to the live value
		// rather than guessing at an intent.
		setDraft("");
	};

	return (
		<>
			{/* A speed outside the row presses no button; the field below shows it as its
			    placeholder. */}
			{paneStack(
				ts("speed.playbackSpeed"),
				<ChoiceRow<number>
					label={ts("speed.playbackSpeed")}
					options={SPEED_PRESETS.map((speed) => ({ value: speed, label: `${speed}×` }))}
					value={region.speed}
					onChange={(speed) => void tl.updateSpeedValue(region.id, speed)}
				/>,
			)}
			{paneRow(
				ts("speed.customPlaybackSpeed"),
				<input
					type="text"
					inputMode="decimal"
					placeholder={`${region.speed}×`}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitDraft}
					// Enter blurs, and the blur handler commits — one path, so a keyboard commit
					// can't apply the same draft twice.
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
					}}
					className={shell.control}
					style={{ width: 84, textAlign: "right" }}
				/>,
			)}
			{/* No hint past 16×. There is nothing for the user to do about it and nothing that
			    changes in what they get: the export renders the true speed either way. The note
			    that used to sit here described the legacy editor's frame-stepped, silent preview,
			    which is not this one. */}
		</>
	);
}

/**
 * The text size as a free field, committed on blur like the speed and zoom fields above it and
 * read into `SETTING_BOUNDS.annotationFontSize`. It used to write every keystroke as typed, so an
 * emptied field stored a size of 0 and the text vanished.
 */
export function AnnotationSizeField({
	label,
	size,
	onCommit,
}: {
	label: string;
	size: number;
	onCommit: (size: number) => void;
}) {
	// "" means the field is idle and shows the live size as its placeholder.
	const [draft, setDraft] = useState("");
	/** The committed size a draft reads as, or null when it names none. */
	const sizeOf = (text: string) => {
		const typed = text.trim().replace(",", ".");
		// Empty or unparseable reverts to the live size rather than guessing at an intent.
		if (typed === "" || !Number.isFinite(Number(typed))) return null;
		return Math.round(clampToBound(Number(typed), "annotationFontSize"));
	};
	const commitDraft = () => {
		const next = sizeOf(draft);
		setDraft("");
		if (next !== null && next !== size) onCommit(next);
	};
	// A click on the timeline clears the selection on pointerdown, which unmounts this field
	// before its blur can fire. A size typed and never blurred is committed on the way out.
	const pendingRef = useRef({ draft, size, onCommit });
	pendingRef.current = { draft, size, onCommit };
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on unmount; the ref carries the latest draft.
	useEffect(
		() => () => {
			const { draft: left, size: live, onCommit: commit } = pendingRef.current;
			const next = sizeOf(left);
			if (next !== null && next !== live) commit(next);
		},
		[],
	);
	return (
		<input
			type="text"
			inputMode="numeric"
			aria-label={label}
			placeholder={String(size)}
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commitDraft}
			// Enter blurs, and the blur handler commits: one path, so a keyboard commit can't
			// apply the same draft twice.
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
			}}
			className={shell.control}
			style={{ width: 84, textAlign: "right" }}
		/>
	);
}

function SelectionPane({ tl, onClose }: { tl: TimelineApi; onClose: () => void }) {
	const ts = useScopedT("settings");
	const tt = useScopedT("timeline");
	const tc = useScopedT("common");
	const te = useScopedT("editor");
	// Read here rather than threading it through: the zoom pane is the only consumer, and the
	// toggle that writes it lives in the timeline toolbar, not on this component's path.
	const { settings } = useEditorSettings();
	const autoFocusAll = settings.autoFocusAll;
	const doc = useProjectStore((s) => s.document);
	const zoomId = tl.selection?.kind === "zoom" ? tl.selection.id : null;
	const zoomMaxScale = useMemo(
		() => (doc && zoomId ? zoomScaleLimit(doc, zoomId) : MAX_ZOOM_SCALE),
		[doc, zoomId],
	);
	// Mise à jour en direct regroupée à une par frame. `updateAnnotationLive` remplace le document
	// dans le store, donc chaque appel fait reconstruire et re-sérialiser toute la scène avant de
	// la pousser au natif : c'est le juste prix une fois par image, mais un `<input type="color">`
	// émet un événement par pixel de glissement et saturait le thread. La référence garde la
	// dernière fonction du store sans recréer le coalesceur, dont l'état en attente doit survivre
	// aux rendus.
	const liveUpdateRef = useRef(tl.updateAnnotationLive);
	liveUpdateRef.current = tl.updateAnnotationLive;
	const liveUpdate = useMemo(
		() =>
			rafCoalesce((id: string, patch: Partial<AxcutAnnotationRegion>) =>
				liveUpdateRef.current(id, patch),
			),
		[],
	);
	/** Fin de geste : on applique la dernière valeur en attente AVANT d'enregistrer, sinon la
	 *  frame en vol serait perdue et le disque garderait l'avant-dernière couleur. */
	const commitAnnotation = () => {
		liveUpdate.flush();
		void tl.commitAnnotationChange();
	};
	const selection = tl.selection;
	if (!selection) return null;

	const deleteAndClose = () => {
		void tl.removeRegion(selection.kind, selection.id);
		onClose();
	};

	// Le panneau découpe son contenu (coins arrondis + flou), donc un corps sans ascenseur perd
	// silencieusement ce qui dépasse — c'est ce qui arrivait au pane d'annotation, le plus haut de
	// tous, dès qu'on réduisait la fenêtre. L'en-tête reste fixe, le corps défile, comme les
	// panneaux de facette (cf. `.paneBody` de NewEditorShell).
	const bodyStyle: React.CSSProperties = {
		padding: "16px",
		display: "flex",
		flexDirection: "column",
		gap: 16,
		flex: "1 1 auto",
		minHeight: 0,
		overflowY: "auto",
		overflowX: "hidden",
		overscrollBehavior: "contain",
		scrollbarWidth: "thin",
		scrollbarColor: "var(--border) transparent",
	};

	if (selection.kind === "zoom") {
		const region = tl.zoomRegions.find((z) => z.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={16} />, tt("labels.zoom"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<ZoomLevelControl key={region.id} region={region} tl={tl} maxScale={zoomMaxScale} />
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						{paneRow(
							ts("zoom.camera.title"),
							// ONE control for the whole 3D camera: a fixed angle and a moving camera are
							// alternatives, not two settings to combine.
							<select
								aria-label={ts("zoom.camera.title")}
								value={region.rotationPreset ?? "off"}
								onChange={(e) =>
									void tl.updateZoomRotation(
										region.id,
										// "off" is the absence of a preset — the schema field is optional and
										// `migrate.ts` drops it when falsy.
										isRotation3DPreset(e.target.value) ? e.target.value : undefined,
									)
								}
								className={shell.control}
							>
								<option value="off">{ts("zoom.camera.off")}</option>
								<optgroup label={ts("zoom.camera.fixed")}>
									{FIXED_ROTATION_3D_PRESETS.map((preset) => (
										<option key={preset} value={preset}>
											{ts(`zoom.camera.preset.${CAMERA_KEYS[preset]}`)}
										</option>
									))}
								</optgroup>
								{
									// A moving camera reads the cursor track, which the export only loads while
									// the cursor is shown: not offered then, rather than a camera that silently
									// holds still. Still listed once picked, so the select can show it.
									settings.cursorShow || region.rotationPreset === "follow-cursor" ? (
										<optgroup label={ts("zoom.camera.moving")}>
											{MOVING_ROTATION_3D_PRESETS.map((preset) => (
												<option key={preset} value={preset}>
													{ts(`zoom.camera.preset.${CAMERA_KEYS[preset]}`)}
												</option>
											))}
										</optgroup>
									) : null
								}
							</select>,
						)}
					</div>
					{
						// The click follows the visible pointer: without a preset, or with the cursor
						// hidden, the switch would move nothing, so it is not offered.
						region.rotationPreset && settings.cursorShow && !region.hideCursor
							? paneRow(
									ts("zoom.clickImpact.title"),
									<Toggle
										checked={region.clickImpact === true}
										ariaLabel={ts("zoom.clickImpact.title")}
										onChange={(on) => void tl.updateZoomClickImpact(region.id, on)}
									/>,
								)
							: null
					}
					{paneRow(
						ts("zoom.focusMode.title"),
						// While the global toggle is on it OVERRIDES every region, so the control shows
						// the effective mode ("auto") and goes read-only rather than lying about a
						// per-region value that currently has no effect. The region's own `focusMode` is
						// never written by the toggle — that is what makes each zoom snap back to its
						// previous value the moment the toggle goes off.
						<select
							value={autoFocusAll ? "auto" : (region.focusMode ?? "manual")}
							disabled={autoFocusAll}
							onChange={(e) =>
								void tl.updateZoomFocusMode(region.id, e.target.value as "manual" | "auto")
							}
							className={shell.control}
						>
							<option value="manual">{ts("zoom.focusMode.manual")}</option>
							<option value="auto">{ts("zoom.focusMode.auto")}</option>
						</select>,
					)}
					{paneRow(
						ts("zoom.cursor.title"),
						<select
							aria-label={ts("zoom.cursor.title")}
							value={region.hideCursor ? "hide" : "show"}
							onChange={(e) => void tl.updateZoomHideCursor(region.id, e.target.value === "hide")}
							className={shell.control}
						>
							<option value="show">{ts("zoom.cursor.show")}</option>
							<option value="hide">{ts("zoom.cursor.hide")}</option>
						</select>,
					)}
					{autoFocusAll || region.focusMode === "auto" ? (
						// Auto resamples the focus from cursor telemetry every frame, so there is no fixed
						// point to reset and no gimbal on the canvas (ZoomFocusOverlay bows out) — the
						// reset button would be a no-op. When the global toggle is what forced auto, say
						// where to turn it off.
						autoFocusAll ? (
							<p className={shell.hint}>{ts("zoom.focusMode.lockedDisclaimer")}</p>
						) : null
					) : (
						<button
							type="button"
							onClick={() => {
								tl.updateZoomFocusLive(region.id, { cx: 0.5, cy: 0.5 });
								void tl.commitZoomFocus();
							}}
							className={PANE_BUTTON}
						>
							{te("inspector.resetFocusPoint")}
						</button>
					)}
					<button type="button" onClick={deleteAndClose} className={PANE_BUTTON}>
						<Trash2 size={16} style={{ color: "var(--danger)" }} />
						{ts("zoom.deleteZoom")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "speed") {
		const region = tl.speedRegions.find((s) => s.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(<ZoomIn size={16} />, tt("labels.speed"), onClose, tc("actions.close"))}
				<div style={bodyStyle}>
					<SpeedControl region={region} tl={tl} />
					<button type="button" onClick={deleteAndClose} className={PANE_BUTTON}>
						<Trash2 size={16} style={{ color: "var(--danger)" }} />
						{ts("speed.deleteRegion")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "annotation") {
		const region = tl.annotationRegions.find((a) => a.id === selection.id);
		if (!region) return null;
		const plate = textPlateOf(region.style);
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(
					<FileText size={16} />,
					tt("labels.annotationItem"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					{/* Type switch. Only text annotations could ever be created, so image, arrow and
					    blur were unreachable even though the compositor renders all four and every
					    label here already shipped translated. Converting keeps the span and box, so
					    a mistake costs one more click rather than redrawing the region. */}
					{paneStack(
						ts("annotation.type"),
						<ChoiceRow<AnnotationKind>
							label={ts("annotation.type")}
							display="both"
							tiles
							options={[
								{ value: "text", label: ts("annotation.typeText"), icon: <Type size={16} /> },
								{
									value: "image",
									label: ts("annotation.typeImage"),
									icon: <ImageIcon size={16} />,
								},
								{
									value: "figure",
									label: ts("annotation.typeArrow"),
									icon: <ArrowUpRight size={16} />,
								},
								{ value: "blur", label: ts("annotation.typeBlur"), icon: <EyeOff size={16} /> },
							]}
							value={region.type}
							onChange={(kind) => {
								tl.updateAnnotationLive(region.id, convertAnnotationKind(region, kind));
								void tl.commitAnnotationChange();
							}}
						/>,
					)}
					{region.type === "text" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>
								{ts("annotation.textContent")}
							</span>
							<textarea
								value={region.content ?? ""}
								placeholder={ts("annotation.textPlaceholder")}
								onChange={(e) => tl.updateAnnotationLive(region.id, { content: e.target.value })}
								onBlur={commitAnnotation}
								rows={2}
								className={shell.control}
							/>
						</div>
					) : null}
					{region.type === "image" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							{/* Read as a data URL, which is what the renderer expects: `content` holds
							    "Separate storage for image data URL" (types.ts) and both the preview
							    overlay and the compositor read it from there. */}
							<label className={PANE_BUTTON} htmlFor={`ann-img-${region.id}`}>
								{ts("annotation.uploadImage")}
							</label>
							<input
								id={`ann-img-${region.id}`}
								type="file"
								accept="image/jpeg,image/png,image/gif,image/webp"
								style={{ display: "none" }}
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (!file) return;
									if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
										toast.error(ts("annotation.imageFormatsOnly"));
										return;
									}
									const reader = new FileReader();
									reader.onload = () => {
										tl.updateAnnotationLive(region.id, { content: String(reader.result) });
										void tl.commitAnnotationChange();
										toast.success(ts("annotation.imageUploadSuccess"));
									};
									reader.readAsDataURL(file);
								}}
							/>
							<span className={shell.hint}>{ts("annotation.supportedFormats")}</span>
						</div>
					) : null}
					{region.type === "figure" ? (
						<>
							{paneStack(
								ts("annotation.arrowDirection"),
								<ChoiceRow<ArrowDirectionKind>
									label={ts("annotation.arrowDirection")}
									options={ARROW_DIRECTIONS.map(({ value, glyph, Icon }) => ({
										value,
										label: glyph,
										icon: <Icon size={16} />,
									}))}
									value={region.figureData?.arrowDirection ?? "right"}
									onChange={(arrowDirection) => {
										tl.updateAnnotationLive(region.id, {
											figureData: {
												...(region.figureData ?? { color: "#34B27B", strokeWidth: 4 }),
												arrowDirection,
											},
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)}
							{paneRow(
								ts("annotation.arrowColor"),
								<ColorField
									label={ts("annotation.arrowColor")}
									value={region.figureData?.color ?? "#34B27B"}
									onChange={(next) =>
										liveUpdate(region.id, {
											figureData: {
												...(region.figureData ?? { arrowDirection: "right", strokeWidth: 4 }),
												color: next,
											},
										})
									}
									onCommit={commitAnnotation}
								/>,
							)}
							<SliderCell
								label={ts("annotation.strokeWidth", {
									width: region.figureData?.strokeWidth ?? 4,
								})}
								value={region.figureData?.strokeWidth ?? 4}
								min={1}
								max={20}
								// The schema's default (`figureDataSchema`), the width every new arrow starts at.
								defaultValue={4}
								onChange={(next) =>
									tl.updateAnnotationLive(region.id, {
										figureData: {
											...(region.figureData ?? { arrowDirection: "right", color: "#34B27B" }),
											strokeWidth: next,
										},
									})
								}
								onCommit={() => void tl.commitAnnotationChange()}
								// Le libellé i18n interpole déjà « : 11px » ; sans ça on lisait « 11px11 ».
								showValue={false}
							/>
						</>
					) : null}
					{region.type === "blur" ? (
						<>
							{paneStack(
								ts("annotation.blurType"),
								<ChoiceRow<"blur" | "mosaic">
									label={ts("annotation.blurType")}
									options={[
										{ value: "blur", label: ts("annotation.blurTypeBlur") },
										{ value: "mosaic", label: ts("annotation.blurTypeMosaic") },
									]}
									value={region.blurData?.type ?? "mosaic"}
									onChange={(type) => {
										tl.updateAnnotationLive(region.id, {
											blurData: { ...(region.blurData ?? BLUR_DEFAULTS), type },
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)}
							{paneStack(
								ts("annotation.blurShape"),
								<ChoiceRow<"rectangle" | "oval" | "freehand">
									label={ts("annotation.blurShape")}
									options={[
										{ value: "rectangle", label: ts("annotation.blurShapeRectangle") },
										{ value: "oval", label: ts("annotation.blurShapeOval") },
										// Le tracé libre n'est plus proposé à la création : sa saisie était cassée et
										// le rendu ne couvrait que la boîte englobante. Un outil de confidentialité
										// à moitié fiable vaut moins que pas d'outil, parce qu'on lui fait confiance.
										// Le choix reste visible pour une annotation qui l'utilise déjà, avec la
										// phrase qui dit ce que le rendu en fait — plutôt que de le faire disparaître
										// d'un projet existant.
										...(region.blurData?.shape === "freehand"
											? [{ value: "freehand" as const, label: ts("annotation.blurShapeFreehand") }]
											: []),
									]}
									value={region.blurData?.shape ?? "rectangle"}
									onChange={(shape) => {
										tl.updateAnnotationLive(region.id, {
											blurData: { ...(region.blurData ?? BLUR_DEFAULTS), shape },
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)}
							{region.blurData?.shape === "freehand" ? (
								// Say it rather than let the user discover it: the compositor masks the
								// bounding box for a freehand shape, deliberately over-covering instead
								// of leaving anything the user marked private visible in the export.
								<p className={shell.hint}>{te("inspector.freehandRendersAsBox")}</p>
							) : null}
						</>
					) : null}
					{region.type === "text"
						? paneRow(
								ts("annotation.size"),
								// Le nombre saisi vaut « pixels à 1080 » (cf. annotationScale.ts) : preview et
								// rendu le multiplient tous deux par la hauteur de leur boîte, donc ce champ
								// veut dire la même chose des deux côtés.
								<AnnotationSizeField
									label={ts("annotation.size")}
									size={region.style?.fontSize ?? 32}
									onCommit={(fontSize) => {
										tl.updateAnnotationLive(region.id, { style: { ...region.style, fontSize } });
										commitAnnotation();
									}}
								/>,
							)
						: null}
					{region.type === "text"
						? paneStack(
								ts("annotation.background"),
								// Trois plaques nommées : la plaque porte seule l'état allumé/éteint, et en
								// choisir une ajuste un texte qui y deviendrait illisible. Une couleur libre
								// d'un projet plus ancien reste montrée tant qu'elle est là, comme le tracé
								// libre du flou.
								<ChoiceRow<TextPlate | "custom">
									label={ts("annotation.background")}
									options={[
										{ value: "none", label: ts("textPlate.none") },
										{ value: "dark", label: ts("textPlate.dark") },
										{ value: "light", label: ts("textPlate.light") },
										...(plate === "custom"
											? [{ value: "custom" as const, label: ts("textPlate.custom") }]
											: []),
									]}
									value={plate}
									onChange={(next) => {
										if (next === "custom") return;
										tl.updateAnnotationLive(region.id, {
											style: setTextPlate(region.style, next),
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)
						: null}
					{region.type === "text"
						? paneStack(
								ts("annotation.color"),
								<TextColorField
									label={ts("annotation.color")}
									value={region.style?.color ?? "#ffffff"}
									plate={region.style?.backgroundColor ?? "transparent"}
									onChange={(next) =>
										liveUpdate(region.id, {
											style: { ...region.style, color: next },
										})
									}
									onCommit={commitAnnotation}
								/>,
							)
						: null}
					{region.type === "text"
						? paneStack(
								ts("textAnimation.title"),
								// Les sept animations existaient : nommées dans le schéma, traduites dans les
								// treize langues, transportées jusqu'au compositeur — et injouables, faute de
								// ce sélecteur. Trois par rangée : « Typewriter » et ses traductions tiennent.
								<ChoiceRow<AnnotationTextAnimation>
									label={ts("textAnimation.selectAnimation")}
									columns={3}
									options={TEXT_ANIMATION_VALUES.map((value) => ({
										value,
										label: ts(`textAnimation.${value === "slide-left" ? "slideLeft" : value}`),
									}))}
									value={region.style?.textAnimation ?? "none"}
									onChange={(textAnimation) => {
										tl.updateAnnotationLive(region.id, {
											style: { ...region.style, textAnimation },
										});
										void tl.commitAnnotationChange();
									}}
								/>,
							)
						: null}
					<button type="button" onClick={deleteAndClose} className={PANE_BUTTON}>
						<Trash2 size={16} style={{ color: "var(--danger)" }} />
						{ts("annotation.deleteAnnotation")}
					</button>
				</div>
			</div>
		);
	}

	if (selection.kind === "cameraFullscreen") {
		const region = tl.cameraFullscreenRegions.find((c) => c.id === selection.id);
		if (!region) return null;
		return (
			<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
				{paneHeader(
					<Maximize2 size={16} />,
					tt("labels.cameraFullscreen"),
					onClose,
					tc("actions.close"),
				)}
				<div style={bodyStyle}>
					<button type="button" onClick={deleteAndClose} className={PANE_BUTTON}>
						<Trash2 size={16} style={{ color: "var(--danger)" }} />
						{te("inspector.deleteRegion")}
					</button>
				</div>
			</div>
		);
	}

	// trim — a trim ventilated across a clip boundary is 2+ DSL rows that render
	// as one coalesced pill (see V4Timeline's trimPills), so the DURATION shown has to be
	// the group's, not the clicked row's. Deleting no longer needs the same expansion here:
	// `removeRegion` drops the whole pill for every kind (`dropTrimPillsByIds`), which is
	// what this pane used to have to arrange for itself.
	const trimGroup = coalescedTrimGroups(tl.trimRanges, tl.clips).find((g) =>
		g.ids.includes(selection.id),
	);
	if (!trimGroup) return null;
	const durationSec = Math.max(0, trimGroup.end - trimGroup.start);
	const deleteTrimGroup = () => {
		void tl.removeRegion("trim", selection.id);
		onClose();
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
			{paneHeader(<Scissors size={16} />, tt("labels.trim"), onClose, tc("actions.close"))}
			<div style={bodyStyle}>
				<p className={shell.hint}>
					{te("inspector.trimHiddenDuration", { duration: durationSec.toFixed(1) })}
				</p>
				{/* Deleting the trim restores the footage, so it reads as an undo, not a delete. */}
				<button type="button" onClick={deleteTrimGroup} className={PANE_BUTTON}>
					<Undo2 size={16} />
					{te("inspector.restoreDeleteTrim")}
				</button>
			</div>
		</div>
	);
}

/** Every action of the selection pane, delete included: the red icon says it destroys; a red
 *  slab outshouted every setting above it. */
const PANE_BUTTON = `${shell.btn} ${shell.btnSecondary}`;

function FacetBody({
	facet,
	onCollapse,
	transcriptProps,
}: {
	facet: Facet;
	onCollapse: () => void;
	transcriptProps: TranscriptProps;
}) {
	const te = useScopedT("editor");
	// A small collapse affordance floated over the reused pane header.
	const collapse = (
		<button
			type="button"
			title={te("inspector.collapseInspector")}
			aria-label={te("inspector.collapseInspector")}
			onClick={onCollapse}
			style={{
				position: "absolute",
				top: 12,
				right: 12,
				width: 30,
				height: 30,
				display: "grid",
				placeItems: "center",
				borderRadius: 10,
				color: "var(--muted)",
				background: "var(--surface-1)",
				border: 0,
				cursor: "pointer",
				zIndex: 5,
			}}
		>
			<ChevronRight size={16} />
		</button>
	);

	if (facet === "layout") return wrap(collapse, <LayoutPane />);
	if (facet === "audio") return wrap(collapse, <AudioPane />);
	if (facet === "cursor") return wrap(collapse, <CursorPane />);
	if (facet === "transcript") return wrap(collapse, <TranscriptPane {...transcriptProps} />);
	// `effects` is the fallthrough rather than a branch of its own: the union has no
	// tail left now that captions is a popover, and a `never` check here would only
	// restate what the type already says.
	return wrap(collapse, <VideoEffectsPane />);
}

function wrap(collapse: React.ReactNode, body: React.ReactNode) {
	return (
		<div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
			{collapse}
			{body}
		</div>
	);
}
