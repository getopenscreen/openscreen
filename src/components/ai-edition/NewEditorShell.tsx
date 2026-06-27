import {
	Brackets,
	Download,
	EyeOff,
	Film,
	FolderOpen,
	LayoutPanelTop,
	Loader2,
	MessageSquare,
	MousePointerClick,
	Palette,
	PanelLeft,
	PanelRight,
	SlidersHorizontal,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
// import { ExportDialog } from "@/components/video-editor/ExportDialog";
import { AI_FEATURES_ENABLED } from "@/components/video-editor/featureFlags";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { transcribeAsset } from "@/lib/ai-edition/document/transcribe";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { nativeBridgeClient, useCursorRecordingData, useCursorTelemetry } from "@/native";
import { ChatPanel } from "./ChatPanel";
import { EditorSettingsBridge } from "./EditorSettings";
import { IconRail, type LeftTab, type RightTab, usePanelTabs } from "./IconRail";
import { ProjectPanel } from "./ProjectPanel";
import { TimelinePane } from "./TimelinePane";
import { TranscriptEditor } from "./TranscriptEditor";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";

interface SeekTarget {
	timeSec: number;
	requestId: number;
}

const LEFT_TABS: Array<{ id: LeftTab; label: string; icon: React.ElementType }> = [
	{ id: "project", label: "Project", icon: Film },
	...(AI_FEATURES_ENABLED ? [{ id: "chat" as LeftTab, label: "Chat", icon: MessageSquare }] : []),
];

const RIGHT_TABS: Array<{ id: RightTab; label: string; icon: React.ElementType }> = [
	{ id: "transcript", label: "Transcript", icon: Sparkles },
	{ id: "background", label: "Background", icon: Palette },
	{ id: "effects", label: "Video effects", icon: SlidersHorizontal },
	{ id: "camera", label: "Camera", icon: LayoutPanelTop },
	{ id: "cursor", label: "Cursor", icon: MousePointerClick },
	{ id: "crop", label: "Crop", icon: Brackets },
	{ id: "export", label: "Export", icon: Download },
];

export function NewEditorShell() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const sourceDurationSec = useProjectStore((s) => s.sourceDurationSec);
	const currentTimeSec = useProjectStore((s) => s.currentTimeSec);
	const createProject = useProjectStore((s) => s.createProject);
	const addAsset = useProjectStore((s) => s.addAsset);
	const replaceTimeline = useProjectStore((s) => s.replaceTimeline);
	const restoreFullTimeline = useProjectStore((s) => s.restoreFullTimeline);
	const setTranscript = useProjectStore((s) => s.setTranscript);
	const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
	const setSourceDuration = useProjectStore((s) => s.setSourceDuration);
	const loadProject = useProjectStore((s) => s.loadProject);

	const [seekTarget, setSeekTarget] = useState<SeekTarget | null>(null);
	const [isTranscribing, setIsTranscribing] = useState(false);
	const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
	const seekSeqRef = useRef(0);
	const initRef = useRef(false);

	const {
		leftTab,
		setLeftTab,
		rightTab,
		setRightTab,
		leftCollapsed,
		setLeftCollapsed,
		rightCollapsed,
		setRightCollapsed,
	} = usePanelTabs();

	const handleLeftTabChange = useCallback(
		(tab: LeftTab) => {
			if (leftTab === tab) {
				setLeftCollapsed((prev) => !prev);
			} else {
				setLeftTab(tab);
				setLeftCollapsed(false);
			}
		},
		[leftTab, setLeftTab, setLeftCollapsed],
	);

	const handleRightTabChange = useCallback(
		(tab: RightTab) => {
			if (rightTab === tab) {
				setRightCollapsed((prev) => !prev);
			} else {
				setRightTab(tab);
				setRightCollapsed(false);
			}
		},
		[rightTab, setRightTab, setRightCollapsed],
	);

	const primaryAssetPath =
		document?.assets.find((a) => a.id === document.project.primaryAssetId)?.originalPath ?? null;

	const cursorRecordingDataResult = useCursorRecordingData(primaryAssetPath);
	const cursorTelemetryResult = useCursorTelemetry(primaryAssetPath);
	const cursorRecordingData = cursorRecordingDataResult.data;
	const cursorTelemetry = cursorTelemetryResult.samples;
	void cursorRecordingData;
	void cursorTelemetry;
	// suppress unused: cursorClickTimestamps is wired to the exporter in a follow-up
	const cursorClickTimestamps = useMemo(
		() =>
			cursorTelemetry
				?.filter(
					(t: { interactionType?: string; timeMs: number }) =>
						t.interactionType === "click" || t.interactionType === "double-click",
				)
				.map((t: { timeMs: number }) => t.timeMs) ?? [],
		[cursorTelemetry],
	);
	void cursorClickTimestamps;

	const hasTranscript = Boolean(document?.transcript);
	const hasProject = Boolean(document);
	const hasAsset = projectId !== null && (document?.assets.length ?? 0) > 0;

	useEffect(() => {
		if (initRef.current) return;
		initRef.current = true;
		void (async () => {
			if (!window.electronAPI?.getCurrentRecordingSession) return;
			try {
				const result = await window.electronAPI.getCurrentRecordingSession();
				if (!result.success || !result.session?.screenVideoPath) return;
				const screenPath = result.session.screenVideoPath;
				const label = screenPath.split(/[\\/]/).pop() || "Recording";
				await createProject(`Recording ${new Date().toLocaleString()}`);
				await addAsset(screenPath, label);
				toast.success("Recording added to a new project");
			} catch (err) {
				toast.error("Could not auto-create project from recording", {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	}, [addAsset, createProject]);

	const videoSources: VideoSource[] = useMemo(() => {
		if (!document) return [];
		return document.assets.map((asset) => ({
			src: toFileUrl(asset.originalPath),
			label: asset.label,
		}));
	}, [document]);

	const clips = document?.timeline.clips ?? [];

	const handleLoadedMetadata = useCallback(
		(durationSec: number) => {
			setSourceDuration(durationSec);
			if (document && document.assets.length > 0 && document.timeline.clips.length === 0) {
				const asset =
					document.assets.find((a) => a.id === document.project.primaryAssetId) ??
					document.assets[0];
				if (asset) {
					void replaceTimeline(
						[{ startSec: 0, endSec: durationSec }],
						"Auto-created full-duration clip",
					);
				}
			}
		},
		[document, replaceTimeline, setSourceDuration],
	);

	const handleSeek = useCallback(
		(timeSec: number) => {
			setCurrentTime(timeSec);
			setSeekTarget({ timeSec, requestId: ++seekSeqRef.current });
		},
		[setCurrentTime],
	);

	const handleReplaceTimeline = useCallback(
		(intervals: Array<{ startSec: number; endSec: number }>, reason: string) => {
			void replaceTimeline(intervals, reason);
		},
		[replaceTimeline],
	);

	const handleTimeChange = useCallback(
		(timeSec: number) => {
			setCurrentTime(timeSec);
		},
		[setCurrentTime],
	);

	const handleTranscribe = useCallback(async () => {
		if (!document || !document.project.primaryAssetId) return;
		setIsTranscribing(true);
		try {
			const transcript = await transcribeAsset(document, document.project.primaryAssetId, {
				onStatus: (s) => toast.loading(`Transcribing: ${s}`, { id: "transcribe" }),
			});
			toast.dismiss("transcribe");
			await setTranscript(transcript);
			setRightTab("transcript");
			toast.success("Transcript ready");
		} catch (err) {
			toast.dismiss("transcribe");
			toast.error("Transcription failed", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setIsTranscribing(false);
		}
	}, [document, setTranscript, setRightTab]);

	const handleLoadLegacyProject = useCallback(async () => {
		try {
			const result = await window.electronAPI?.loadProjectFile();
			if (!result?.success || !result.project) return;
			const legacy = result.project as EditorProjectData;
			const migrated = migrateProjectDataToAxcutDocument(legacy);
			const saved = await nativeBridgeClient.aiEdition.save(migrated);
			if (saved.success && saved.document) {
				await loadProject(migrated.project.id);
				toast.success("Legacy project migrated and loaded");
			} else {
				toast.error(saved.error ?? "Failed to save migrated project");
			}
		} catch (err) {
			toast.error("Could not load project", {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [loadProject]);

	const handlePreviewSource = useCallback((_sourceTimeSec: number) => {}, []);

	const handleDropWordRange = useCallback(
		async (startSec: number, endSec: number) => {
			if (!document) return;
			const { subtractInterval, timelineIntervals: getIntervals } = await import(
				"@/lib/ai-edition/document/timeline"
			);
			const intervals = getIntervals(document);
			const next = subtractInterval(intervals, { startSec, endSec });
			await replaceTimeline(
				next,
				`Dropped word range ${startSec.toFixed(1)}s-${endSec.toFixed(1)}s`,
			);
		},
		[document, replaceTimeline],
	);

	// --- Right panel content based on selected right tab ---
	const rightContent = (() => {
		if (rightTab === "transcript") {
			if (!hasTranscript) {
				return (
					<div className="flex-1 flex flex-col items-center justify-center p-6 gap-3">
						<Sparkles className="h-8 w-8 text-white/20" />
						<div className="text-center max-w-[260px]">
							<p className="text-[12.5px] text-white/50 leading-relaxed">
								Click <strong className="text-white/80">Transcribe</strong> in the Project panel to
								generate a transcript with local Whisper.
							</p>
						</div>
						<button
							type="button"
							className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#34B27B] hover:bg-[#2d9e6c] text-white text-[11.5px] font-medium disabled:opacity-40"
							onClick={handleTranscribe}
							disabled={!hasAsset || isTranscribing}
						>
							{isTranscribing ? (
								<Loader2 size={12} className="animate-spin" />
							) : (
								<Sparkles size={12} />
							)}
							{isTranscribing ? "Transcribing…" : "Transcribe now"}
						</button>
					</div>
				);
			}
			return document?.transcript ? (
				<TranscriptEditor
					transcript={document.transcript}
					clips={clips}
					currentTimeSec={currentTimeSec}
					onSeek={handleSeek}
					onDropWordRange={handleDropWordRange}
				/>
			) : null;
		}
		if (rightTab === "export") {
			return (
				<div className="flex-1 overflow-y-auto p-4">
					<h2 className="text-[11px] font-semibold tracking-[0.1em] uppercase text-white/40 mb-3">
						Export
					</h2>
					<button
						type="button"
						className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#34B27B] hover:bg-[#2d9e6c] text-white font-medium text-sm disabled:opacity-40"
						onClick={() => {
							toast.info("Export via the ExportDialog (see legacy VideoEditor)");
						}}
						disabled={!hasAsset}
					>
						<Download size={14} />
						Export MP4
					</button>
					<p className="mt-3 text-[11px] text-white/40 text-center leading-relaxed">
						Exports use your project's appearance, zoom, annotations, and cursor settings.
					</p>
				</div>
			);
		}
		// All other right tabs use the SettingsPanel bridge (filtered to the relevant section)
		return hasProject ? (
			<EditorSettingsBridge videoElement={videoElement} activeTab={rightTab} />
		) : (
			<div className="flex-1 flex flex-col items-center justify-center p-6 gap-3">
				<Palette className="h-8 w-8 text-white/20" />
				<p className="text-[12px] text-white/45 text-center max-w-[240px] leading-relaxed">
					Open a project to edit {rightTab} settings.
				</p>
			</div>
		);
	})();

	// --- Left panel content ---
	const leftContent = leftTab === "chat" && AI_FEATURES_ENABLED ? <ChatPanel /> : <ProjectPanel />;

	// --- Toolbar buttons in left panel (Open + Remove cuts) ---
	const leftPanelFooter = hasProject ? (
		<div className="border-t border-white/[0.06] px-3 py-2 flex items-center gap-1">
			<button
				type="button"
				className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-colors text-[11px] font-medium disabled:opacity-40"
				onClick={handleLoadLegacyProject}
				title="Open a .openscreen project"
			>
				<FolderOpen size={12} />
				Open .openscreen
			</button>
			{clips.length > 0 && (
				<button
					type="button"
					className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-colors text-[11px] font-medium"
					onClick={() => void restoreFullTimeline()}
					title="Remove all cuts"
				>
					<EyeOff size={12} />
					Remove cuts
				</button>
			)}
		</div>
	) : null;

	return (
		<div className="flex flex-col h-full w-full bg-[#09090b] text-white/85 overflow-hidden">
			{/* Top header: project title + panel toggle buttons */}
			<header
				className="h-10 shrink-0 flex items-center justify-between px-4 border-b border-white/[0.07] bg-[#070809]/60"
				style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
			>
				<div
					className="flex items-center gap-3 min-w-0"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<h1 className="text-[13px] font-bold text-white truncate">
						{document?.project.title ?? "OpenScreen"}
					</h1>
					{document && (
						<span className="text-[10px] text-white/35 font-mono">
							{clips.length} clip{clips.length === 1 ? "" : "s"} · {document.assets.length} asset
							{document.assets.length === 1 ? "" : "s"}
						</span>
					)}
				</div>
				<div
					className="flex items-center gap-1"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<button
						type="button"
						className="flex items-center justify-center w-7 h-7 rounded text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-colors"
						onClick={() => setLeftCollapsed(!leftCollapsed)}
						title={leftCollapsed ? "Show left panel" : "Hide left panel"}
						aria-label={leftCollapsed ? "Show left panel" : "Hide left panel"}
					>
						<PanelLeft size={14} />
					</button>
					<button
						type="button"
						className="flex items-center justify-center w-7 h-7 rounded text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-colors"
						onClick={() => setRightCollapsed(!rightCollapsed)}
						title={rightCollapsed ? "Show right panel" : "Hide right panel"}
						aria-label={rightCollapsed ? "Show right panel" : "Hide right panel"}
					>
						<PanelRight size={14} />
					</button>
					<button
						type="button"
						className="flex items-center justify-center w-7 h-7 rounded text-white/50 hover:text-white/90 hover:bg-white/[0.08] transition-colors"
						onClick={() => toast.info("Export via the Export panel")}
						title="Export"
						aria-label="Export"
					>
						<Download size={14} />
					</button>
				</div>
			</header>

			<div className="flex flex-1 min-h-0">
				{/* Left icon rail */}
				<IconRail
					side="left"
					tabs={LEFT_TABS}
					active={leftTab}
					onChange={(id) => handleLeftTabChange(id as LeftTab)}
					collapsed={leftCollapsed}
					onToggleCollapse={() => setLeftCollapsed(!leftCollapsed)}
				/>

				{/* Left content panel: Project | Chat */}
				{!leftCollapsed && (
					<div className="w-72 min-w-72 shrink-0 h-full flex flex-col border-r border-white/[0.07] bg-[#0a0b0e]">
						<div className="flex-1 min-h-0 flex flex-col overflow-hidden">{leftContent}</div>
						{leftPanelFooter}
					</div>
				)}

				{/* Center: video + timeline, full height */}
				<div className="flex-1 min-w-0 flex flex-col bg-[#09090b] p-3.5 gap-3">
					{/* Video — fills remaining space above the timeline */}
					<div className="flex-1 min-h-0 flex">
						<div className="flex-1 min-w-0 flex flex-col editor-preview-zone">
							{hasProject && hasAsset ? (
								<div className="flex-1 flex flex-col editor-preview-panel">
									<VirtualPreview
										videoSources={videoSources}
										clips={clips}
										seekTarget={seekTarget}
										onTimeChange={handleTimeChange}
										onLoadedMetadata={handleLoadedMetadata}
										onVideoElement={setVideoElement}
									/>
								</div>
							) : hasProject ? (
								<div className="flex-1 flex flex-col items-center justify-center editor-preview-panel">
									<div className="flex flex-col items-center gap-3 text-center max-w-sm">
										<Film className="h-8 w-8 text-white/30" />
										<h2 className="text-base font-semibold text-slate-200">
											Add a video to get started
										</h2>
										<p className="text-sm text-slate-500">
											Click <strong className="text-white/70">Add</strong> in the Project panel.
										</p>
									</div>
								</div>
							) : (
								<div className="flex-1 flex flex-col items-center justify-center editor-preview-panel">
									<div className="flex flex-col items-center gap-3 text-center max-w-sm">
										<FolderOpen className="h-8 w-8 text-white/30" />
										<h2 className="text-base font-semibold text-slate-200">No project open</h2>
										<p className="text-sm text-slate-500">
											Create a project in the left panel, or{" "}
											<button
												type="button"
												className="text-[#34B27B] hover:text-[#2d9e6c] font-medium"
												onClick={handleLoadLegacyProject}
											>
												open a .openscreen file
											</button>
											.
										</p>
									</div>
								</div>
							)}
						</div>
					</div>

					{/* Timeline — always visible, full width, fixed height at the bottom */}
					<div className="shrink-0 h-[180px] editor-timeline-panel">
						<TimelinePane
							clips={clips}
							currentTimeSec={currentTimeSec}
							sourceDurationSec={sourceDurationSec}
							onSeek={handleSeek}
							onPreviewSource={handlePreviewSource}
							onReplaceTimeline={handleReplaceTimeline}
						/>
					</div>
				</div>

				{/* Right content panel */}
				{!rightCollapsed && (
					<div className="w-80 min-w-72 shrink-0 h-full flex flex-col border-l border-white/[0.07] bg-[#0a0b0e]">
						<div className="flex-1 min-h-0 flex flex-col overflow-hidden">{rightContent}</div>
					</div>
				)}

				{/* Right icon rail */}
				<IconRail
					side="right"
					tabs={RIGHT_TABS}
					active={rightTab}
					onChange={(id) => handleRightTabChange(id as RightTab)}
					collapsed={rightCollapsed}
					onToggleCollapse={() => setRightCollapsed(!rightCollapsed)}
				/>
			</div>
		</div>
	);
}
