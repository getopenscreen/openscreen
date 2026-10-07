import { Check, Languages, NotepadText, Settings } from "lucide-react";
import {
	createContext,
	memo,
	type ReactElement,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { moveMenuFocus } from "@/lib/menuKeyboard";
import { formatTimePadded } from "../../utils/timeUtils";
import { Button } from "../ui/button";
import { TOOLTIP_GAP_PX, Tooltip } from "../ui/tooltip";
import {
	CameraIcon,
	CursorIcon,
	getIcon,
	ICON_SIZE,
	MicIcon,
	OpenInEditorIcon,
	OrientationIcon,
	RecordGlyph,
	SourceIcon,
	VolumeIcon,
} from "./HudIcons";
import { computeHudTooltipClearance } from "./hudGeometry";
import styles from "./LaunchWindow.module.css";

// Every control below is a `memo` boundary on purpose. The HUD's root re-renders
// once a second for the whole duration of a recording (the elapsed-time counter),
// and without these boundaries each of those ticks rebuilt ~15 Radix tooltip trees
// and ~60 host elements. Props are kept primitive (or stable refs/callbacks from
// the parent) so the boundaries actually hold.

const hudDisabledClasses =
	"disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none";

// A control that is only locked for the length of a take (the toggles and the gear) keeps its
// tooltip, so it says `aria-disabled` instead of `disabled`: a natively disabled button takes no
// pointer events at all, and its tooltip could never open. Dimmed, no hover wash, no press.
const hudLockedClasses =
	"aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:active:scale-100";

// The bar's orientation decides which side its tooltips open on. A horizontal bar has all the
// reserve of the transparent window above it, so its tooltips go up. In a vertical bar "up" is
// over the controls above the one under the pointer, the ones the user reaches for next, so the
// tooltips go beside it: the bar is centred in a window about 650px wide or more (hudGeometry.ts),
// so the 260px maximum fits on either side.
const HudVerticalContext = createContext(false);
export const HudLayoutProvider = HudVerticalContext.Provider;

// Keeps a tooltip off the window's own edge, where its shadow would be cut.
const HUD_TOOLTIP_EDGE_PADDING = 8;

// Radix places a tooltip against its trigger, but what the eye sees is the bar around it. The
// bar pads the button, and a vertical bar widens to fit the timer while recording, so a gap
// measured from the trigger left the tooltip overlapping the bar. The distance to the bar's
// edge is measured when the tooltip opens (hence the controlled `open`: the offset has to be
// right in the render that shows it, not one effect later) and added to the primitive's gap.
function HudTooltip({ content, children }: { content: string; children: ReactElement }) {
	const vertical = useContext(HudVerticalContext);
	const side = vertical ? "right" : "top";
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const [clearance, setClearance] = useState(0);

	const handleOpenChange = (next: boolean) => {
		const trigger = triggerRef.current;
		const bar = trigger?.closest("[data-tray-layout]");
		if (next && trigger && bar) {
			setClearance(
				computeHudTooltipClearance(
					trigger.getBoundingClientRect(),
					bar.getBoundingClientRect(),
					side,
				),
			);
		}
		setOpen(next);
	};

	return (
		<Tooltip
			ref={triggerRef}
			content={content}
			side={side}
			sideOffset={TOOLTIP_GAP_PX + clearance}
			collisionPadding={HUD_TOOLTIP_EDGE_PADDING}
			open={open}
			onOpenChange={handleOpenChange}
		>
			{children}
		</Tooltip>
	);
}

// The browser's default focus outline all but disappears on the dark bar.
const hudFocusClasses =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#10b981]/70";

// Exact values from the design's renderVals() (comfortable density, rounded
// shape, #10b981 accent) — btnSize 34 / btnRadius 10 / containerRadius 17
// (btnRadius + padY) / dividerLen 22. Every control is its own standalone
// transparent icon button (no shared "group" pill background) — grouping
// reads purely from proximity + the divider spans between logical sections.
// Hover is a white wash rather than a darker grey: #1a1e25 on the #14171c bar
// was all but invisible.
const hudIconBtnClasses = `flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-white/[0.08] hover:text-[#f5f7fa] active:scale-95 ${hudDisabledClasses} ${hudFocusClasses} ${styles.electronNoDrag}`;

const hudAuxIconBtnClasses = `flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#9aa3ae] transition-colors duration-150 hover:bg-white/[0.08] hover:text-[#f5f7fa] ${hudDisabledClasses} ${hudFocusClasses}`;

const windowBtnClasses = `flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-white/[0.08] hover:text-[#e9edf3] ${hudDisabledClasses} ${hudFocusClasses}`;

const closeBtnClasses = `flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent cursor-pointer text-[#828c99] transition-all duration-150 hover:bg-[rgba(248,113,113,0.16)] hover:text-[#f87171] ${hudDisabledClasses} ${hudFocusClasses}`;

export const HudDivider = memo(function HudDivider({ vertical }: { vertical: boolean }) {
	return (
		<span
			className={`${styles.hudDivider} ${vertical ? styles.hudDividerVertical : styles.hudDividerHorizontal}`}
			aria-hidden
		/>
	);
});

export const HudDragHandle = memo(function HudDragHandle({
	vertical,
	nativeDrag,
	onPointerDown,
	onPointerMove,
	onPointerEnd,
}: {
	vertical: boolean;
	/**
	 * Hand the gesture to the compositor instead of the pointer handlers below.
	 *
	 * Wayland forbids a client from reading or setting its own global position:
	 * `getPosition()` answers [0, 0] and `setPosition()` only updates Electron's
	 * own cache, so the origin+delta scheme the handlers implement cannot move
	 * the window there. `-webkit-app-region: drag` is the one path that does —
	 * it routes to `xdg_toplevel.move` and the compositor performs the move.
	 *
	 * A drag region swallows pointer events, so the two are mutually exclusive:
	 * platforms that can position themselves keep the handler path, which gives
	 * finer control and lets the HUD suppress resizes mid-gesture.
	 */
	nativeDrag: boolean;
	onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
	return (
		<div
			data-testid="hud-drag-handle"
			className={`flex ${vertical ? "h-6 w-8" : "h-8 w-7"} shrink-0 cursor-grab items-center justify-center active:cursor-grabbing ${
				nativeDrag ? styles.electronDrag : styles.electronNoDrag
			}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
		>
			{getIcon("drag", "text-[#5c6672]")}
		</div>
	);
});

export const HudTrayLayoutButton = memo(function HudTrayLayoutButton({
	vertical,
	label,
	onClick,
}: {
	vertical: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={label}>
			<button
				data-testid="launch-tray-layout-button"
				type="button"
				aria-label={label}
				className={hudIconBtnClasses}
				onClick={onClick}
			>
				<OrientationIcon vertical={vertical} />
			</button>
		</HudTooltip>
	);
});

export const HudSourceButton = memo(function HudSourceButton({
	vertical,
	label,
	tooltip,
	remembered = false,
	disabled,
	onClick,
}: {
	vertical: boolean;
	/** The source's name: what the button shows, and its accessible name. */
	label: string;
	/** What a click does, which the name alone does not say. */
	tooltip: string;
	/** The label names the last pick, which is not live: same button, rest colour. */
	remembered?: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={tooltip}>
			<button
				type="button"
				data-testid="launch-source-selector-button"
				data-remembered={remembered || undefined}
				className={`flex h-[34px] shrink-0 items-center gap-[7px] rounded-[10px] border-0 bg-transparent ${
					remembered ? "text-[#828c99] hover:text-[#f5f7fa]" : "text-[#f5f7fa]"
				} transition-all duration-150 hover:bg-white/[0.08] active:scale-[0.97] ${hudDisabledClasses} ${hudFocusClasses} ${
					vertical ? "w-[34px] justify-center px-0" : "pr-3 pl-2.5"
				} ${styles.electronNoDrag}`}
				onClick={onClick}
				disabled={disabled}
				aria-label={label}
			>
				<SourceIcon className="shrink-0" />
				<span
					className={`${vertical ? "sr-only" : "max-w-[86px]"} truncate text-[13px] font-medium`}
				>
					{label}
				</span>
			</button>
		</HudTooltip>
	);
});

// The three toggles below and the cursor button share one pattern: a constant `name`, the state
// in `aria-pressed`, and one `tooltip` sentence. While a take runs they are `locked`: still
// there, still focusable and hoverable, still saying what is being recorded, and inert.

export const HudSystemAudioButton = memo(function HudSystemAudioButton({
	enabled,
	locked,
	name,
	tooltip,
	onClick,
}: {
	enabled: boolean;
	locked: boolean;
	name: string;
	tooltip: string;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={tooltip}>
			<button
				type="button"
				data-testid="launch-system-audio-button"
				className={`${hudIconBtnClasses} ${hudLockedClasses}`}
				aria-label={name}
				aria-pressed={enabled}
				aria-disabled={locked || undefined}
				onClick={locked ? undefined : onClick}
			>
				<VolumeIcon muted={!enabled} className={enabled ? "text-[#10b981]" : ""} />
			</button>
		</HudTooltip>
	);
});

export const HudMicButton = memo(function HudMicButton({
	enabled,
	locked,
	name,
	tooltip,
	onClick,
}: {
	enabled: boolean;
	locked: boolean;
	name: string;
	tooltip: string;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={tooltip}>
			<button
				type="button"
				data-testid="launch-microphone-button"
				className={`${hudIconBtnClasses} ${hudLockedClasses}`}
				aria-label={name}
				aria-pressed={enabled}
				aria-disabled={locked || undefined}
				onClick={locked ? undefined : onClick}
			>
				<MicIcon muted={!enabled} className={enabled ? "text-[#10b981]" : ""} />
			</button>
		</HudTooltip>
	);
});

export const HudCameraButton = memo(function HudCameraButton({
	enabled,
	locked,
	name,
	tooltip,
	onClick,
}: {
	enabled: boolean;
	locked: boolean;
	name: string;
	tooltip: string;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={tooltip}>
			<button
				type="button"
				data-testid="launch-webcam-button"
				className={`${hudIconBtnClasses} ${hudLockedClasses}`}
				aria-label={name}
				aria-pressed={enabled}
				aria-disabled={locked || undefined}
				onClick={locked ? undefined : onClick}
			>
				<CameraIcon off={!enabled} className={enabled ? "text-[#10b981]" : ""} />
			</button>
		</HudTooltip>
	);
});

export const HudSettingsButton = memo(function HudSettingsButton({
	locked,
	expanded,
	label,
	onClick,
	buttonRef,
}: {
	locked: boolean;
	expanded: boolean;
	label: string;
	onClick: () => void;
	buttonRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
	return (
		<HudTooltip content={label}>
			<button
				ref={buttonRef}
				type="button"
				data-testid="launch-device-settings-button"
				aria-label={label}
				aria-expanded={expanded}
				aria-haspopup="dialog"
				aria-disabled={locked || undefined}
				// Dimmer at rest than the toggles it configures, so it reads as their
				// accessory rather than a fourth peer control.
				className={`${hudIconBtnClasses} ${hudLockedClasses} text-[#5c6672]`}
				onClick={locked ? undefined : onClick}
			>
				<Settings size={17} />
			</button>
		</HudTooltip>
	);
});

export const HudCursorButton = memo(function HudCursorButton({
	editableOverlay,
	locked,
	name,
	tooltip,
	onClick,
}: {
	editableOverlay: boolean;
	locked: boolean;
	name: string;
	/** One sentence per mode: each defines the mode it names. */
	tooltip: string;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={tooltip}>
			<button
				type="button"
				data-testid="launch-cursor-mode-button"
				aria-label={name}
				aria-pressed={editableOverlay}
				aria-disabled={locked || undefined}
				className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border-0 cursor-pointer transition-all duration-150 active:scale-95 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:scale-100 ${hudFocusClasses} ${styles.electronNoDrag} ${
					editableOverlay
						? "bg-[#10b981] text-[#08090d] hover:bg-[#0e9e6e] aria-disabled:hover:bg-[#10b981]"
						: "bg-transparent text-[#828c99] hover:bg-white/[0.08] hover:text-[#f5f7fa] aria-disabled:hover:bg-transparent"
				}`}
				onClick={locked ? undefined : onClick}
			>
				<CursorIcon off={!editableOverlay} />
			</button>
		</HudTooltip>
	);
});

export const HudRecordButton = memo(function HudRecordButton({
	recording,
	paused,
	saving,
	elapsedSeconds,
	label,
	savingLabel,
	onClick,
}: {
	recording: boolean;
	paused: boolean;
	saving: boolean;
	elapsedSeconds: number;
	label: string;
	savingLabel: string;
	onClick: () => void;
}) {
	return (
		// The tooltip is the only one: it carries the name, and a native `title` beside it
		// stacked a second, OS-drawn tooltip on the same button.
		<HudTooltip content={label}>
			<button
				data-testid="launch-record-button"
				disabled={saving}
				// A soft red wash at rest, so the main action reads as one from across the bar.
				className={`flex h-[34px] shrink-0 items-center justify-center rounded-[17px] border-0 transition-all duration-150 ${recording || saving ? "min-w-[78px] px-3" : "w-[34px]"} ${hudFocusClasses} ${styles.electronNoDrag} ${
					saving
						? "bg-transparent opacity-60 cursor-not-allowed"
						: "bg-[rgba(248,113,113,0.12)] hover:bg-[rgba(248,113,113,0.22)]"
				}`}
				onClick={onClick}
				aria-label={label}
				style={{ flex: "0 0 auto" }}
			>
				<div className={`flex items-center justify-center ${recording || saving ? "gap-1.5" : ""}`}>
					{saving ? (
						<div className="animate-spin flex items-center justify-center">
							{getIcon("spinner", "text-[#f87171]")}
						</div>
					) : (
						<RecordGlyph
							recording={recording}
							className={paused ? "text-amber-400" : "text-[#f87171]"}
						/>
					)}
					{saving && (
						<span className="text-[#f87171] text-xs font-semibold select-none">{savingLabel}</span>
					)}
					{recording && (
						<span
							className={`${paused ? "text-amber-400" : "text-[#f87171]"} inline-block w-[34px] text-left text-xs font-semibold tabular-nums`}
						>
							{formatTimePadded(elapsedSeconds)}
						</span>
					)}
				</div>
			</button>
		</HudTooltip>
	);
});

export const HudStudioButton = memo(function HudStudioButton({
	disabled,
	label,
	onClick,
}: {
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={label}>
			<button
				data-testid="launch-open-studio-button"
				aria-label={label}
				disabled={disabled}
				className={hudIconBtnClasses}
				onClick={onClick}
			>
				<OpenInEditorIcon />
			</button>
		</HudTooltip>
	);
});

export const HudNotesButton = memo(function HudNotesButton({
	disabled,
	label,
	onClick,
}: {
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<HudTooltip content={label}>
			<button
				type="button"
				aria-label={label}
				disabled={disabled}
				className={hudIconBtnClasses}
				onClick={onClick}
			>
				<NotepadText size={ICON_SIZE} />
			</button>
		</HudTooltip>
	);
});

export const HudRecordingControls = memo(function HudRecordingControls({
	vertical,
	paused,
	saving,
	canPause,
	pauseLabel,
	restartLabel,
	cancelLabel,
	onTogglePause,
	onRestart,
	onCancel,
}: {
	vertical: boolean;
	paused: boolean;
	saving: boolean;
	canPause: boolean;
	pauseLabel: string;
	restartLabel: string;
	cancelLabel: string;
	onTogglePause: () => void;
	onRestart: () => void;
	onCancel: () => void;
}) {
	return (
		<div
			className={`flex items-center gap-0.5 ${vertical ? "flex-col" : ""} ${styles.electronNoDrag}`}
		>
			{canPause && (
				<HudTooltip content={pauseLabel}>
					<button
						data-testid="launch-pause-button"
						className={hudAuxIconBtnClasses}
						aria-label={pauseLabel}
						onClick={onTogglePause}
						disabled={saving}
					>
						{getIcon(paused ? "resume" : "pause", paused ? "text-amber-400" : undefined)}
					</button>
				</HudTooltip>
			)}
			<HudTooltip content={restartLabel}>
				<button
					data-testid="launch-restart-button"
					className={hudAuxIconBtnClasses}
					aria-label={restartLabel}
					onClick={onRestart}
					disabled={saving}
				>
					{getIcon("restart")}
				</button>
			</HudTooltip>
			<HudTooltip content={cancelLabel}>
				<button
					data-testid="launch-cancel-button"
					className={hudAuxIconBtnClasses}
					aria-label={cancelLabel}
					onClick={onCancel}
					disabled={saving}
				>
					{getIcon("cancel")}
				</button>
			</HudTooltip>
		</div>
	);
});

export const HudLanguageButton = memo(function HudLanguageButton({
	vertical,
	code,
	label,
	disabled,
	expanded,
	onClick,
	buttonRef,
}: {
	vertical: boolean;
	code: string;
	label: string;
	disabled: boolean;
	expanded: boolean;
	onClick: () => void;
	buttonRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
	return (
		<HudTooltip content={label}>
			<button
				ref={buttonRef}
				type="button"
				aria-label={label}
				aria-expanded={expanded}
				aria-haspopup="menu"
				disabled={disabled}
				onClick={onClick}
				className={`flex h-[34px] items-center rounded-[10px] border-0 bg-transparent text-[#828c99] transition-all duration-150 hover:bg-white/[0.08] hover:text-[#e9edf3] ${
					vertical ? "w-[34px] justify-center px-0" : "gap-1.5 px-2.5"
				} ${hudDisabledClasses} ${hudFocusClasses} ${styles.electronNoDrag}`}
			>
				<Languages size={16} className="shrink-0" />
				<span className={`${vertical ? "sr-only" : ""} text-[12px] font-semibold text-[#f5f7fa]`}>
					{code}
				</span>
			</button>
		</HudTooltip>
	);
});

export const HudWindowControls = memo(function HudWindowControls({
	vertical,
	disabled,
	hideLabel,
	hideTooltip,
	closeLabel,
	onHide,
	onClose,
}: {
	vertical: boolean;
	disabled: boolean;
	/** The accessible name; the tooltip goes on to say how to get the bar back. */
	hideLabel: string;
	hideTooltip: string;
	closeLabel: string;
	onHide: () => void;
	onClose: () => void;
}) {
	return (
		<div className={`flex items-center gap-[5px] ${vertical ? "flex-col" : ""}`}>
			<HudTooltip content={hideTooltip}>
				<button
					type="button"
					className={windowBtnClasses}
					aria-label={hideLabel}
					onClick={onHide}
					disabled={disabled}
				>
					{getIcon("minimize")}
				</button>
			</HudTooltip>
			<HudTooltip content={closeLabel}>
				<button
					type="button"
					className={closeBtnClasses}
					aria-label={closeLabel}
					onClick={onClose}
					disabled={disabled}
				>
					{getIcon("close")}
				</button>
			</HudTooltip>
		</div>
	);
});

export const HudLanguageMenu = memo(function HudLanguageMenu({
	locales,
	activeLocale,
	getName,
	onSelect,
	panelRef,
	onEnsureInteractive,
}: {
	locales: readonly string[];
	activeLocale: string;
	getName: (locale: string) => string;
	onSelect: (locale: string) => void;
	panelRef: (el: HTMLDivElement | null) => void;
	onEnsureInteractive: () => void;
}) {
	// Into the list as it opens, on the language in use, so the arrows work straight away.
	const activeItemRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		activeItemRef.current?.focus();
	}, []);

	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid="hud-language-menu"
			role="menu"
			onKeyDown={moveMenuFocus}
			className={`${styles.hudPopover} ${styles.hudPopoverScroll} ${styles.hudScrollbar} animate-mic-panel-in ${styles.electronNoDrag}`}
			onPointerDown={(event) => event.stopPropagation()}
			onPointerEnter={onEnsureInteractive}
			onWheel={(event) => {
				onEnsureInteractive();
				event.stopPropagation();
			}}
		>
			{locales.map((loc) => (
				<button
					key={loc}
					ref={loc === activeLocale ? activeItemRef : undefined}
					type="button"
					role="menuitemradio"
					aria-checked={loc === activeLocale}
					onClick={() => onSelect(loc)}
					className={`${styles.languageMenuItem} ${loc === activeLocale ? styles.languageMenuItemActive : ""}`}
				>
					<span className="truncate">{getName(loc)}</span>
					{loc === activeLocale ? <Check size={14} className="text-white/85" /> : null}
				</button>
			))}
		</div>
	);
});

export const HudNotice = memo(function HudNotice({
	title,
	description,
	dismissLabel,
	confirmLabel,
	onDismiss,
	onConfirm,
}: {
	title: string;
	description: string;
	dismissLabel: string;
	confirmLabel: string;
	onDismiss: () => void;
	onConfirm: () => void;
}) {
	return (
		<div
			data-hud-interactive="true"
			className={`${styles.hudNotice} w-full p-3 text-white animate-in fade-in-0 zoom-in-95 duration-200 ${styles.electronNoDrag}`}
		>
			<div className="text-[14px] font-semibold text-white">{title}</div>
			<div className="mt-1 text-[12.5px] leading-relaxed text-white/75">{description}</div>
			<div className="mt-3 flex items-center justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onDismiss}
					className={`h-8 rounded-[9px] text-[13px] text-white/80 hover:bg-white/10 hover:text-white ${hudFocusClasses}`}
				>
					{dismissLabel}
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={onConfirm}
					className={`h-8 rounded-[9px] bg-[#10b981] text-[13px] font-semibold text-[#08090d] hover:bg-[#10b981]/85 ${hudFocusClasses}`}
				>
					{confirmLabel}
				</Button>
			</div>
		</div>
	);
});
