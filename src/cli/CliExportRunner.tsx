// Hidden-window runner for `openscreen export`. Loads an .openscreen project,
// migrates it to the AxcutDocument the native Rust compositor consumes, and
// drives exportMultiNative/exportGifNative — mirroring the v4 ExportDialog so
// CLI exports and GUI exports stay pixel-identical. The hidden window does no
// compositing itself: the render runs in the main process; this runner only
// builds the clip list + scene JSON and relays progress.

import { useEffect, useRef, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { prepareClickSound } from "@/lib/ai-edition/clickSound";
import {
	collectEffectiveClipDims,
	pickExtremeDims,
	resolveAspectRatioValue,
} from "@/lib/ai-edition/document/outputFormat";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForDocument,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import type { CliDoneResult, CliExportRequest } from "@/lib/cliContracts";
import { GIF_SIZE_PRESETS, type GifSizePreset } from "@/lib/exporter";
import { calculateMp4ExportSettings } from "@/lib/exporter/mp4ExportSettings";
import { outputFrameCount } from "@/lib/exporter/outputFrameCount";
import { mixVoiceoverIntoVideo } from "@/lib/exporter/voiceoverMix";
import { exportGifNative, exportMultiNative, nativeBridgeClient } from "@/native";
import { buildNativeClipList, buildSceneDescription } from "@/native/sceneDescription";
import { type ExportProject, loadDocumentProject } from "./exportProject";
import { loadCliProject, probeVideoDimensions } from "./loadCliProject";

function replaceExtension(filePath: string, newExtension: string): string {
	return filePath.replace(/\.(openscreen|json)$/i, "") + newExtension;
}

/** Mirrors ExportDialog.gifOutputDims: from the "Source" size, cap height at the preset, keep even. */
function gifOutputDims(
	preset: GifSizePreset,
	sourceDims: { width: number; height: number } | null,
): { width?: number; height?: number } {
	if (!sourceDims) return {};
	const maxHeight = GIF_SIZE_PRESETS[preset].maxHeight;
	if (!Number.isFinite(maxHeight) || sourceDims.height <= maxHeight) {
		return { width: sourceDims.width, height: sourceDims.height };
	}
	const scale = maxHeight / sourceDims.height;
	const even = (n: number) => Math.max(2, Math.round(n * scale) & ~1);
	return { width: even(sourceDims.width), height: even(sourceDims.height) };
}

/** The project to export: by id when the MCP server names one, else the file at its path. */
async function loadExportProject(request: CliExportRequest): Promise<ExportProject> {
	if (request.projectId) {
		const stored = await nativeBridgeClient.aiEdition.get(request.projectId);
		if (!stored.success || !stored.document) {
			throw new Error(stored.error ?? `No project has the id "${request.projectId}"`);
		}
		return loadDocumentProject(stored.document, (videoPath) =>
			probeVideoDimensions(toFileUrl(videoPath)),
		);
	}
	return loadCliProject(request.projectPath);
}

async function runExport(request: CliExportRequest): Promise<CliDoneResult> {
	const project = await loadExportProject(request);
	const { editor } = project;
	let axcutDocument = project.document;

	const format = request.format ?? editor.exportFormat;
	if (request.audioPath && format === "gif") {
		throw new Error(
			"--audio is only supported for MP4 exports (this project's stored format is gif; pass --format mp4)",
		);
	}
	if (request.quality && format === "gif") {
		throw new Error(
			"--quality is only supported for MP4 exports (this project's stored format is gif; a GIF is sized with --gif-size)",
		);
	}
	const quality = request.quality ?? editor.exportQuality;
	const gifFrameRate = request.gifFrameRate ?? editor.gifFrameRate;
	const gifSizePreset = request.gifSizePreset ?? editor.gifSizePreset;
	const gifLoop = request.gifLoop ?? editor.gifLoop;
	const mp4FrameRate = request.mp4FrameRate;
	const outPath =
		request.outPath ?? replaceExtension(request.projectPath, format === "gif" ? ".gif" : ".mp4");
	// Use the same per-clip auto-zoom suggestions as the editor, including its default span and
	// anchoring behavior.
	if (request.autoZoom) {
		const suggestions = await collectAutoZoomSuggestionsForDocument(axcutDocument, (videoPath) =>
			nativeBridgeClient.cursor.getTelemetry(videoPath).catch(() => []),
		);
		axcutDocument = appendAutoZoomSuggestions(axcutDocument, suggestions);
		window.electronAPI.cliLog(
			"info",
			`Auto-zoom: added ${suggestions.length} region(s) from cursor telemetry`,
		);
	}

	// Output sizing mirrors the ExportDialog: crop-aware smallest clip on the
	// timeline, normalized to the document's aspect ratio.
	const smallestSource =
		pickExtremeDims(collectEffectiveClipDims(axcutDocument), "smallest") ?? project.sourceDims;
	const aspectRatioValue = resolveAspectRatioValue(
		axcutDocument,
		getEditorSettings(axcutDocument).aspectRatio,
	);
	const dimsFor = (tier: typeof quality) =>
		calculateMp4ExportSettings({
			quality: tier,
			sourceWidth: smallestSource.width,
			sourceHeight: smallestSource.height,
			aspectRatioValue,
			frameRate: mp4FrameRate,
		});
	const outDims = dimsFor(quality);

	const builtClips = buildNativeClipList(axcutDocument);
	if (builtClips.length === 0) {
		throw new Error("The project's timeline has no visible clips to export");
	}
	// The scene carries the click hits, whose cues and staged samples are read out of caches a
	// scene build cannot await — without this a cold CLI export builds its scene from empty
	// caches and comes out silent. Clicks that will not load must not cost the export.
	await prepareClickSound(axcutDocument).catch(() => undefined);
	const sceneDesc = buildSceneDescription(axcutDocument);

	// The webcam background effect is applied by the compositor from the scene, so the clip
	// list needs no pre-rendering pass.
	const clips = builtClips;
	const sceneJson = JSON.stringify(sceneDesc);

	// Progress: native pushes raw encoded-frame counts; totals and pacing are
	// computed here, mirroring the ExportDialog.
	const outFps = format === "gif" ? gifFrameRate : mp4FrameRate;
	// Speed-adjusted, not source seconds — see `outputFrameCount`. Counting raw duration
	// is what made a 1.25x timeline stop the bar at 80% (OpenScreen#371).
	const totalFrames = outputFrameCount(clips, sceneDesc.speedRegions, outFps);
	const exportStartedAt = Date.now();
	const unsubscribeProgress = window.electronAPI.onNativeExportProgress?.((frames: number) => {
		const elapsedSec = (Date.now() - exportStartedAt) / 1000;
		const rate = frames > 0 ? frames / Math.max(elapsedSec, 0.001) : 0;
		window.electronAPI.cliProgress({
			percentage: Math.min(100, (frames / totalFrames) * 100),
			currentFrame: frames,
			totalFrames,
			estimatedTimeRemaining: rate > 0 ? Math.max(0, (totalFrames - frames) / rate) : 0,
		});
	});

	try {
		if (format === "gif") {
			// From the "Source" size as the dialog does, never the MP4 quality tier.
			const dims = gifOutputDims(gifSizePreset, dimsFor("source"));
			await exportGifNative(clips, outPath, sceneJson, {
				...dims,
				fps: gifFrameRate,
				loopCount: gifLoop ? 0 : 1,
			});
			return {
				success: true,
				outputPath: outPath,
				format,
				width: dims.width,
				height: dims.height,
			};
		}

		// MP4: native writes outPath directly. When a voiceover is requested, mix
		// it afterwards (the native pipeline has no extra-audio-track concept) and
		// overwrite the same file.
		await exportMultiNative(clips, outPath, sceneJson, {
			width: outDims.width,
			height: outDims.height,
			fps: mp4FrameRate,
			codec: "h264",
			bitrate: outDims.bitrate,
		});

		if (request.audioPath) {
			window.electronAPI.cliProgress({ percentage: 100, phase: "mixing-voiceover" });
			const [videoResponse, audioResponse] = await Promise.all([
				fetch(toFileUrl(outPath)),
				fetch(toFileUrl(request.audioPath)),
			]);
			if (!videoResponse.ok) {
				throw new Error(`Failed to read the exported video back for mixing: ${outPath}`);
			}
			if (!audioResponse.ok) {
				throw new Error(`Failed to read voiceover file: ${request.audioPath}`);
			}
			const mixed = await mixVoiceoverIntoVideo(await videoResponse.blob(), {
				voiceoverData: await audioResponse.arrayBuffer(),
				mode: request.audioMode,
				offsetSec: request.audioOffsetSec,
			});
			const saveResult = await window.electronAPI.writeExportToPath(
				await mixed.arrayBuffer(),
				outPath,
			);
			if (!saveResult.success) {
				throw new Error(saveResult.message ?? `Failed to write mixed output to ${outPath}`);
			}
		}

		return {
			success: true,
			outputPath: outPath,
			format,
			width: outDims.width,
			height: outDims.height,
		};
	} finally {
		unsubscribeProgress?.();
	}
}

export function CliExportRunner() {
	const startedRef = useRef(false);
	const [status, setStatus] = useState("Starting export…");

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		void (async () => {
			try {
				const request = (await window.electronAPI.cliGetRequest()) as CliExportRequest;
				if (request.kind !== "export") {
					throw new Error(`cli-export window received a ${request.kind} request`);
				}
				setStatus(`Exporting ${request.projectPath}…`);
				const result = await runExport(request);
				await window.electronAPI.cliDone(result);
			} catch (error) {
				const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
				await window.electronAPI.cliDone({ success: false, error: message });
			}
		})();
	}, []);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliExportRunner;
