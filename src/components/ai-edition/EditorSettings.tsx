// Bridge: mounts the existing SettingsPanel (from the legacy editor) inside
// the new editor shell. Reads editor appearance from AxcutDocument.legacyEditor
// + zoomRanges + annotations, writes changes back through the project store.
//
// ponytail: reuses the 2191-line SettingsPanel verbatim — no rewrite. The
// bridge manages local state for selections + cursor prefs + export prefs
// (same as VideoEditor.tsx does) and syncs the document-affecting fields
// through saveDocument on commit.

import { useCallback, useState } from "react";
import {
	DEFAULT_CURSOR_SETTINGS,
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
	DEFAULT_GIF_SETTINGS,
	DEFAULT_WEBCAM_SETTINGS,
} from "@/components/video-editor/editorDefaults";
import { SettingsPanel } from "@/components/video-editor/SettingsPanel";
import {
	type AnnotationRegion,
	type AnnotationType,
	type CropRegion,
	DEFAULT_WEBCAM_MIRRORED,
	DEFAULT_WEBCAM_REACTIVE_ZOOM,
	type FigureData,
	type PlaybackSpeed,
	type Rotation3DPreset,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamSizePreset,
	type ZoomDepth,
	type ZoomFocus,
	type ZoomFocusMode,
} from "@/components/video-editor/types";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { ExportFormat, ExportQuality, GifFrameRate, GifSizePreset } from "@/lib/exporter";
import type { AspectRatio } from "@/utils/aspectRatioUtils";

// ponytail: type helper — extracts the prop types from the SettingsPanel
type SettingsPanelProps = React.ComponentProps<typeof SettingsPanel>;

function getLegacy<T>(doc: AxcutDocument | null, key: string, fallback: T): T {
	const legacy = doc?.legacyEditor as Record<string, unknown> | null;
	if (legacy && key in legacy && typeof legacy[key] === typeof fallback) {
		return legacy[key] as T;
	}
	return fallback;
}

interface EditorSettingsBridgeProps {
	videoElement?: HTMLVideoElement | null;
	onExport?: () => void;
	activeTab?: "background" | "effects" | "camera" | "cursor" | "crop" | "export";
}

export function EditorSettingsBridge({
	videoElement,
	onExport,
	activeTab,
}: EditorSettingsBridgeProps) {
	const document = useProjectStore((s) => s.document);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const setDocument = useProjectStore((s) => s.setDocument);

	// Selection state (local, non-persistent)
	const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [selectedSpeedId, setSelectedSpeedId] = useState<string | null>(null);

	// Cursor prefs (local, non-persistent — same pattern as legacy VideoEditor)
	const [showCursor, setShowCursor] = useState(DEFAULT_CURSOR_SETTINGS.show);
	const [cursorSize, setCursorSize] = useState(DEFAULT_CURSOR_SETTINGS.size);
	const [cursorSmoothing, setCursorSmoothing] = useState(DEFAULT_CURSOR_SETTINGS.smoothing);
	const [cursorMotionBlur, setCursorMotionBlur] = useState(DEFAULT_CURSOR_SETTINGS.motionBlur);
	const [cursorClickBounce, setCursorClickBounce] = useState(DEFAULT_CURSOR_SETTINGS.clickBounce);
	const [cursorClipToBounds, setCursorClipToBounds] = useState(
		DEFAULT_CURSOR_SETTINGS.clipToBounds,
	);
	const [cursorTheme, setCursorTheme] = useState(DEFAULT_CURSOR_SETTINGS.theme);

	// Export prefs (local)
	const [exportQuality, setExportQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_SETTINGS.quality,
	);
	const [exportFormat, setExportFormat] = useState<ExportFormat>(DEFAULT_EXPORT_SETTINGS.format);
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(DEFAULT_GIF_SETTINGS.frameRate);
	const [gifLoop, setGifLoop] = useState(DEFAULT_GIF_SETTINGS.loop);
	const [gifSizePreset, setGifSizePreset] = useState<GifSizePreset>(
		DEFAULT_GIF_SETTINGS.sizePreset,
	);

	// Read appearance from legacyEditor blob
	const wallpaper = getLegacy(document, "wallpaper", DEFAULT_EDITOR_LAYOUT_SETTINGS.wallpaper);
	const shadowIntensity = getLegacy(document, "shadowIntensity", 0);
	const showBlur = getLegacy(document, "showBlur", false);
	const showTrimWaveform = getLegacy(document, "showTrimWaveform", true);
	const motionBlurAmount = getLegacy(document, "motionBlurAmount", 0);
	const borderRadius = getLegacy(document, "borderRadius", 0);
	const padding = getLegacy(document, "padding", DEFAULT_EDITOR_LAYOUT_SETTINGS.padding);
	const cropRegion = getLegacy<CropRegion>(
		document,
		"cropRegion",
		DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion,
	);
	const aspectRatio = getLegacy<AspectRatio>(
		document,
		"aspectRatio",
		DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
	);
	const webcamLayoutPreset = getLegacy<WebcamLayoutPreset>(
		document,
		"webcamLayoutPreset",
		DEFAULT_WEBCAM_SETTINGS.layoutPreset,
	);
	const webcamMaskShape = getLegacy<WebcamMaskShape>(
		document,
		"webcamMaskShape",
		DEFAULT_WEBCAM_SETTINGS.maskShape,
	);
	const webcamMirrored = getLegacy(document, "webcamMirrored", DEFAULT_WEBCAM_MIRRORED);
	const webcamReactiveZoom = getLegacy(
		document,
		"webcamReactiveZoom",
		DEFAULT_WEBCAM_REACTIVE_ZOOM,
	);
	const webcamSizePreset = getLegacy<WebcamSizePreset>(
		document,
		"webcamSizePreset",
		DEFAULT_WEBCAM_SETTINGS.sizePreset,
	);
	const cursorThemeFromLegacy = getLegacy(document, "cursorTheme", "");

	// Read regions from the document
	type ZoomRegionType = import("@/components/video-editor/types").ZoomRegion;
	type SpeedRegionType = import("@/components/video-editor/types").SpeedRegion;
	const zr: ZoomRegionType[] = (document?.zoomRanges ?? []) as unknown as ZoomRegionType[];
	const ar: AnnotationRegion[] = (document?.annotations ?? []) as unknown as AnnotationRegion[];
	const sr: SpeedRegionType[] = getLegacy(document, "speedRegions", [] as SpeedRegionType[]);

	// Helper: update legacyEditor field in the document
	const updateLegacy = useCallback(
		(patch: Record<string, unknown>) => {
			if (!document) return;
			const currentLegacy = (document.legacyEditor ?? {}) as Record<string, unknown>;
			const next: AxcutDocument = {
				...document,
				legacyEditor: { ...currentLegacy, ...patch },
			};
			setDocument(next);
		},
		[document, setDocument],
	);

	const commitToDisk = useCallback(async () => {
		if (!document) return;
		await saveDocument(useProjectStore.getState().document ?? document);
	}, [document, saveDocument]);

	// Zoom handlers
	const selectedZoom = selectedZoomId ? (zr.find((z) => z.id === selectedZoomId) ?? null) : null;

	const handleZoomDepthChange = useCallback(
		(depth: ZoomDepth) => {
			if (!document || !selectedZoomId) return;
			const next = zr.map((z) => (z.id === selectedZoomId ? { ...z, depth } : z));
			setDocument({ ...document, zoomRanges: next as unknown as AxcutDocument["zoomRanges"] });
		},
		[document, selectedZoomId, zr, setDocument],
	);

	const handleZoomDelete = useCallback(
		(id: string) => {
			if (!document) return;
			setDocument({
				...document,
				zoomRanges: document.zoomRanges.filter((z) => z.id !== id) as AxcutDocument["zoomRanges"],
			});
			setSelectedZoomId(null);
			void commitToDisk();
		},
		[document, setDocument, commitToDisk],
	);

	const handleZoomFocusChange = useCallback(
		(id: string, focus: ZoomFocus) => {
			if (!document) return;
			const next = zr.map((z) => (z.id === id ? { ...z, focus } : z));
			setDocument({ ...document, zoomRanges: next as unknown as AxcutDocument["zoomRanges"] });
		},
		[document, zr, setDocument],
	);

	const handleZoomFocusModeChange = useCallback(
		(mode: ZoomFocusMode) => {
			if (!document || !selectedZoomId) return;
			const next = zr.map((z) => (z.id === selectedZoomId ? { ...z, focusMode: mode } : z));
			setDocument({ ...document, zoomRanges: next as unknown as AxcutDocument["zoomRanges"] });
		},
		[document, selectedZoomId, zr, setDocument],
	);

	const handleZoomRotationPresetChange = useCallback(
		(preset: Rotation3DPreset | null) => {
			if (!document || !selectedZoomId) return;
			const next = zr.map((z) =>
				z.id === selectedZoomId
					? preset
						? { ...z, rotationPreset: preset }
						: { ...z, rotationPreset: undefined }
					: z,
			);
			setDocument({ ...document, zoomRanges: next as unknown as AxcutDocument["zoomRanges"] });
		},
		[document, selectedZoomId, zr, setDocument],
	);

	const handleZoomCustomScaleChange = useCallback(
		(scale: number) => {
			if (!document || !selectedZoomId) return;
			const next = zr.map((z) => (z.id === selectedZoomId ? { ...z, customScale: scale } : z));
			setDocument({ ...document, zoomRanges: next as unknown as AxcutDocument["zoomRanges"] });
		},
		[document, selectedZoomId, zr, setDocument],
	);

	// Annotation handlers
	const handleAnnotationContentChange = useCallback(
		(id: string, content: string) => {
			if (!document) return;
			const next = ar.map((a) => (a.id === id ? { ...a, content } : a));
			setDocument({ ...document, annotations: next as unknown as AxcutDocument["annotations"] });
		},
		[document, ar, setDocument],
	);

	const handleAnnotationTypeChange = useCallback(
		(id: string, type: AnnotationType) => {
			if (!document) return;
			const next = ar.map((a) => (a.id === id ? { ...a, type } : a));
			setDocument({ ...document, annotations: next as unknown as AxcutDocument["annotations"] });
		},
		[document, ar, setDocument],
	);

	const handleAnnotationStyleChange = useCallback(
		(id: string, style: Partial<AnnotationRegion["style"]>) => {
			if (!document) return;
			const next = ar.map((a) => (a.id === id ? { ...a, style: { ...a.style, ...style } } : a));
			setDocument({ ...document, annotations: next as unknown as AxcutDocument["annotations"] });
		},
		[document, ar, setDocument],
	);

	const handleAnnotationFigureDataChange = useCallback(
		(id: string, figureData: FigureData) => {
			if (!document) return;
			const next = ar.map((a) => (a.id === id ? { ...a, figureData } : a));
			setDocument({ ...document, annotations: next as unknown as AxcutDocument["annotations"] });
		},
		[document, ar, setDocument],
	);

	const handleAnnotationDuplicate = useCallback(
		(id: string) => {
			if (!document) return;
			const original = ar.find((a) => a.id === id);
			if (!original) return;
			const newId = `ann_${Date.now()}`;
			const copy: AnnotationRegion = {
				...original,
				id: newId,
				zIndex: Math.max(...ar.map((a) => a.zIndex), 0) + 1,
			};
			setDocument({
				...document,
				annotations: [...ar, copy] as unknown as AxcutDocument["annotations"],
			});
			setSelectedAnnotationId(newId);
		},
		[document, ar, setDocument],
	);

	const handleAnnotationDelete = useCallback(
		(id: string) => {
			if (!document) return;
			setDocument({
				...document,
				annotations: document.annotations.filter((a) => a.id !== id),
			});
			setSelectedAnnotationId(null);
			void commitToDisk();
		},
		[document, setDocument, commitToDisk],
	);

	// Speed handlers
	const handleSpeedChange = useCallback(
		(speed: PlaybackSpeed) => {
			if (!document || !selectedSpeedId) return;
			const next = sr.map((r) => (r.id === selectedSpeedId ? { ...r, speed } : r));
			updateLegacy({ sr: next });
		},
		[document, selectedSpeedId, sr, updateLegacy],
	);

	const handleSpeedDelete = useCallback(
		(id: string) => {
			if (!document) return;
			updateLegacy({ sr: sr.filter((r) => r.id !== id) });
			setSelectedSpeedId(null);
			void commitToDisk();
		},
		[document, sr, updateLegacy, commitToDisk],
	);

	const autoFocusAll = getLegacy(document, "autoFocusAll", false);

	const props: SettingsPanelProps = {
		selected: wallpaper,
		onWallpaperChange: (w) => {
			updateLegacy({ wallpaper: w });
			void commitToDisk();
		},
		aspectRatio,

		selectedZoomDepth: selectedZoom?.depth ?? null,
		onZoomDepthChange: handleZoomDepthChange,
		selectedZoomCustomScale: selectedZoom?.customScale ?? null,
		onZoomCustomScaleChange: handleZoomCustomScaleChange,
		onZoomCustomScaleCommit: () => void commitToDisk(),
		selectedZoomFocusMode: selectedZoom?.focusMode ?? null,
		onZoomFocusModeChange: handleZoomFocusModeChange,
		focusModeLocked: autoFocusAll,
		selectedZoomFocus: selectedZoom?.focus ?? null,
		onZoomFocusCoordinateChange: (focus) =>
			selectedZoomId && handleZoomFocusChange(selectedZoomId, focus),
		onZoomFocusCoordinateCommit: () => void commitToDisk(),
		selectedZoomId,
		onZoomDelete: handleZoomDelete,
		selectedZoomRotationPreset: selectedZoom?.rotationPreset ?? null,
		onZoomRotationPresetChange: handleZoomRotationPresetChange,

		shadowIntensity,
		onShadowChange: (v) => updateLegacy({ shadowIntensity: v }),
		onShadowCommit: () => void commitToDisk(),
		showBlur,
		onBlurChange: (v) => {
			updateLegacy({ showBlur: v });
			void commitToDisk();
		},
		showTrimWaveform,
		onTrimWaveformChange: (v) => {
			updateLegacy({ showTrimWaveform: v });
			void commitToDisk();
		},
		motionBlurAmount,
		onMotionBlurChange: (v) => updateLegacy({ motionBlurAmount: v }),
		onMotionBlurCommit: () => void commitToDisk(),
		borderRadius,
		onBorderRadiusChange: (v) => updateLegacy({ borderRadius: v }),
		onBorderRadiusCommit: () => void commitToDisk(),
		padding,
		onPaddingChange: (v) => updateLegacy({ padding: v }),
		onPaddingCommit: () => void commitToDisk(),
		cropRegion,
		onCropChange: (r) => {
			updateLegacy({ cropRegion: r });
			void commitToDisk();
		},

		webcamLayoutPreset,
		onWebcamLayoutPresetChange: (preset) => {
			updateLegacy({ webcamLayoutPreset: preset });
			void commitToDisk();
		},
		webcamMaskShape,
		onWebcamMaskShapeChange: (shape) => {
			updateLegacy({ webcamMaskShape: shape });
			void commitToDisk();
		},
		webcamMirrored,
		onWebcamMirroredChange: (m) => {
			updateLegacy({ webcamMirrored: m });
			void commitToDisk();
		},
		webcamReactiveZoom,
		onWebcamReactiveZoomChange: (r) => {
			updateLegacy({ webcamReactiveZoom: r });
			void commitToDisk();
		},
		webcamSizePreset,
		onWebcamSizePresetChange: (v) => updateLegacy({ webcamSizePreset: v }),
		onWebcamSizePresetCommit: () => void commitToDisk(),
		videoElement: videoElement ?? null,
		initialMode:
			activeTab === "crop"
				? "timeline"
				: activeTab === "camera"
					? "layout"
					: activeTab === "effects"
						? "effects"
						: activeTab === "cursor"
							? "cursor"
							: activeTab === "background"
								? "background"
								: "background",

		exportQuality,
		onExportQualityChange: setExportQuality,
		exportFormat,
		onExportFormatChange: setExportFormat,
		gifFrameRate,
		onGifFrameRateChange: setGifFrameRate,
		gifLoop,
		onGifLoopChange: setGifLoop,
		gifSizePreset,
		onGifSizePresetChange: setGifSizePreset,
		onExport,

		selectedAnnotationId,
		annotationRegions: ar,
		onAnnotationContentChange: handleAnnotationContentChange,
		onAnnotationTypeChange: handleAnnotationTypeChange,
		onAnnotationStyleChange: handleAnnotationStyleChange,
		onAnnotationFigureDataChange: handleAnnotationFigureDataChange,
		onAnnotationDuplicate: handleAnnotationDuplicate,
		onAnnotationDelete: handleAnnotationDelete,

		selectedSpeedId,
		selectedSpeedValue: selectedSpeedId
			? (sr.find((r) => r.id === selectedSpeedId)?.speed ?? null)
			: null,
		onSpeedChange: handleSpeedChange,
		onSpeedDelete: handleSpeedDelete,

		showCursor,
		onShowCursorChange: setShowCursor,
		cursorSize,
		onCursorSizeChange: setCursorSize,
		cursorSmoothing,
		onCursorSmoothingChange: setCursorSmoothing,
		cursorMotionBlur,
		onCursorMotionBlurChange: setCursorMotionBlur,
		cursorClickBounce,
		onCursorClickBounceChange: setCursorClickBounce,
		cursorClipToBounds,
		onCursorClipToBoundsChange: setCursorClipToBounds,
		cursorTheme: cursorThemeFromLegacy || cursorTheme,
		onCursorThemeChange: (t) => {
			setCursorTheme(t);
			updateLegacy({ cursorTheme: t });
			void commitToDisk();
		},
	};

	return <SettingsPanel {...props} hideInternalRail />;
}
