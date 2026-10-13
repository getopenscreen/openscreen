import {
	ArrowDown,
	Download,
	FileUp,
	Film,
	FolderOpen,
	Music2,
	Plus,
	RotateCw,
	Search,
	Settings2,
	X,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import {
	serializeCaptionCuesSrt,
	serializeTranscriptSrt,
} from "@/lib/ai-edition/document/srtExport";
import { deriveTimelineSrtCues } from "@/lib/ai-edition/document/timelineSrt";
import type {
	AxcutAsset,
	AxcutDocument,
	AxcutTranscript,
	TranscriptLanguageCode,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import {
	languageLabel,
	sortedLanguageOptions,
} from "@/lib/ai-edition/transcription/languageLabels";
import {
	type AssetTranscriptionStatus,
	type AssetTranscriptionView,
	findAssetTranscript,
	isSilentFailure,
	transcriptHasSpeech,
	transcriptionFailureHintKey,
} from "@/lib/ai-edition/transcription/status";
import { formatBytes } from "@/utils/formatBytes";
import { ModalShell } from "../Modals";
import { TranscriptionSettings } from "../TranscriptionSettings";
import {
	TranscriptionProgressBar,
	TranscriptionStatusDot,
	useTranscriptionLabel,
} from "../TranscriptionStatus";
import styles from "./EditorShellV4.module.css";

const ASSET_MIME = "application/x-axcut-asset";
const MAX_SRT_BYTES = 5 * 1024 * 1024;
const THUMB_GRADIENTS = [
	"linear-gradient(135deg, #fb7185, #f97316)",
	"linear-gradient(135deg, #10b981, #0d986a)",
	"linear-gradient(135deg, #fbbf24, #f59e0b)",
	"linear-gradient(135deg, #38bdf8, #6366f1)",
];

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export function detectedLanguageForTranscript(transcript: AxcutTranscript | null): string | null {
	if (!transcript || transcript.language === "auto" || !transcriptHasSpeech(transcript)) {
		return null;
	}
	return transcript.language;
}

/**
 * Whisper reads at most the last 223 tokens of its prompt; 600 characters of
 * names and terms stays under that for Latin scripts (issue #1023).
 */
export const VOCABULARY_MAX_CHARS = 600;

/** The document with its names and terms set, or null when nothing changed. */
export function withVocabulary(document: AxcutDocument, text: string): AxcutDocument | null {
	const vocabulary = text.trim().slice(0, VOCABULARY_MAX_CHARS) || undefined;
	if (vocabulary === document.project.vocabulary) return null;
	return { ...document, project: { ...document.project, vocabulary } };
}

export async function addSelectedAssetToTimeline(
	selected: Pick<AxcutAsset, "id" | "label" | "originalPath"> | null,
	onAddToTimeline: (assetId: string) => Promise<void>,
	onSuccess: (label: string) => void,
): Promise<void> {
	if (!selected) return;
	await onAddToTimeline(selected.id);
	onSuccess(selected.label || basename(selected.originalPath));
}

export function MediaStage({
	onAddToTimeline,
	onAddAudioToTimeline,
	onShowTimeline,
	onAudioTrackImported,
}: {
	onAddToTimeline: (assetId: string) => Promise<void>;
	onAddAudioToTimeline?: (assetId: string) => Promise<void>;
	onShowTimeline?: () => void;
	onAudioTrackImported?: () => void;
}) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const addAsset = useProjectStore((s) => s.addAsset);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const vocabularySave = useRef<Promise<boolean>>(undefined);
	const importAudioAsset = useProjectStore((s) => s.importAudioAsset);
	const addAudioAsset = useProjectStore((s) => s.addAudioAsset);
	// Transcripts are produced in the background as soon as a media lands here
	// (see transcriptionStore) — this stage only reports where each one is at,
	// and lets the user force a re-run in another language.
	const transcriptions = useAssetTranscriptions();
	const requestTranscription = useTranscriptionStore((s) => s.request);
	const transcriptionLabel = useTranscriptionLabel();
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [lang, setLang] = useState<TranscriptLanguageCode>("auto");
	const [srtBusy, setSrtBusy] = useState(false);
	const [transcriptionSettingsOpen, setTranscriptionSettingsOpen] = useState(false);
	const [srtScope, setSrtScope] = useState<"source" | "timeline">("source");
	const [audioFormat, setAudioFormat] = useState<"original" | "wav" | "m4a">("original");
	const [exporting, setExporting] = useState<"audio" | "srt" | null>(null);
	const exportingRef = useRef(false);
	const importBusy = useRef(false);
	const srtInput = useRef<HTMLInputElement | null>(null);
	const mounted = useRef(true);
	const selectionScope = useRef({ projectId, selectedId, detailOpen, revision: 0 });
	if (
		selectionScope.current.projectId !== projectId ||
		selectionScope.current.selectedId !== selectedId ||
		selectionScope.current.detailOpen !== detailOpen
	) {
		selectionScope.current = {
			projectId,
			selectedId,
			detailOpen,
			revision: selectionScope.current.revision + 1,
		};
	}
	const pendingSrtTarget = useRef<{
		projectId: string;
		assetId: string;
		revision: number;
		transcript: AxcutTranscript | null;
	} | null>(null);
	const importingSrt = useRef(false);
	useEffect(() => {
		mounted.current = true;
		const input = srtInput.current;
		const cancel = () => {
			pendingSrtTarget.current = null;
			setSrtBusy(false);
		};
		input?.addEventListener("cancel", cancel);
		return () => {
			mounted.current = false;
			pendingSrtTarget.current = null;
			input?.removeEventListener("cancel", cancel);
		};
	}, []);
	const regenLanguageOptions = useMemo(
		() => sortedLanguageOptions(locale, t("mediaStage.auto")),
		[locale, t],
	);

	// Audio sources also need a transcript and file actions, but remain audio
	// overlays: never advertise the video-only drag payload for an audio card.
	const assets = document?.assets ?? [];
	const filtered = useMemo(
		() =>
			assets.filter((a) => {
				if (!query) return true;
				return `${a.label} ${a.originalPath}`.toLowerCase().includes(query.toLowerCase());
			}),
		[assets, query],
	);
	const selected = assets.find((a) => a.id === selectedId) ?? null;
	const selectedIsAudio = selected?.kind === "audio";
	const hasTimelineClips = (document?.timeline.clips.length ?? 0) > 0;
	const transcript = selected ? findAssetTranscript(document, selected.id) : null;
	const timelineSrtCues = useMemo(() => deriveTimelineSrtCues(document), [document]);
	const detectedLanguage = detectedLanguageForTranscript(transcript);
	const selectedTranscription: AssetTranscriptionView = selected
		? (transcriptions[selected.id] ?? { assetId: selected.id, status: "idle" })
		: { assetId: "", status: "idle" };
	const selectedBusy =
		selectedTranscription.status === "running" || selectedTranscription.status === "queued";
	const regenerateBusy = selectedBusy || srtBusy;
	const failureHintKey = selectedTranscription.failure
		? transcriptionFailureHintKey(selectedTranscription.failure)
		: null;

	const handleImport = async () => {
		if (!projectId) {
			toast.error(t("mediaStage.openProjectFirst"));
			return;
		}
		const picker = await window.electronAPI?.openVideoFilePicker();
		if (!picker?.success || !picker.path) return;
		setBusy(true);
		try {
			const label = picker.name || basename(picker.path);
			await addAsset(picker.path, label);
			toast.success(t("mediaStage.added", { label }));
		} catch (err) {
			toast.error(t("mediaStage.couldNotAddAsset"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const handleAudioImport = async () => {
		if (!projectId || importBusy.current) return;
		const targetProjectId = projectId;
		importBusy.current = true;
		setBusy(true);
		try {
			const picker = await window.electronAPI?.openAudioFilePicker();
			if (!picker?.success || !picker.path) return;
			const current = useProjectStore.getState();
			if (!mounted.current || current.projectId !== targetProjectId) return;
			const label = picker.name || basename(picker.path);
			const placeOnTimeline = (current.document?.timeline.clips.length ?? 0) > 0;
			const asset = await (placeOnTimeline ? importAudioAsset : addAudioAsset)(picker.path, label);
			if (!asset || !mounted.current || useProjectStore.getState().projectId !== targetProjectId)
				return;
			setSelectedId(asset.id);
			setDetailOpen(true);
			if (placeOnTimeline) onAudioTrackImported?.();
			toast.success(
				t(placeOnTimeline ? "mediaStage.audioImportedToTimeline" : "mediaStage.audioImported"),
				{
					description: label,
					...(placeOnTimeline && onShowTimeline
						? { action: { label: t("mediaStage.showTimeline"), onClick: onShowTimeline } }
						: {}),
				},
			);
		} catch (err) {
			toast.error(t("mediaStage.audioImportFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			importBusy.current = false;
			if (mounted.current) setBusy(false);
		}
	};

	const openDetail = (asset: AxcutAsset) => {
		setSelectedId(asset.id);
		setDetailOpen(true);
	};

	const addSelectedToTimeline = () => {
		const add = selectedIsAudio ? onAddAudioToTimeline : onAddToTimeline;
		if (!add) return;
		void addSelectedAssetToTimeline(selected, add, (label) => {
			toast.success(t("mediaStage.addedToTimeline", { label }));
		}).catch((err: unknown) =>
			toast.error(
				t(selectedIsAudio ? "mediaStage.audioImportFailed" : "mediaStage.couldNotAddAsset"),
				{
					description: err instanceof Error ? err.message : String(err),
				},
			),
		);
	};

	const exportSource = async (kind: "audio" | "srt") => {
		if (!selected || exportingRef.current) return;
		exportingRef.current = true;
		setExporting(kind);
		try {
			const result =
				kind === "audio"
					? await window.electronAPI.exportSourceAudio({
							sourcePath: selected.originalPath,
							format: audioFormat,
						})
					: await window.electronAPI.exportSrtFile({
							sourcePath: selected.originalPath,
							srtText:
								srtScope === "timeline"
									? serializeCaptionCuesSrt(timelineSrtCues)
									: serializeTranscriptSrt(transcript!),
							scope: srtScope,
						});
			if (result.canceled) return;
			if (!result.success || !result.path)
				throw new Error(result.error || t("mediaStage.exportFailed"));
			const path = result.path;
			toast.success(t(kind === "audio" ? "mediaStage.audioExported" : "mediaStage.srtExported"), {
				description: path,
				action: {
					label: t("mediaStage.showInFolder"),
					onClick: () => {
						void window.electronAPI.revealInFolder(path);
					},
				},
			});
		} catch (err) {
			toast.error(t("mediaStage.exportFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			exportingRef.current = false;
			if (mounted.current) setExporting(null);
		}
	};

	const revealOriginal = async () => {
		if (!selected?.originalPath) return;
		try {
			const result = await window.electronAPI?.revealInFolder(selected.originalPath);
			if (!result?.success) throw new Error(result?.error || t("mediaStage.revealFailed"));
		} catch (err) {
			toast.error(t("mediaStage.revealFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const chooseSrt = () => {
		if (!projectId || !selected || pendingSrtTarget.current || importingSrt.current) return;
		const target = {
			projectId,
			assetId: selected.id,
			revision: selectionScope.current.revision,
			transcript,
		};
		if (transcriptHasSpeech(transcript) && !window.confirm(t("mediaStage.srtReplaceConfirm"))) {
			return;
		}
		pendingSrtTarget.current = target;
		setSrtBusy(true);
		srtInput.current?.click();
	};

	const handleSrtSelected = async (event: ChangeEvent<HTMLInputElement>) => {
		if (importingSrt.current) return;
		const file = event.target.files?.[0];
		event.target.value = "";
		const target = pendingSrtTarget.current;
		pendingSrtTarget.current = null;
		if (!file || !target) {
			setSrtBusy(false);
			return;
		}
		importingSrt.current = true;
		try {
			if (!file.name.toLowerCase().endsWith(".srt")) {
				throw new Error(t("mediaStage.srtInvalidFile"));
			}
			if (file.size > MAX_SRT_BYTES) throw new Error(t("mediaStage.srtTooLarge"));
			const text = await file.text();
			const current = useProjectStore.getState();
			// A file dialog can remain open across selection or project changes. Never
			// send its late result to whichever media happens to be selected now.
			if (
				!mounted.current ||
				selectionScope.current.revision !== target.revision ||
				current.projectId !== target.projectId ||
				current.document?.project.id !== target.projectId ||
				!current.document.assets.some((asset) => asset.id === target.assetId)
			) {
				if (mounted.current) toast.info(t("mediaStage.srtSelectionChanged"));
				return;
			}
			const latestTranscript = findAssetTranscript(current.document, target.assetId);
			if (
				latestTranscript !== target.transcript &&
				transcriptHasSpeech(latestTranscript) &&
				!window.confirm(t("mediaStage.srtReplaceConfirm"))
			) {
				return;
			}
			await useTranscriptionStore.getState().importSrt(target.assetId, text);
			if (mounted.current) toast.success(t("mediaStage.importSrtSuccess"));
		} catch (err) {
			if (mounted.current) {
				toast.error(t("mediaStage.importSrtFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		} finally {
			importingSrt.current = false;
			if (mounted.current) setSrtBusy(false);
		}
	};

	return (
		<div className={styles.mediaStage}>
			<ModalShell
				open={transcriptionSettingsOpen}
				onClose={() => setTranscriptionSettingsOpen(false)}
				title={t("mediaStage.transcriptionMethods")}
			>
				<TranscriptionSettings open={transcriptionSettingsOpen} />
			</ModalShell>
			<input
				ref={srtInput}
				type="file"
				accept=".srt"
				aria-label={t("mediaStage.srtFileLabel")}
				style={{ display: "none" }}
				onChange={(event) => void handleSrtSelected(event)}
			/>
			<div className={styles.mediaInner} style={{ maxWidth: detailOpen ? 1120 : 900 }}>
				<div className={styles.mediaSearchRow}>
					<Search size={16} style={{ color: "var(--muted)", flexShrink: 0 }} />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("mediaStage.searchPlaceholder")}
					/>
				</div>
				<div className={styles.mediaCols}>
					<div className={styles.mediaListCol}>
						<div
							className={styles.mediaGrid}
							style={{ gridTemplateColumns: detailOpen ? "repeat(2,1fr)" : "repeat(3,1fr)" }}
						>
							{filtered.map((asset, i) => {
								const transcription = transcriptions[asset.id] ?? {
									assetId: asset.id,
									status: "idle" as AssetTranscriptionStatus,
								};
								return (
									<button
										type="button"
										key={asset.id}
										draggable={asset.kind !== "audio"}
										className={`${styles.mediaCard}${
											asset.id === selectedId ? ` ${styles.selected}` : ""
										}`}
										title={asset.originalPath}
										onDragStart={(e) => {
											if (asset.kind === "audio") {
												e.preventDefault();
												return;
											}
											e.dataTransfer.setData(ASSET_MIME, asset.id);
											e.dataTransfer.effectAllowed = "copy";
										}}
										onClick={() => openDetail(asset)}
									>
										<div
											className={styles.mediaThumb}
											style={{ background: THUMB_GRADIENTS[i % THUMB_GRADIENTS.length] }}
										>
											{asset.kind === "audio" ? (
												<Music2 size={30} strokeWidth={1.8} />
											) : (
												<Film size={30} strokeWidth={1.8} />
											)}
										</div>
										<div className={styles.mediaCardMeta}>
											{asset.id === selectedId ? (
												<span
													aria-hidden
													style={{
														width: 6,
														height: 6,
														borderRadius: "50%",
														background: "var(--accent)",
														flexShrink: 0,
													}}
												/>
											) : null}
											<div className={styles.body}>
												<div className={styles.mediaCardName}>
													{asset.label || basename(asset.originalPath)}
												</div>
												<div className={styles.mediaCardStats}>
													<span className={styles.dur}>
														{formatSeconds(asset.durationSec ?? 0)}
													</span>
													<span className={styles.size}>{formatBytes(asset.sizeBytes)}</span>
												</div>
											</div>
											<TranscriptionStatusDot view={transcription} />
										</div>
									</button>
								);
							})}
						</div>
						{assets.length > 0 ? (
							<div className={styles.mediaHint}>
								<ArrowDown size={12} />
								{t("mediaStage.dragHint")}
							</div>
						) : (
							<div className={styles.mediaHint}>{t("mediaStage.emptyHint")}</div>
						)}
						<button
							type="button"
							className={styles.importBtn}
							onClick={handleImport}
							disabled={!projectId || busy}
						>
							<Plus size={14} />
							{t("mediaStage.importMedia")}
						</button>
						<button
							type="button"
							className={styles.importBtn}
							onClick={() => void handleAudioImport()}
							disabled={!projectId || busy}
						>
							<Music2 size={14} />
							{t("mediaStage.importAudio")}
						</button>
						<p className={styles.mediaActionHint}>{t("mediaStage.audioImportHint")}</p>
					</div>

					{detailOpen && selected ? (
						<div className={styles.mediaDetail}>
							<div
								style={{
									display: "flex",
									alignItems: "flex-start",
									justifyContent: "space-between",
									gap: 10,
									marginBottom: 4,
								}}
							>
								<h2
									style={{
										margin: 0,
										fontSize: 16.5,
										fontWeight: 700,
										color: "var(--fg-emphasis)",
										letterSpacing: "-0.01em",
									}}
								>
									{t("mediaStage.sourceTranscript")}
								</h2>
								<button
									type="button"
									title={t("mediaStage.close")}
									aria-label={t("mediaStage.close")}
									onClick={() => setDetailOpen(false)}
									style={{
										width: 26,
										height: 26,
										display: "grid",
										placeItems: "center",
										borderRadius: 8,
										color: "var(--muted)",
										background: "transparent",
										border: 0,
										cursor: "pointer",
										flexShrink: 0,
									}}
								>
									<X size={15} />
								</button>
							</div>
							<div
								style={{
									fontSize: 12,
									color: "var(--muted)",
									marginBottom: 10,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{selected.label || basename(selected.originalPath)}
							</div>
							<label className={styles.mediaActionLabel} htmlFor="srt-export-scope">
								{t("mediaStage.srtScope")}
							</label>
							<select
								id="srt-export-scope"
								className={styles.mediaActionSelect}
								style={{ flex: "none", minHeight: 36, marginBottom: 8 }}
								value={srtScope}
								onChange={(event) => setSrtScope(event.target.value as "source" | "timeline")}
								disabled={!!exporting}
							>
								<option value="source">{t("mediaStage.srtSource")}</option>
								<option value="timeline">{t("mediaStage.srtTimeline")}</option>
							</select>
							<div className={styles.mediaActionsRow}>
								<button
									type="button"
									className={styles.importBtn}
									disabled={!selected.originalPath}
									onClick={() => void revealOriginal()}
									style={{ flex: 1, marginTop: 0, padding: 10, borderStyle: "solid" }}
								>
									<FolderOpen size={14} />
									{t("mediaStage.revealOriginal")}
								</button>
							</div>
							<div className={styles.mediaActionsRow}>
								<button
									type="button"
									className={styles.importBtn}
									disabled={!projectId || srtBusy}
									onClick={chooseSrt}
									style={{
										flex: 1,
										marginTop: 0,
										padding: 10,
										borderStyle: "solid",
										opacity: srtBusy ? 0.6 : 1,
										cursor: srtBusy ? "not-allowed" : "pointer",
									}}
								>
									<FileUp size={14} />
									{t(srtBusy ? "mediaStage.importingSrt" : "mediaStage.importSrt")}
								</button>
								<button
									type="button"
									className={styles.importBtn}
									disabled={
										(srtScope === "source"
											? !transcriptHasSpeech(transcript)
											: timelineSrtCues.length === 0) ||
										!!exporting ||
										srtBusy
									}
									onClick={() => void exportSource("srt")}
								>
									<Download size={14} />
									{t(exporting === "srt" ? "mediaStage.exporting" : "mediaStage.exportSrt")}
								</button>
							</div>
							<p className={styles.mediaActionHint}>
								{t(
									srtScope === "source" ? "mediaStage.sourceSrtHint" : "mediaStage.timelineSrtHint",
								)}
							</p>
							<label className={styles.mediaActionLabel} htmlFor="source-audio-format">
								{t("mediaStage.audioFormat")}
							</label>
							<div className={styles.mediaActionsRow}>
								<select
									id="source-audio-format"
									className={styles.mediaActionSelect}
									value={audioFormat}
									disabled={!!exporting}
									onChange={(event) =>
										setAudioFormat(event.target.value as "original" | "wav" | "m4a")
									}
								>
									<option value="original">{t("mediaStage.audioOriginal")}</option>
									<option value="wav">{t("mediaStage.audioWav")}</option>
									<option value="m4a">{t("mediaStage.audioM4a")}</option>
								</select>
								<button
									type="button"
									className={styles.importBtn}
									disabled={!!exporting}
									onClick={() => void exportSource("audio")}
								>
									<Download size={14} />
									{t(exporting === "audio" ? "mediaStage.exporting" : "mediaStage.exportAudio")}
								</button>
							</div>
							{exporting === "audio" ? (
								<button
									type="button"
									className={styles.importBtn}
									onClick={() => void window.electronAPI.cancelSourceAudioExport()}
								>
									{t("mediaStage.cancelExport")}
								</button>
							) : null}
							<p className={styles.mediaActionHint}>{t("mediaStage.sourceAudioHint")}</p>
							<button
								type="button"
								onClick={addSelectedToTimeline}
								disabled={selectedIsAudio && (!hasTimelineClips || !onAddAudioToTimeline)}
								style={{
									width: "100%",
									height: 36,
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									gap: 7,
									marginBottom: 16,
									borderRadius: 9,
									border: "1px solid var(--accent)",
									background: "var(--accent)",
									color: "var(--accent-on)",
									fontSize: 12.5,
									fontWeight: 650,
									cursor: "pointer",
									opacity: selectedIsAudio && !hasTimelineClips ? 0.5 : 1,
								}}
							>
								<Plus size={14} />
								{t("mediaStage.addToTimeline")}
							</button>
							{selectedIsAudio ? (
								<p className={styles.mediaActionHint}>
									{t(
										hasTimelineClips
											? "mediaStage.audioTimelineHint"
											: "mediaStage.audioNeedsVideo",
									)}
								</p>
							) : null}

							<div style={{ marginBottom: 16 }}>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										padding: "5px 10px 5px 8px",
										borderRadius: 9999,
										// A silent recording reads as a verdict about the media, not as a
										// broken run, so it keeps the neutral accent rather than the danger
										// red the engine failures get (issue #628).
										background:
											selectedTranscription.status === "failed" &&
											!isSilentFailure(selectedTranscription)
												? "var(--danger-soft)"
												: selectedTranscription.status === "ready"
													? "var(--success-soft)"
													: "var(--accent-soft)",
										color:
											selectedTranscription.status === "failed" &&
											!isSilentFailure(selectedTranscription)
												? "var(--danger)"
												: selectedTranscription.status === "ready"
													? "var(--success)"
													: "var(--accent)",
										fontSize: 12,
										fontWeight: 600,
									}}
								>
									<TranscriptionStatusDot view={selectedTranscription} size={5} />
									{transcriptionLabel(selectedTranscription)}
								</span>
								{/* The language whisper resolved on the first chunk, which every later
								    chunk was then pinned to. Its only pill used to live in the v3 left
								    panel's transcript modal, which nothing mounted, so the value was
								    reaching the document and being displayed nowhere. It belongs next to
								    "Regenerate as" below in any case: that selector is the control
								    you set BECAUSE of what was detected. */}
								{detectedLanguage ? (
									<span
										style={{
											display: "inline-flex",
											alignItems: "center",
											marginLeft: 8,
											padding: "5px 10px",
											borderRadius: 9999,
											background: "var(--success-soft)",
											color: "var(--success)",
											fontSize: 12,
											fontWeight: 600,
										}}
									>
										{t("mediaStage.detectedLanguage", {
											language: languageLabel(detectedLanguage, locale),
										})}
									</span>
								) : null}
							</div>

							{/* Renders itself away — spacing included — unless the run reports progress. */}
							<TranscriptionProgressBar view={selectedTranscription} />

							{selectedTranscription.failure ? (
								<p
									style={{
										margin: "-8px 0 16px",
										fontSize: 12,
										lineHeight: 1.5,
										color: "var(--muted)",
									}}
								>
									{failureHintKey ? t(failureHintKey) : selectedTranscription.failure.message}
								</p>
							) : null}

							{/* Project-wide: whisper's initial prompt for every run (issue #1023).
							    Uncontrolled and keyed on the saved value, so an undo that restores
							    an older list shows it; the save happens on blur, one undo step. */}
							<label style={{ display: "block", marginBottom: 12 }}>
								<span
									style={{
										display: "block",
										fontSize: 12.5,
										fontWeight: 600,
										color: "var(--fg-2)",
										marginBottom: 6,
									}}
								>
									{t("mediaStage.namesAndTerms")}
								</span>
								<textarea
									key={`${document?.project.id}:${document?.project.vocabulary ?? ""}`}
									defaultValue={document?.project.vocabulary ?? ""}
									maxLength={VOCABULARY_MAX_CHARS}
									rows={2}
									spellCheck={false}
									onBlur={(e) => {
										// The latest document, not the render's: a save replaces the whole
										// document, so a stale one would undo a transcript written meanwhile.
										const latest = useProjectStore.getState().document;
										const next = latest && withVocabulary(latest, e.target.value);
										if (next) vocabularySave.current = saveDocument(next, { history: true });
									}}
									style={{
										width: "100%",
										padding: "8px 10px",
										borderRadius: 9,
										border: "1px solid var(--border)",
										background: "var(--surface-2)",
										color: "var(--fg)",
										fontSize: 12.5,
										lineHeight: 1.5,
										resize: "vertical",
										outline: "none",
									}}
								/>
							</label>

							<div style={{ marginBottom: 12 }}>
								<>
									<button
										type="button"
										className={styles.importBtn}
										style={{ width: "100%", marginBottom: 6 }}
										onClick={() => setTranscriptionSettingsOpen(true)}
									>
										<Settings2 size={14} />
										{t("mediaStage.transcriptionMethods")}
									</button>
									<p className={styles.mediaActionHint}>
										{t("mediaStage.transcriptionMethodsHint")}
									</p>
								</>
								<div
									style={{
										fontSize: 12.5,
										fontWeight: 600,
										color: "var(--fg-2)",
										marginBottom: 6,
									}}
								>
									{t("mediaStage.regenerateAs")}
								</div>
								<div style={{ display: "flex", gap: 8 }}>
									<select
										value={lang}
										onChange={(e) => setLang(e.target.value as TranscriptLanguageCode)}
										style={{
											flex: 1,
											minWidth: 0,
											height: 36,
											padding: "0 10px",
											borderRadius: 9,
											border: "1px solid var(--border)",
											background: "var(--surface-2)",
											color: "var(--fg)",
											fontSize: 12.5,
											fontWeight: 500,
											outline: "none",
										}}
									>
										{regenLanguageOptions.map(({ code, label }) => (
											<option key={code} value={code}>
												{label}
											</option>
										))}
									</select>
									{/* A bare refresh icon beside a language list: the tip says what it redoes. */}
									<Tooltip content={t("mediaStage.regenerateTip")}>
										<button
											type="button"
											aria-label={t("mediaStage.regenerate")}
											// `aria-disabled`, not `disabled`: a natively disabled button cannot take focus or
											// open its tooltip. It does nothing while a transcription runs.
											aria-disabled={regenerateBusy || undefined}
											onClick={
												regenerateBusy
													? undefined
													: async () => {
															// Clicking here blurs the terms field, whose save is still in
															// flight: the run must read the terms it just saved, so a failed
															// save (already toasted) runs nothing.
															const saving = vocabularySave.current;
															vocabularySave.current = undefined;
															if ((await saving) === false) return;
															void requestTranscription(selected.id, lang);
														}
											}
											style={{
												padding: "0 10px",
												height: 36,
												flexShrink: 0,
												display: "inline-flex",
												alignItems: "center",
												gap: 6,
												borderRadius: 9,
												color: "var(--fg-2)",
												background: "var(--surface-2)",
												border: "1px solid var(--border)",
												cursor: regenerateBusy ? "not-allowed" : "pointer",
												opacity: regenerateBusy ? 0.6 : 1,
											}}
										>
											<RotateCw size={14} className={selectedBusy ? "animate-spin" : undefined} />
											{t("mediaStage.transcribeNow")}
										</button>
									</Tooltip>
								</div>
							</div>

							<div
								style={{
									padding: "16px",
									border: "1px solid var(--border)",
									borderRadius: 12,
									background: "var(--surface)",
									fontSize: 12.5,
									lineHeight: 1.7,
									color: "var(--fg-2)",
									maxHeight: 360,
									overflowY: "auto",
								}}
							>
								{transcript ? (
									(transcript.segments ?? [])
										.map((seg) => (seg as { text?: string }).text ?? "")
										.join(" ") || t("mediaStage.transcriptEmpty")
								) : (
									<span style={{ color: "var(--muted)" }}>
										{selectedBusy
											? transcriptionLabel(selectedTranscription)
											: isSilentFailure(selectedTranscription)
												? t("mediaStage.noAudioTrackHint")
												: selectedTranscription.status === "failed"
													? t("mediaStage.generationFailedHint")
													: t("mediaStage.notGeneratedHint")}
									</span>
								)}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
