import { ChevronRight, RotateCcw } from "lucide-react";
import {
	type KeyboardEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import type {
	EditorSettingsPatch,
	EditorSettingsSnapshot,
} from "@/lib/ai-edition/store/editorSettings";
import {
	describeWebcamShadow,
	WEBCAM_SHADOW_BOUNDS,
	WEBCAM_SHADOW_COLORS,
	WEBCAM_SHADOW_PRESETS,
	type WebcamShadowPresetId,
	type WebcamShadowValues,
	webcamShadowCss,
	webcamShadowPreset,
	webcamShadowPresetPatch,
} from "@/lib/webcamShadowStyles";
import css from "./CameraShadowControls.module.css";
import { ColorField } from "./ColorField";
import styles from "./NewEditorShell.module.css";
import { ChoiceRow, SliderCell } from "./RightPanes";

/** Preview scales: what a 1080 px shadow becomes in the tiles and in the position pad. */
const TILE_SCALE = 0.11;
const PAD_SCALE = 0.42;
/** Within this many pixels of an axis, the position snaps onto it. */
const SNAP_PX = 3;
const OPEN_KEY = "os-camera-shadow-customize-open";

type ShadowSettings = Pick<
	EditorSettingsSnapshot,
	| "webcamShadowPreset"
	| "webcamShadowOffsetX"
	| "webcamShadowOffsetY"
	| "webcamShadowBlur"
	| "webcamShadowSpread"
	| "webcamShadowOpacity"
	| "webcamShadowColor"
>;

function valuesOf(settings: ShadowSettings): WebcamShadowValues {
	return {
		offsetX: settings.webcamShadowOffsetX,
		offsetY: settings.webcamShadowOffsetY,
		blur: settings.webcamShadowBlur,
		spread: settings.webcamShadowSpread,
		opacity: settings.webcamShadowOpacity,
		color: settings.webcamShadowColor,
	};
}

function readOpen(): boolean {
	try {
		return window.localStorage.getItem(OPEN_KEY) === "1";
	} catch {
		return false;
	}
}

function writeOpen(open: boolean) {
	try {
		window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
	} catch {
		// A per-viewer convenience: without storage the section just starts closed.
	}
}

/**
 * The picture-in-picture camera's shadow: six presets, then a "Customize" section that tunes
 * position, blur, spread, opacity and colour from the one picked. An edited preset stays
 * pressed and says so, with a way back to it; a shadow from before the presets that matches
 * none of them presses none.
 *
 * Every drag writes live and records one undo step on release (`setLive` + `commit`); a preset
 * or a colour preset is one `set`.
 */
export function CameraShadowControls({
	settings,
	disabled,
	set,
	setLive,
	commit,
}: {
	settings: ShadowSettings;
	disabled: boolean;
	set: (patch: EditorSettingsPatch) => unknown;
	setLive: (patch: EditorSettingsPatch) => void;
	commit: () => unknown;
}) {
	const ts = useScopedT("settings");
	const values = valuesOf(settings);
	const { preset, edited } = describeWebcamShadow(values, settings.webcamShadowPreset);
	const [open, setOpen] = useState(readOpen);
	const bodyId = useId();

	const toggle = () => {
		setOpen((was) => {
			writeOpen(!was);
			return !was;
		});
	};

	/** What an edit tunes: the stored preset, else the one the values match. A 0% shadow
	 *  matches None whatever else it holds, so that match never stands in for a stored base:
	 *  a Custom shadow muted to 0% stays Custom, with its blur, colour and position. */
	const identity: WebcamShadowPresetId | null =
		settings.webcamShadowPreset ?? (preset === "none" ? null : preset);

	/** The patch an edit writes. It keeps the preset the shadow was tuned from, whatever its
	 *  values. The one exception is an explicitly picked None: tuning a shadow that is not there
	 *  would show nothing, so any edit but a 0% opacity starts from Soft's whole shadow and
	 *  becomes an edited Soft. A preset or a Custom shadow tuned down to 0% is not None, and its
	 *  other values are kept. */
	const editPatch = (change: Partial<WebcamShadowValues>): EditorSettingsPatch => {
		const fromNone = identity === "none" && !(change.opacity !== undefined && change.opacity <= 0);
		const start: WebcamShadowValues = fromNone ? webcamShadowPreset("soft") : values;
		const next = { ...start, ...change };
		return {
			webcamShadowPreset: fromNone ? "soft" : identity,
			webcamShadowOffsetX: next.offsetX,
			webcamShadowOffsetY: next.offsetY,
			webcamShadowBlur: next.blur,
			webcamShadowSpread: next.spread,
			webcamShadowOpacity: next.opacity,
			webcamShadowColor: next.color,
		};
	};
	const live = (change: Partial<WebcamShadowValues>) => setLive(editPatch(change));

	const label = (id: WebcamShadowPresetId) => ts(`layout.cameraShadow.${id}`);
	const base = preset ? webcamShadowPreset(preset) : null;

	return (
		<div className={css.root}>
			<div className={styles.sectionLabel}>{ts("effects.shadow")}</div>
			<div style={{ padding: "0 var(--sp-4)" }}>
				<ChoiceRow<WebcamShadowPresetId | "">
					label={ts("effects.shadow")}
					display="both"
					tiles
					columns={3}
					options={WEBCAM_SHADOW_PRESETS.map((p) => ({
						value: p.id,
						label: label(p.id),
						title: ts(`layout.cameraShadow.${p.id}Tip`),
						icon: <ShadowTile values={p} edited={edited && preset === p.id} />,
					}))}
					value={preset ?? ""}
					disabled={disabled}
					onChange={(id) => {
						if (id !== "") void set(webcamShadowPresetPatch(id));
					}}
				/>
			</div>

			<div className={css.disclosureRow}>
				<button
					type="button"
					className={css.disclosure}
					aria-expanded={open}
					aria-controls={bodyId}
					disabled={disabled}
					onClick={toggle}
				>
					<ChevronRight size={14} strokeWidth={2} className={css.chevron} aria-hidden="true" />
					<span>{ts("layout.cameraShadow.customize")}</span>
					{edited ? (
						<span className={css.badge}>{ts("layout.cameraShadow.edited")}</span>
					) : preset === null ? (
						<span className={css.badge}>{ts("layout.cameraShadow.custom")}</span>
					) : null}
				</button>
				{edited && base ? (
					<TooltipProvider>
						<Tooltip content={ts("layout.cameraShadow.resetTip", { preset: label(base.id) })}>
							<button
								type="button"
								className={css.reset}
								disabled={disabled}
								onClick={() => void set(webcamShadowPresetPatch(base.id))}
							>
								<RotateCcw size={12} aria-hidden="true" />
								{ts("layout.cameraShadow.reset")}
							</button>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</div>

			<div
				id={bodyId}
				className={css.collapse}
				data-open={open}
				// Closed, its controls are out of the tab order and the accessibility tree. React 18
				// does not know `inert`, so it goes through as a plain attribute.
				{...(open ? {} : { inert: "" })}
			>
				<div className={css.collapseInner}>
					<PositionPad
						values={values}
						baseOffset={base ? [base.offsetX, base.offsetY] : null}
						disabled={disabled}
						onLive={(offsetX, offsetY) => live({ offsetX, offsetY })}
						onCommit={() => void commit()}
						onReset={(offsetX, offsetY) => void set(editPatch({ offsetX, offsetY }))}
					/>
					<div className={styles.sliderGrid}>
						<SliderCell
							full
							label={ts("layout.cameraShadow.blur")}
							value={values.blur}
							min={WEBCAM_SHADOW_BOUNDS.blur[0]}
							max={WEBCAM_SHADOW_BOUNDS.blur[1]}
							suffix=" px"
							defaultValue={base?.blur}
							disabled={disabled}
							onChange={(blur) => live({ blur })}
							onCommit={() => void commit()}
						/>
						<SliderCell
							full
							label={ts("layout.cameraShadow.spread")}
							value={values.spread}
							min={WEBCAM_SHADOW_BOUNDS.spread[0]}
							max={WEBCAM_SHADOW_BOUNDS.spread[1]}
							suffix=" px"
							defaultValue={base?.spread}
							disabled={disabled}
							onChange={(spread) => live({ spread })}
							onCommit={() => void commit()}
						/>
						<SliderCell
							full
							label={ts("layout.cameraShadow.opacity")}
							value={Math.round(values.opacity * 100)}
							min={0}
							max={100}
							suffix="%"
							defaultValue={base ? Math.round(base.opacity * 100) : undefined}
							disabled={disabled}
							onChange={(pct) => live({ opacity: pct / 100 })}
							onCommit={() => void commit()}
						/>
					</div>
					<div className={`${styles.paneRow} ${css.colorRow}`}>
						<span className={styles.label}>{ts("layout.cameraShadow.color")}</span>
						<ColorField
							label={ts("layout.cameraShadow.color")}
							value={values.color}
							presets={WEBCAM_SHADOW_COLORS}
							disabled={disabled}
							// Only a complete #rrggbb goes out, as for the background colour: the field also
							// emits "#abc" while the hex is being typed.
							onChange={(hex) => {
								if (/^#[0-9a-f]{6}$/i.test(hex)) live({ color: hex.toLowerCase() });
							}}
							onCommit={() => void commit()}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

/** A preset's picture: a camera on a small stage, casting that preset's shadow. */
function ShadowTile({ values, edited }: { values: WebcamShadowValues; edited: boolean }) {
	return (
		<span className={css.tileStage} aria-hidden="true">
			<span className={css.tileCamera} style={{ boxShadow: webcamShadowCss(values, TILE_SCALE) }} />
			{edited ? <span className={css.editedDot} /> : null}
		</span>
	);
}

/**
 * Where the shadow falls, by dragging it. The camera sits in the middle of the pad casting the
 * live shadow; the handle is the shadow's centre, on a line from the camera's. The pad is a
 * square zone at the shadow's own scale, so the handle stays on the shadow it moves.
 */
function PositionPad({
	values,
	baseOffset,
	disabled,
	onLive,
	onCommit,
	onReset,
}: {
	values: WebcamShadowValues;
	baseOffset: [number, number] | null;
	disabled: boolean;
	onLive: (x: number, y: number) => void;
	onCommit: () => void;
	onReset: (x: number, y: number) => void;
}) {
	const ts = useScopedT("settings");
	const tc = useScopedT("common");
	const padRef = useRef<HTMLDivElement>(null);
	const [dragging, setDragging] = useState(false);
	// The pointer that started the drag: a second finger neither moves nor ends it.
	const pointerRef = useRef<number | null>(null);
	// A keyboard move written live and not yet committed.
	const keyPendingRef = useRef(false);
	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;
	const max = WEBCAM_SHADOW_BOUNDS.offset[1];
	const x = values.offsetX;
	const y = values.offsetY;
	const snappedX = dragging && x === 0;
	const snappedY = dragging && y === 0;

	const fromPointer = useCallback(
		(clientX: number, clientY: number): [number, number] => {
			const pad = padRef.current;
			if (!pad) return [x, y];
			const r = pad.getBoundingClientRect();
			const axis = (delta: number) => {
				const v = Math.round(Math.max(-max, Math.min(max, delta / PAD_SCALE)));
				return Math.abs(v) <= SNAP_PX ? 0 : v;
			};
			return [axis(clientX - (r.left + r.width / 2)), axis(clientY - (r.top + r.height / 2))];
		},
		[x, y, max],
	);

	/** Ends whatever is pending, drag or key, with one commit. Clears first, so the
	 *  `lostpointercapture` that follows a release cannot commit the same edit twice. */
	const finish = useCallback(() => {
		const pending = pointerRef.current !== null || keyPendingRef.current;
		pointerRef.current = null;
		keyPendingRef.current = false;
		setDragging(false);
		if (pending) onCommitRef.current();
	}, []);

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (disabled || e.button !== 0 || pointerRef.current !== null) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		pointerRef.current = e.pointerId;
		// A key move still held joins the drag, which commits both on release.
		keyPendingRef.current = false;
		setDragging(true);
		const [nx, ny] = fromPointer(e.clientX, e.clientY);
		onLive(nx, ny);
		padRef.current?.querySelector<HTMLElement>("[role='slider']")?.focus({ preventScroll: true });
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (e.pointerId !== pointerRef.current) return;
		const [nx, ny] = fromPointer(e.clientX, e.clientY);
		if (nx !== x || ny !== y) onLive(nx, ny);
	};
	const endDrag = (e: PointerEvent<HTMLDivElement>) => {
		if (e.pointerId === pointerRef.current) finish();
	};

	// Arrow keys nudge a pixel, ten with Shift; Home centres it. One undo step per key release.
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? 10 : 1;
		const clamp = (v: number) => Math.max(-max, Math.min(max, v));
		const moves: Record<string, [number, number]> = {
			ArrowLeft: [clamp(x - step), y],
			ArrowRight: [clamp(x + step), y],
			ArrowUp: [x, clamp(y - step)],
			ArrowDown: [x, clamp(y + step)],
			Home: [0, 0],
		};
		const next = moves[e.key];
		if (!next) return;
		// The editor's shortcuts listen on window: arrows there move the playhead.
		e.preventDefault();
		e.nativeEvent.stopPropagation();
		// A drag in progress owns the position until it ends.
		if (pointerRef.current !== null) return;
		if (next[0] !== x || next[1] !== y) {
			keyPendingRef.current = true;
			onLive(next[0], next[1]);
		}
	};
	// A key released elsewhere (Shift+Tab mid-press) never comes back here: blur commits it too.
	const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key.startsWith("Arrow") || e.key === "Home") {
			e.nativeEvent.stopPropagation();
			if (keyPendingRef.current && pointerRef.current === null) finish();
		}
	};

	// Disabled, or unmounted mid-edit (playback entering a layout without the camera bubble
	// takes the pad away under the pointer): the edit so far is committed, never left to ride
	// along with the next control's.
	useEffect(() => {
		if (disabled) finish();
	}, [disabled, finish]);
	useEffect(() => finish, [finish]);

	const moved = baseOffset !== null && (baseOffset[0] !== x || baseOffset[1] !== y);
	const valueText = ts("layout.cameraShadow.positionValue", { x: String(x), y: String(y) });

	return (
		<div className={css.position}>
			<div className={css.positionHead}>
				<span className={css.positionLabel}>{ts("layout.cameraShadow.position")}</span>
				<span className={css.readout}>{valueText}</span>
				{moved && baseOffset ? (
					<TooltipProvider>
						<Tooltip content={tc("actions.resetToDefault")}>
							<button
								type="button"
								className={css.iconButton}
								aria-label={`${tc("actions.resetToDefault")}: ${ts("layout.cameraShadow.position")}`}
								disabled={disabled}
								onClick={() => onReset(baseOffset[0], baseOffset[1])}
							>
								<RotateCcw size={12} aria-hidden="true" />
							</button>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</div>
			<div
				ref={padRef}
				className={css.pad}
				data-dragging={dragging}
				data-disabled={disabled}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				onLostPointerCapture={endDrag}
			>
				<span className={css.axisX} data-snapped={snappedY} aria-hidden="true" />
				<span className={css.axisY} data-snapped={snappedX} aria-hidden="true" />
				<span
					className={css.padCamera}
					style={{ boxShadow: webcamShadowCss(values, PAD_SCALE) }}
					aria-hidden="true"
				/>
				{/* A zero-size origin at the pad's centre: SVG coordinates take no calc(). */}
				<svg className={css.vector} width="1" height="1" aria-hidden="true">
					<line x1="0" y1="0" x2={x * PAD_SCALE} y2={y * PAD_SCALE} />
				</svg>
				<div
					role="slider"
					tabIndex={disabled ? -1 : 0}
					aria-label={ts("layout.cameraShadow.positionLabel")}
					aria-valuemin={-max}
					aria-valuemax={max}
					aria-valuenow={y}
					aria-valuetext={valueText}
					aria-disabled={disabled || undefined}
					className={css.handle}
					style={{ transform: `translate(${x * PAD_SCALE}px, ${y * PAD_SCALE}px)` }}
					onKeyDown={onKeyDown}
					onKeyUp={onKeyUp}
					onBlur={() => {
						if (keyPendingRef.current && pointerRef.current === null) finish();
					}}
				/>
			</div>
		</div>
	);
}
