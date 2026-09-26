// The Captions facet of the floating inspector.
//
// Captions have nothing to do with annotations any more: there is no "generate"
// step that stamps text onto the timeline, because the caption layer IS the
// transcript, read through this panel's settings. So every control here changes
// how the transcript is *shown* — never what it says.
//
// The one exception is the translation row, and even that is additive: a
// translation is stored beside the transcript, keyed by segment id, and picking
// "Original" goes straight back to the SSOT text.

import { Captions as CaptionsIcon, Languages, Loader2, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type {
	CaptionAnchorH,
	CaptionAnchorV,
	CaptionPlate,
	CaptionStyleId,
} from "@/lib/ai-edition/captions";
import {
	CAPTION_INSET_X_MAX,
	CAPTION_INSET_Y_MAX,
	CAPTION_PLATE_OPACITY_MAX,
	CAPTION_PLATE_OPACITY_MIN,
	CAPTION_STYLES,
	captionPlateOf,
	captionPlatePatch,
	captionStyleOf,
	DEFAULT_CAPTION_SETTINGS,
	untranslatedUnits,
} from "@/lib/ai-edition/captions";
import {
	CAPTION_WORDS_PER_LINE_MAX,
	CAPTION_WORDS_PER_LINE_MIN,
} from "@/lib/ai-edition/captions/wordsPerLine";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTimelineTranscriptGate,
} from "@/lib/ai-edition/store/transcriptionStore";
import { useCaptions } from "@/lib/ai-edition/store/useCaptions";
import { firstTimelineBusyView } from "@/lib/ai-edition/transcription/status";
import { TEXT_FONT_FAMILIES } from "@/lib/textFonts";
import { nativeBridgeClient } from "@/native";
import styles from "./NewEditorShell.module.css";
import { ChoiceRow, SliderCell, Toggle } from "./RightPanes";
import { TextColorField } from "./TextColorField";
import { useTranscriptionLabel } from "./TranscriptionStatus";
import { transcriptionBusyLabel } from "./transcriptionBusyLabel";

/** Offered as translation targets. Codes double as the storage key. */
const TRANSLATION_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "es", label: "Español" },
	{ code: "de", label: "Deutsch" },
	{ code: "it", label: "Italiano" },
	{ code: "pt", label: "Português" },
	{ code: "nl", label: "Nederlands" },
	{ code: "pl", label: "Polski" },
	{ code: "tr", label: "Türkçe" },
	{ code: "ru", label: "Русский" },
	{ code: "ar", label: "العربية" },
	{ code: "hi", label: "हिन्दी" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "zh", label: "中文" },
];

export function CaptionsPane({ onClose }: { onClose?: () => void } = {}) {
	const t = useScopedT("settings");
	const te = useScopedT("editor");
	const tc = useScopedT("common");
	const {
		settings,
		translations,
		cues,
		hasDocument,
		hasTranscript,
		set,
		setLive,
		commit,
		saveTranslation,
		deleteTranslation,
	} = useCaptions();
	const document = useProjectStore((s) => s.document);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	// Captions are a view of the transcript, and the transcript arrives on its
	// own (transcriptionStore's background pass). The pane reads that state
	// straight from the store rather than being handed a busy flag: it is the
	// same answer everywhere, and this pane only ever reports on the pass —
	// starting one is the transcript tab's job.
	//
	// Resolved over the timeline's assets, not the primary one: `hasTranscript`
	// below is already timeline-scoped (useCaptions), and mixing the two scopes
	// is what let a silent primary asset dead-end this button for a project whose
	// actual footage had speech.
	const gate = useTimelineTranscriptGate();
	const transcriptions = useAssetTranscriptions();
	const transcriptionLabel = useTranscriptionLabel();
	const isTranscribing = gate.state === "pending";
	// Timeline-scoped on purpose: the gate below answers for the timeline's
	// assets, so the label must too — an off-timeline job must not relabel an
	// enabled button.
	const busyLabel = transcriptionBusyLabel(
		firstTimelineBusyView(document, transcriptions) ??
			(isTranscribing ? { assetId: "", status: "running", phase: "loading-model" } : undefined),
		transcriptionLabel,
	);
	const silentMedia = gate.state === "blocked" && gate.reason === "no-audio";
	const engineError = gate.state === "blocked" && gate.reason === "failed" ? gate.message : null;

	const [target, setTarget] = useState<string>(TRANSLATION_LANGUAGES[1].code);
	const [translating, setTranslating] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);

	// Documents made by the old "generate captions" flow carry caption text as
	// real annotations. They'd now render *on top of* the derived layer, so the
	// pane offers to clear them — explicitly, since they are the user's data.
	const legacyCaptionAnnotations = useMemo(
		() => (document?.annotations ?? []).filter((a) => a.annotationSource === "auto-caption"),
		[document],
	);

	const disabled = !hasDocument;
	const plate = captionPlateOf(settings);
	const languageOptions = useMemo(() => Object.values(translations), [translations]);

	const handleTranslate = async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const label = TRANSLATION_LANGUAGES.find((l) => l.code === target)?.label ?? target;
		setTranslating(true);
		setTranslateError(null);
		try {
			// Only the assets actually on the timeline, and only the units that aren't
			// translated yet — a re-run after adding footage costs just the new
			// material instead of the whole video. Units, not segments: a Whisper
			// transcript is one segment per word, and translating single words gives
			// nonsense in any language that reorders or agrees differently.
			const assetIds = new Set(doc.timeline.clips.map((c) => c.assetId));
			let translatedAny = false;
			for (const transcript of doc.transcripts) {
				if (!assetIds.has(transcript.assetId)) continue;
				const pending = untranslatedUnits(transcript, translations, target);
				if (pending.length === 0) {
					translatedAny = true;
					continue;
				}
				const result = await nativeBridgeClient.aiEdition.translateCaptions({
					segments: pending.map((s) => ({ id: s.id, text: s.text })),
					targetLanguage: label,
					sourceLanguage: transcript.language,
				});
				if (Object.keys(result.segments).length > 0) {
					await saveTranslation({
						language: target,
						label,
						assetId: transcript.assetId,
						segments: result.segments,
						model: result.model,
					});
					translatedAny = true;
				}
				if (!result.success) {
					setTranslateError(result.error ?? t("captions.translateFailed"));
					return;
				}
			}
			if (translatedAny) await set({ language: target, enabled: true });
			else setTranslateError(t("captions.noTranscript"));
		} catch (error) {
			setTranslateError(error instanceof Error ? error.message : String(error));
		} finally {
			setTranslating(false);
		}
	};

	const clearLegacyCaptionAnnotations = async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		await saveDocument(
			{
				...doc,
				annotations: doc.annotations.filter((a) => a.annotationSource !== "auto-caption"),
			},
			{ history: true },
		);
	};

	return (
		<div
			className={`${styles.pane} ${styles.isActive}`}
			style={{ minHeight: 0, display: "flex", flexDirection: "column" }}
		>
			<header
				className={styles.paneHead}
				style={{
					position: "relative",
					paddingRight: "var(--sp-4)",
					flexShrink: 0,
				}}
			>
				<span style={{ display: "inline-flex", alignItems: "center", color: "var(--muted)" }}>
					<CaptionsIcon size={14} />
				</span>
				<h2>{t("facets.captions")}</h2>
				{onClose ? (
					<button
						type="button"
						className={styles.iconBtn}
						style={{ marginLeft: "auto" }}
						title={tc("actions.close")}
						aria-label={tc("actions.close")}
						onClick={onClose}
					>
						<X size={14} />
					</button>
				) : null}
			</header>
			<div
				className={styles.paneBody}
				style={{
					padding: "8px 0 16px",
					minHeight: 0,
					flex: "1 1 auto",
					overflowY: "auto",
					overflowX: "hidden",
					scrollbarWidth: "thin",
					scrollbarColor: "var(--border) transparent",
				}}
			>
				<div className={styles.paneRow}>
					<span className={styles.label}>{t("captions.show")}</span>
					<Toggle
						checked={settings.enabled}
						disabled={disabled || !hasTranscript}
						onChange={(next) => void set({ enabled: next })}
					/>
				</div>

				{!hasTranscript ? (
					<div
						style={{
							margin: "0 var(--sp-4) 12px",
							padding: "14px",
							border: "1px dashed var(--border-hi)",
							borderRadius: 10,
							background: "var(--surface-2)",
							display: "flex",
							flexDirection: "column",
							gap: 10,
						}}
					>
						<p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--muted)" }}>
							{silentMedia ? te("mediaStage.noAudioTrackHint") : t("captions.noTranscript")}
						</p>
						{engineError ? (
							<p
								style={{
									margin: 0,
									font: "400 11.5px/1.5 var(--font-body)",
									color: "var(--danger)",
								}}
							>
								{engineError}
							</p>
						) : null}
						{/* No transcribe button here. This pane is reached from the transcript
						    tab, whose empty state carries the one gate — and two buttons for
						    one background pass is what made people believe captions were
						    transcribed separately from the transcript (issue #560). What is
						    worth saying here is whether a run is already going. */}
						{isTranscribing ? (
							<p
								style={{
									margin: 0,
									display: "inline-flex",
									alignItems: "center",
									gap: 6,
									font: "400 12px/1.5 var(--font-body)",
									color: "var(--muted)",
								}}
							>
								<Loader2 size={14} className="animate-spin" />
								{busyLabel ?? t("transcript.transcribing")}
							</p>
						) : null}
					</div>
				) : (
					<p
						style={{
							margin: "0 var(--sp-4) 12px",
							font: "400 11.5px/1.5 var(--font-body)",
							color: "var(--muted)",
						}}
					>
						{/* The cue count is only meaningful while the layer is on — deriving
						    cues short-circuits when it's off, so a "0 lines" reading there
						    would say the transcript is empty when it isn't. While a
						    regeneration is in flight the phase label matters more than the
						    count of cues about to be replaced. */}
						{busyLabel ??
							(settings.enabled
								? t("captions.derivedFromTranscript", { count: cues.length })
								: t("captions.hiddenHint"))}
					</p>
				)}

				{legacyCaptionAnnotations.length > 0 ? (
					<div
						style={{
							margin: "0 var(--sp-4) 12px",
							padding: "12px 14px",
							border: "1px solid var(--border)",
							borderRadius: 10,
							background: "var(--surface-2)",
							display: "flex",
							flexDirection: "column",
							gap: 8,
						}}
					>
						<p style={{ margin: 0, font: "400 11.5px/1.5 var(--font-body)", color: "var(--fg-2)" }}>
							{t("captions.legacyAnnotations", { count: legacyCaptionAnnotations.length })}
						</p>
						<button
							type="button"
							className={`${styles.btn} ${styles.btnSecondary}`}
							onClick={() => void clearLegacyCaptionAnnotations()}
						>
							<Trash2 size={13} />
							{t("captions.removeLegacyAnnotations")}
						</button>
					</div>
				) : null}

				{/* ── Style ──────────────────────────────────────────────── */}
				{/* Named looks first: each sets font, size, colour and plate together, and is a
				    readable pair by construction. Tuning anything below leaves none selected. */}
				<div className={styles.sectionLabel}>{t("captions.style")}</div>
				<div style={{ margin: "0 var(--sp-4) 12px" }}>
					<ChoiceRow<CaptionStyleId | "custom">
						label={t("captions.style")}
						disabled={disabled}
						columns={2}
						options={CAPTION_STYLE_IDS.map((id) => ({
							value: id,
							label: t(`captions.styles.${id}`),
						}))}
						value={captionStyleOf(settings) ?? "custom"}
						onChange={(id) => {
							if (id !== "custom") void set(CAPTION_STYLES[id]);
						}}
					/>
				</div>

				{/* ── Language ───────────────────────────────────────────── */}
				<div className={styles.sectionLabel}>{t("captions.language")}</div>
				{/* Only once there is a translation to switch to: alone, "Original" would be a
				    button that changes nothing. */}
				{languageOptions.length > 0 ? (
					<div className={`${styles.field} ${styles.fieldStack}`}>
						<span className={styles.fieldLabel}>{t("captions.displayLanguage")}</span>
						<ChoiceRow<string>
							label={t("captions.displayLanguage")}
							columns={2}
							options={[
								{ value: "", label: t("captions.original") },
								...languageOptions.map((entry) => ({ value: entry.language, label: entry.label })),
							]}
							value={settings.language ?? ""}
							disabled={disabled}
							onChange={(language) => void set({ language: language || null })}
						/>
					</div>
				) : null}

				<div
					style={{
						margin: "0 var(--sp-4) 12px",
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<select
						value={target}
						disabled={disabled || translating}
						onChange={(e) => setTarget(e.target.value)}
						style={{ ...selectStyle, flex: 1, minWidth: 0 }}
					>
						{TRANSLATION_LANGUAGES.map((language) => (
							<option key={language.code} value={language.code}>
								{language.label}
							</option>
						))}
					</select>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						style={{ flexShrink: 0 }}
						disabled={disabled || translating || !hasTranscript}
						onClick={() => void handleTranslate()}
						title={t("captions.translateHint")}
					>
						{translating ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
						{translating ? t("captions.translating") : t("captions.translate")}
					</button>
				</div>
				{settings.language ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						style={{ margin: "0 var(--sp-4) 12px" }}
						disabled={disabled}
						onClick={() => void deleteTranslation(settings.language as string)}
					>
						<Trash2 size={13} />
						{t("captions.deleteTranslation")}
					</button>
				) : null}
				{translateError ? (
					<p
						style={{
							margin: "0 var(--sp-4) 12px",
							font: "400 11.5px/1.5 var(--font-body)",
							color: "var(--danger)",
						}}
					>
						{translateError}
					</p>
				) : null}
				<p
					style={{
						margin: "0 var(--sp-4) 14px",
						font: "400 11px/1.5 var(--font-body)",
						color: "var(--muted)",
					}}
				>
					{t("captions.translationIsNonDestructive")}
				</p>

				{/* ── Customise ─────────────────────────────────────────── */}
				{/* The detailed look controls, folded behind the named styles above: still one
				    click away, never the first thing to read. */}
				<details>
					<summary className={styles.sectionLabel} style={{ cursor: "pointer" }}>
						{t("captions.customize")}
					</summary>
					<div className={styles.sectionLabel}>{t("captions.text")}</div>
					<div className={`${styles.field} ${styles.fieldStack}`}>
						<span className={styles.fieldLabel}>{t("captions.font")}</span>
						{/* Only the families the compositor ships: it never reads the machine's
						    installed fonts, so any other name would draw a fallback. Each button is a
						    specimen, in the face it picks. */}
						<ChoiceRow<string>
							label={t("captions.font")}
							columns={2}
							options={TEXT_FONT_FAMILIES.map((font) => ({
								value: font,
								label: font,
								icon: <span style={{ fontFamily: font }}>{font}</span>,
							}))}
							value={settings.fontFamily}
							disabled={disabled}
							onChange={(fontFamily) => void set({ fontFamily })}
						/>
					</div>
					<div className={styles.paneRow}>
						<span className={styles.label}>{t("captions.bold")}</span>
						<Toggle
							checked={settings.fontWeight === "bold"}
							disabled={disabled}
							onChange={(next) => void set({ fontWeight: next ? "bold" : "normal" })}
						/>
					</div>
					<div className={styles.sliderGrid}>
						<SliderCell
							label={t("captions.fontSize")}
							value={settings.fontSize}
							min={16}
							max={140}
							defaultValue={DEFAULT_CAPTION_SETTINGS.fontSize}
							suffix="px"
							disabled={disabled}
							onChange={(v) => setLive({ fontSize: v })}
							onCommit={() => void commit()}
						/>
					</div>
					<div className={styles.paneRow}>
						<span className={styles.label}>{t("captions.textColor")}</span>
						<TextColorField
							label={t("captions.textColor")}
							value={settings.color}
							plate={settings.backgroundEnabled ? settings.backgroundColor : "transparent"}
							disabled={disabled}
							onChange={(color) => setLive({ color })}
							onCommit={() => void commit()}
						/>
					</div>

					{/* ── Background ─────────────────────────────────────────── */}
					{/* Named plates, like the annotation pane's: the plate choice alone turns it on
				    or off, and choosing one moves text that would vanish on it. An older free
				    colour stays shown while the project carries it. */}
					<div className={styles.sectionLabel}>{t("captions.background")}</div>
					<div style={{ margin: "0 var(--sp-4) 10px" }}>
						<ChoiceRow<CaptionPlate | "custom">
							label={t("captions.background")}
							disabled={disabled}
							options={[
								{ value: "none", label: t("textPlate.none") },
								{ value: "dark", label: t("textPlate.dark") },
								{ value: "light", label: t("textPlate.light") },
								...(plate === "custom"
									? [{ value: "custom" as const, label: t("textPlate.custom") }]
									: []),
							]}
							value={plate}
							onChange={(next) => {
								if (next !== "custom") void set(captionPlatePatch(settings, next));
							}}
						/>
					</div>
					{settings.backgroundEnabled ? (
						<div className={styles.sliderGrid}>
							<SliderCell
								label={t("captions.backgroundOpacity")}
								value={Math.round(settings.backgroundOpacity * 100)}
								min={CAPTION_PLATE_OPACITY_MIN * 100}
								max={CAPTION_PLATE_OPACITY_MAX * 100}
								defaultValue={Math.round(DEFAULT_CAPTION_SETTINGS.backgroundOpacity * 100)}
								suffix="%"
								disabled={disabled}
								onChange={(v) => setLive({ backgroundOpacity: v / 100 })}
								onCommit={() => void commit()}
							/>
						</div>
					) : null}
				</details>

				{/* ── Placement ──────────────────────────────────────────── */}
				{/* One control per axis, each naming the edge it measures from. The old pane
				    had four that overlapped: a band width nothing drew, an offset measured
				    against that invisible band, and a text alignment fighting the offset for
				    the same visual outcome. */}
				<div className={styles.sectionLabel}>{t("captions.position")}</div>
				<Segmented<CaptionAnchorV>
					value={settings.anchorV}
					disabled={disabled}
					options={[
						{ value: "bottom", label: t("captions.anchorBottom") },
						{ value: "top", label: t("captions.anchorTop") },
					]}
					// No offset to reset: the inset means the same thing on both anchors, so
					// flipping mirrors the caption to the same distance from the opposite edge.
					onChange={(anchorV) => void set({ anchorV })}
				/>
				<p
					style={{
						margin: "6px var(--sp-4) 10px",
						font: "400 11px/1.5 var(--font-body)",
						color: "var(--muted)",
					}}
				>
					{settings.anchorV === "bottom"
						? t("captions.anchorHintBottom")
						: t("captions.anchorHintTop")}
				</p>
				<div className={styles.sliderGrid}>
					<SliderCell
						label={
							settings.anchorV === "bottom"
								? t("captions.distanceFromBottom")
								: t("captions.distanceFromTop")
						}
						value={settings.insetY}
						min={0}
						max={CAPTION_INSET_Y_MAX}
						defaultValue={DEFAULT_CAPTION_SETTINGS.insetY}
						step={0.5}
						decimals={1}
						suffix="%"
						disabled={disabled}
						onChange={(v) => setLive({ insetY: v })}
						onCommit={() => void commit()}
					/>
				</div>

				<Segmented<CaptionAnchorH>
					value={settings.anchorH}
					disabled={disabled}
					options={[
						{ value: "left", label: t("captions.alignLeft") },
						{ value: "center", label: t("captions.alignCenter") },
						{ value: "right", label: t("captions.alignRight") },
					]}
					onChange={(anchorH) => void set({ anchorH })}
				/>
				{/* Centre has no edge to measure from, so the control is ABSENT rather than
				    disabled — a dead slider reads as a bug. */}
				{settings.anchorH === "center" ? null : (
					<div className={styles.sliderGrid}>
						<SliderCell
							label={
								settings.anchorH === "left"
									? t("captions.distanceFromLeft")
									: t("captions.distanceFromRight")
							}
							value={settings.insetX}
							min={0}
							max={CAPTION_INSET_X_MAX}
							defaultValue={DEFAULT_CAPTION_SETTINGS.insetX}
							step={0.5}
							decimals={1}
							suffix="%"
							disabled={disabled}
							onChange={(v) => setLive({ insetX: v })}
							onCommit={() => void commit()}
						/>
					</div>
				)}

				{/* ── Line length ────────────────────────────────────────── */}
				{/* Two counts on one scale, so two sliders; each stops at the other, so the
				    minimum never passes the maximum. */}
				<div className={styles.sectionLabel}>{t("captions.lineLength")}</div>
				<div className={styles.sliderGrid}>
					<SliderCell
						label={t("captions.minWords")}
						value={settings.minWordsPerLine}
						min={CAPTION_WORDS_PER_LINE_MIN}
						max={CAPTION_WORDS_PER_LINE_MAX}
						defaultValue={DEFAULT_CAPTION_SETTINGS.minWordsPerLine}
						showValue
						disabled={disabled}
						onChange={(v) => setLive({ minWordsPerLine: Math.min(v, settings.maxWordsPerLine) })}
						onCommit={() => void commit()}
					/>
					<SliderCell
						label={t("captions.maxWords")}
						value={settings.maxWordsPerLine}
						min={CAPTION_WORDS_PER_LINE_MIN}
						max={CAPTION_WORDS_PER_LINE_MAX}
						defaultValue={DEFAULT_CAPTION_SETTINGS.maxWordsPerLine}
						showValue
						disabled={disabled}
						onChange={(v) => setLive({ maxWordsPerLine: Math.max(v, settings.minWordsPerLine) })}
						onCommit={() => void commit()}
					/>
				</div>
			</div>
		</div>
	);
}

const CAPTION_STYLE_IDS = Object.keys(CAPTION_STYLES) as CaptionStyleId[];

const selectStyle: React.CSSProperties = {
	height: 32,
	padding: "0 10px",
	borderRadius: 8,
	border: "1px solid var(--border)",
	background: "var(--surface-2)",
	color: "var(--fg)",
	font: "500 12.5px var(--font-body)",
	minWidth: 120,
	cursor: "pointer",
};

/**
 * One "label + swatch" row that opens the app's standard `ColorPicker` (wheel /
 * palette / hex) in a popover.
 *
 * The pane used to carry its own hard-coded caption swatches. That was a third
 * private palette in the app, and it meant the caption colours behaved unlike
 * every other colour surface — so it's gone: this defers to the shared
 * `COLOR_PALETTE` and the shared picker instead.
 */
function Segmented<T extends string>({
	value,
	options,
	disabled,
	onChange,
}: {
	value: T;
	options: ReadonlyArray<{ value: T; label: string }>;
	disabled?: boolean;
	onChange: (next: T) => void;
}) {
	return (
		<div className={styles.paneTabs}>
			{options.map((option) => (
				<button
					type="button"
					key={option.value}
					className={value === option.value ? styles.isActive : ""}
					aria-pressed={value === option.value}
					disabled={disabled}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
