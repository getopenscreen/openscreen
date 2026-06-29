// Six right-rail panes matching design/openscreen-editor.html. Each control
// reads from + writes to the project document via `useEditorSettings`, so the
// design's UI is the canonical surface (no more "more options" link to a
// legacy panel — the legacy SettingsPanel is still available to the legacy
// VideoEditor and to per-region inspectors, but the panes here are
// self-sufficient).

import {
	Crop as CropIcon,
	FileText,
	HelpCircle,
	Layout as LayoutIcon,
	MousePointerClick,
	Palette,
	Sliders,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { CURSOR_THEMES } from "@/lib/cursor/cursorThemes";
import styles from "./NewEditorShell.module.css";
import { TranscriptEditor } from "./TranscriptEditor";

export type RightPaneId =
	| "background"
	| "transcript"
	| "effects"
	| "layout"
	| "cursor"
	| "timeline";

interface PaneProps {
	title: string;
	icon: ReactNode;
	helpLabel?: string;
	children: ReactNode;
}

function Pane({ title, icon, helpLabel, children }: PaneProps) {
	return (
		<div className={`${styles.pane} ${styles.isActive}`}>
			<header className={styles.paneHead}>
				<h2>{title}</h2>
				<span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
					<button
						type="button"
						className={styles.iconBtn}
						title={helpLabel ?? "Help"}
						aria-label={helpLabel ?? "Help"}
					>
						<HelpCircle size={14} />
					</button>
				</span>
				<span style={{ display: "none" }}>{icon}</span>
			</header>
			<div className={styles.paneBody}>{children}</div>
		</div>
	);
}

// ─── Background ────────────────────────────────────────────────────

const BG_PRESETS: readonly string[] = [
	"linear-gradient(135deg, #16171d, #10b981)",
	"linear-gradient(135deg, #bcc0c6, #6b7280)",
	"linear-gradient(135deg, #6b7280, #16171d)",
	"linear-gradient(135deg, #10b981, #6b7280)",
	"linear-gradient(135deg, #bcc0c6, #10b981)",
	"linear-gradient(135deg, #eaebed, #6b7280)",
	"linear-gradient(135deg, #6b7280, #bcc0c6)",
	"linear-gradient(135deg, #10b981, #eaebed)",
	"linear-gradient(135deg, #16171d, #6b7280)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #10b981, #eaebed)",
	"linear-gradient(135deg, #eaebed, #ffffff)",
	"linear-gradient(135deg, #6b7280, #16171d)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #16171d, #6b7280)",
];

const GRAD_PRESETS: readonly string[] = [
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #10b981, #eaebed)",
	"linear-gradient(135deg, #6b7280, #bcc0c6)",
	"linear-gradient(135deg, #eaebed, #10b981)",
	"linear-gradient(135deg, #eaebed, #10b981)",
	"linear-gradient(135deg, #bcc0c6, #16171d)",
	"linear-gradient(135deg, #16171d, #6b7280)",
	"linear-gradient(135deg, #6b7280, #10b981)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #6b7280, #eaebed)",
	"linear-gradient(135deg, #eaebed, #10b981)",
	"linear-gradient(135deg, #bcc0c6, #10b981)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #eaebed, #10b981)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #bcc0c6, #10b981)",
	"linear-gradient(135deg, #16171d, #6b7280)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #eaebed, #bcc0c6)",
	"linear-gradient(135deg, #6b7280, #16171d)",
	"linear-gradient(135deg, #bcc0c6, #eaebed)",
	"linear-gradient(135deg, #10b981, #bcc0c6)",
	"linear-gradient(135deg, #10b981, #bcc0c6)",
	"linear-gradient(135deg, #bcc0c6, #10b981)",
	"linear-gradient(135deg, #10b981, #6b7280)",
];

export function BackgroundPane() {
	const { settings, set, hasDocument } = useEditorSettings();
	const [tab, setTab] = useState<"image" | "color" | "gradient">("image");
	const isSelected = (value: string) => settings.wallpaper === value;
	return (
		<Pane title="Background" icon={<Palette size={14} />}>
			<div className={styles.paneTabs} role="tablist">
				<button
					type="button"
					className={tab === "image" ? styles.isActive : ""}
					onClick={() => setTab("image")}
				>
					Image
				</button>
				<button
					type="button"
					className={tab === "color" ? styles.isActive : ""}
					onClick={() => setTab("color")}
				>
					Color
				</button>
				<button
					type="button"
					className={tab === "gradient" ? styles.isActive : ""}
					onClick={() => setTab("gradient")}
				>
					Gradient
				</button>
			</div>
			{tab === "image" ? (
				<>
					<button type="button" className={styles.uploadBtn} disabled={!hasDocument}>
						Upload custom
					</button>
					<div className={styles.bgGrid}>
						{BG_PRESETS.map((bg, i) => (
							<button
								type="button"
								key={i}
								className={`${styles.bgThumb} ${isSelected(bg) ? styles.isActive : ""}`}
								style={{ background: bg }}
								aria-label={`Background ${i + 1}`}
								disabled={!hasDocument}
								onClick={() => void set({ wallpaper: bg })}
							/>
						))}
					</div>
				</>
			) : tab === "color" ? (
				<>
					<div style={subTabRow()}>
						<button type="button" style={subTabStyle(true)}>
							Color wheel
						</button>
						<button type="button" style={subTabStyle(false)}>
							Palette
						</button>
					</div>
					<div style={colorPreviewStyle()}>
						{settings.wallpaper.startsWith("linear-") ||
						settings.wallpaper.startsWith("radial-") ||
						settings.wallpaper.startsWith("conic-")
							? "Gradient"
							: (settings.wallpaper || "—").slice(0, 16)}
					</div>
					<div style={colorWheelStyle(settings.wallpaper)} />
					<div style={hueTrackStyle()} />
					<div style={hexInputStyle()}>{settings.wallpaper.slice(0, 32)}</div>
				</>
			) : (
				<div className={styles.bgGrid}>
					{GRAD_PRESETS.map((bg, i) => (
						<button
							type="button"
							key={i}
							className={`${styles.bgThumb} ${isSelected(bg) ? styles.isActive : ""}`}
							style={{ background: bg }}
							aria-label={`Gradient ${i + 1}`}
							disabled={!hasDocument}
							onClick={() => void set({ wallpaper: bg })}
						/>
					))}
				</div>
			)}
		</Pane>
	);
}

// ─── Transcript ────────────────────────────────────────────────────

export function TranscriptPane({
	transcript,
	clips,
	currentTimeSec,
	onSeek,
	onDropWordRange,
	onTranscribe,
	canTranscribe,
	isTranscribing,
}: {
	transcript: AxcutTranscript | null;
	clips: AxcutClip[];
	currentTimeSec: number;
	onSeek: (sec: number) => void;
	onDropWordRange: (start: number, end: number) => void;
	onTranscribe: () => void;
	canTranscribe: boolean;
	isTranscribing: boolean;
}) {
	if (!transcript) {
		return (
			<Pane title="Current transcription" icon={<FileText size={14} />}>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						padding: 32,
						gap: 12,
						color: "var(--muted)",
						textAlign: "center",
					}}
				>
					<FileText size={28} style={{ color: "var(--dim)" }} />
					<p style={{ font: "500 13px var(--font-body)", color: "var(--fg-2)" }}>
						No transcript yet
					</p>
					<p style={{ font: "400 12px var(--font-body)", color: "var(--muted)", maxWidth: 260 }}>
						Transcribe uses local Whisper — runs in your browser, no data leaves the device.
					</p>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnPrimary}`}
						onClick={onTranscribe}
						disabled={!canTranscribe || isTranscribing}
					>
						{isTranscribing ? "Transcribing…" : "Transcribe now"}
					</button>
				</div>
			</Pane>
		);
	}
	return (
		<div className={`${styles.pane} ${styles.isActive}`}>
			<header className={styles.paneHead}>
				<h2>Current transcription</h2>
			</header>
			<div className={styles.paneBody}>
				<TranscriptEditor
					transcript={transcript}
					clips={clips}
					currentTimeSec={currentTimeSec}
					onSeek={onSeek}
					onDropWordRange={onDropWordRange}
				/>
			</div>
		</div>
	);
}

// ─── Video Effects ─────────────────────────────────────────────────

export function VideoEffectsPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	return (
		<Pane title="Video effects" icon={<Sliders size={14} />}>
			<div className={styles.paneRow}>
				<span className="label">Blur BG</span>
				<Toggle
					checked={settings.showBlur}
					disabled={!hasDocument}
					onChange={(v) => void set({ showBlur: v })}
				/>
			</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label="Motion blur"
					value={settings.motionBlurAmount * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ motionBlurAmount: v / 100 })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Shadow"
					value={settings.shadowIntensity * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ shadowIntensity: v / 100 })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Roundness"
					value={settings.borderRadius}
					min={0}
					max={64}
					step={0.5}
					suffix="px"
					disabled={!hasDocument}
					onChange={(v) => setLive({ borderRadius: v })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Padding"
					value={settings.padding}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ padding: v })}
					onCommit={() => void commit()}
				/>
			</div>
		</Pane>
	);
}

// ─── Layout (webcam) ──────────────────────────────────────────────

const WEBCAM_PRESETS = [
	{ value: "picture-in-picture", label: "Picture in picture" },
	{ value: "side-by-side", label: "Side by side" },
	{ value: "vertical-stack", label: "Top / bottom" },
	{ value: "no-webcam", label: "Screen only" },
] as const;

const CAMERA_SHAPES: Array<{
	value: "rectangle" | "circle" | "square" | "rounded";
	label: string;
	icon: ReactNode;
}> = [
	{ value: "rectangle", label: "Rect", icon: <rect x="3" y="6" width="18" height="12" rx="1" /> },
	{ value: "circle", label: "Circle", icon: <circle cx="12" cy="12" r="9" /> },
	{ value: "square", label: "Square", icon: <rect x="4" y="4" width="16" height="16" rx="1" /> },
	{ value: "rounded", label: "Rounded", icon: <rect x="3" y="6" width="18" height="12" rx="6" /> },
];

export function LayoutPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	return (
		<Pane title="Layout" icon={<LayoutIcon size={14} />}>
			<div className={styles.sectionLabel}>Preset</div>
			<div className={styles.field}>
				<label>Layout</label>
				<select
					value={settings.webcamLayoutPreset}
					disabled={!hasDocument}
					onChange={(e) =>
						void set({ webcamLayoutPreset: e.target.value as typeof settings.webcamLayoutPreset })
					}
				>
					{WEBCAM_PRESETS.map((p) => (
						<option key={p.value} value={p.value}>
							{p.label}
						</option>
					))}
				</select>
			</div>
			<div className={styles.paneRow}>
				<span className="label">Mirror webcam</span>
				<Toggle
					checked={settings.webcamMirrored}
					disabled={!hasDocument}
					onChange={(v) => void set({ webcamMirrored: v })}
				/>
			</div>
			<div className={styles.paneRow}>
				<span className="label">Shrink on zoom</span>
				<Toggle
					checked={settings.webcamReactiveZoom}
					disabled={!hasDocument}
					onChange={(v) => void set({ webcamReactiveZoom: v })}
				/>
			</div>
			<div className={styles.sectionLabel}>Camera shape</div>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(4, 1fr)",
					gap: 8,
					padding: "0 var(--sp-4) 12px",
				}}
			>
				{CAMERA_SHAPES.map((shape) => {
					const isActive = settings.webcamMaskShape === shape.value;
					return (
						<button
							type="button"
							key={shape.value}
							className={`${styles.cursorCell} ${isActive ? styles.isActive : ""}`}
							style={{
								flexDirection: "column",
								gap: 4,
								padding: 8,
								display: "flex",
								alignItems: "center",
							}}
							disabled={!hasDocument}
							onClick={() => void set({ webcamMaskShape: shape.value })}
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								width={22}
								height={22}
							>
								{shape.icon}
							</svg>
							<span style={{ font: "500 11px/1 var(--font-body)" }}>{shape.label}</span>
						</button>
					);
				})}
			</div>
			<div className={styles.sliderGrid}>
				<div className={`${styles.sliderCell} ${styles.full}`}>
					<div className="head">
						<span className="label">Webcam size</span>
						<span className="val">{Math.round(settings.webcamSizePreset)}%</span>
					</div>
					<input
						type="range"
						min={10}
						max={50}
						step={1}
						defaultValue={settings.webcamSizePreset}
						disabled={!hasDocument}
						onChange={(e) => setLive({ webcamSizePreset: Number(e.target.value) })}
						onMouseUp={() => void commit()}
						onTouchEnd={() => void commit()}
						onKeyUp={() => void commit()}
					/>
				</div>
			</div>
		</Pane>
	);
}

// ─── Cursor ───────────────────────────────────────────────────────

const CURSOR_STYLE_LABELS: Array<{ title: string; d: string }> = [
	{
		title: "Arrow",
		d: "M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86 2.94 6.4c.5.1.8-.13.95-.55l1.86-6.4 6.4-1.86c.42-.15.65-.5.55-.95l-6.4-2.94 4.86-4.86c.32-.31.1-.85-.35-.85H5.5z",
	},
	{
		title: "Pointer",
		d: "M14 4.1 12 6 M5.1 8l-2.9-.8 M6 12l-1.9 2 M7.2 2.2 8 5.1 M9 11V6a3 3 0 1 1 6 0v5",
	},
	{
		title: "Hand",
		d: "M18 11V6a2 2 0 0 0-4 0v5 M14 10V4a2 2 0 0 0-4 0v6 M10 10.5V6a2 2 0 0 0-4 0v8",
	},
	{ title: "Text", d: "M14 4.1 12 6 M5.1 8l-2.9-.8 M6 12l-1.9 2 M7.2 2.2 8 5.1" },
	{ title: "Cross", d: "M12 2v20M2 12h20" },
];

export function CursorPane() {
	const { settings, set, setLive, commit, hasDocument } = useEditorSettings();
	return (
		<Pane title="Cursor" icon={<MousePointerClick size={14} />}>
			<div className={styles.paneRow}>
				<span className="label">Show cursor</span>
				<Toggle
					checked={settings.cursorShow}
					disabled={!hasDocument}
					onChange={(v) => void set({ cursor: { show: v } })}
				/>
			</div>
			<div className={styles.paneRow}>
				<span className="label">Clip to canvas</span>
				<Toggle
					checked={settings.cursor.clipToBounds}
					disabled={!hasDocument}
					onChange={(v) => void set({ cursor: { clipToBounds: v } })}
				/>
			</div>
			<div className={styles.sectionLabel}>Cursor style</div>
			<div className={styles.cursorGrid}>
				{CURSOR_THEMES.slice(0, 5).map((theme) => {
					const isActive = settings.cursorTheme === theme.id;
					return (
						<button
							type="button"
							key={theme.id}
							className={`${styles.cursorCell} ${isActive ? styles.isActive : ""}`}
							title={theme.name}
							disabled={!hasDocument}
							onClick={() => void set({ cursor: { theme: theme.id } })}
						>
							<svg viewBox="0 0 24 24" fill="currentColor" width={18} height={18}>
								<path d={CURSOR_STYLE_LABELS[0]?.d ?? ""} />
							</svg>
						</button>
					);
				})}
			</div>
			<div className={styles.sliderGrid}>
				<SliderCell
					label="Size"
					value={settings.cursor.size * 10}
					min={5}
					max={100}
					step={0.1}
					decimals={1}
					disabled={!hasDocument}
					onChange={(v) => setLive({ cursor: { size: v / 10 } })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Smoothing"
					value={settings.cursor.smoothing * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ cursor: { smoothing: v / 100 } })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Motion blur"
					value={settings.cursor.motionBlur * 100}
					min={0}
					max={100}
					suffix="%"
					disabled={!hasDocument}
					onChange={(v) => setLive({ cursor: { motionBlur: v / 100 } })}
					onCommit={() => void commit()}
				/>
				<SliderCell
					label="Click bounce"
					value={settings.cursor.clickBounce * 10}
					min={0}
					max={50}
					step={0.1}
					decimals={1}
					disabled={!hasDocument}
					onChange={(v) => setLive({ cursor: { clickBounce: v / 10 } })}
					onCommit={() => void commit()}
				/>
			</div>
		</Pane>
	);
}

// ─── Timeline (trim waveform) ──────────────────────────────────────

export function TimelinePaneBody() {
	const { settings, set, hasDocument } = useEditorSettings();
	return (
		<Pane title="Timeline" icon={<CropIcon size={14} />}>
			<div className={styles.paneRow}>
				<span className="label">Show audio waveform on trim track</span>
				<Toggle
					checked={settings.showTrimWaveform}
					disabled={!hasDocument}
					onChange={(v) => void set({ showTrimWaveform: v })}
				/>
			</div>
		</Pane>
	);
}

// ─── primitives ───────────────────────────────────────────────────

function Toggle({
	checked,
	disabled,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<button
			type="button"
			className={`${styles.toggle} ${checked ? styles.isOn : ""}`}
			aria-pressed={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		/>
	);
}

function SliderCell({
	label,
	value,
	min,
	max,
	step = 1,
	decimals = 0,
	suffix = "",
	disabled,
	onChange,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	decimals?: number;
	suffix?: string;
	disabled?: boolean;
	onChange: (next: number) => void;
	onCommit: () => void;
}) {
	return (
		<div className={styles.sliderCell}>
			<div className="head">
				<span className="label">{label}</span>
				<span className="val">
					{value.toFixed(decimals)}
					{suffix}
				</span>
			</div>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				defaultValue={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				onMouseUp={onCommit}
				onTouchEnd={onCommit}
				onKeyUp={onCommit}
			/>
		</div>
	);
}

function subTabRow(): React.CSSProperties {
	return { display: "flex", gap: 6, padding: "0 var(--sp-4) 12px" };
}
function subTabStyle(active: boolean): React.CSSProperties {
	return {
		flex: 1,
		padding: "8px 10px",
		border: "1px solid var(--border)",
		borderRadius: 8,
		background: active ? "var(--brand)" : "var(--bg)",
		color: active ? "var(--accent-on)" : "var(--fg-2)",
		font: "500 12px/1 var(--font-body)",
		cursor: "pointer",
	};
}
function colorPreviewStyle(): React.CSSProperties {
	return {
		margin: "0 var(--sp-4) 12px",
		height: 64,
		borderRadius: 10,
		display: "grid",
		placeItems: "center",
		background: "var(--surface-2)",
		color: "var(--fg-2)",
		font: "500 14px var(--font-mono)",
		border: "1px solid var(--border)",
	};
}
function colorWheelStyle(value: string): React.CSSProperties {
	return {
		margin: "0 var(--sp-4) 12px",
		height: 180,
		borderRadius: 12,
		border: "1px solid var(--border)",
		background:
			value.startsWith("linear-") || value.startsWith("radial-")
				? value
				: `linear-gradient(0deg, var(--fg), transparent),
				linear-gradient(90deg, var(--bg), #bcc0c6 50%, var(--fg)),
				linear-gradient(45deg, #bcc0c6, var(--fg))`,
	};
}
function hueTrackStyle(): React.CSSProperties {
	return {
		margin: "0 var(--sp-4) 12px",
		height: 14,
		borderRadius: 7,
		background:
			"linear-gradient(90deg, #16171d, #6b7280, #bcc0c6, #eaebed, #ffffff, #eaebed, #bcc0c6, #6b7280, #16171d)",
	};
}
function hexInputStyle(): React.CSSProperties {
	return {
		margin: "0 var(--sp-4) var(--sp-4)",
		height: 36,
		border: "1px solid var(--border)",
		borderRadius: 8,
		background: "var(--surface)",
		padding: "0 12px",
		display: "flex",
		alignItems: "center",
		font: "500 13px var(--font-mono)",
		color: "var(--fg-2)",
	};
}
