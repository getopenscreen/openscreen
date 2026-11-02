// What `openscreen export` and `openscreen captions` read from a project file, in the
// hidden runner window: either shape the file was saved in, as one AxcutDocument. The
// renderer half of `exportProject.ts`, since probing a video needs a DOM.

import {
	type EditorProjectData,
	normalizeProjectEditor,
	type ProjectEditorState,
	resolveProjectMedia,
	toFileUrl,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "@/lib/ai-edition/document/migrate";
import { applyProbedDuration } from "@/lib/ai-edition/document/timeline";
import { isAxcutDocumentFile } from "@/lib/ai-edition/schema";
import { nativeBridgeClient } from "@/native";
import { type ExportProject, loadDocumentProject } from "./exportProject";

export function probeVideoDimensions(
	url: string,
): Promise<{ width: number; height: number; durationMs: number }> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		const cleanup = () => {
			clearTimeout(timer);
			video.removeAttribute("src");
			video.load();
		};
		// A stalled load fires neither event; without a deadline the CLI hangs.
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out reading video metadata: ${url}`));
		}, 30_000);
		video.onloadedmetadata = () => {
			const width = video.videoWidth;
			const height = video.videoHeight;
			const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
			cleanup();
			resolve({ width, height, durationMs });
		};
		video.onerror = () => {
			cleanup();
			reject(new Error(`Failed to load video metadata: ${url}`));
		};
		video.src = url;
	});
}

/**
 * The editor a v2 project migrates with: normalized, plus every key normalization does not list.
 * `normalizeProjectEditor` keeps an allowlist, while `getEditorSettings` reads more of
 * `legacyEditor` than that (the 3D cursor, click impact and sound, webcam styling, audio gain),
 * each key with its own validation and default. Dropping them made a CLI export render those
 * settings at their defaults (#1467); passed through raw, they are still read safely.
 */
export function legacyEditorForMigration(
	editor: Partial<ProjectEditorState> = {},
): ProjectEditorState {
	return { ...editor, ...normalizeProjectEditor(editor) };
}

/**
 * A legacy v2 project (`{ version, media, editor }`), as written before the editor saved the
 * document itself: migrated to an AxcutDocument, with what the migration cannot know probed.
 */
async function loadLegacyProject(project: EditorProjectData): Promise<ExportProject> {
	const media = resolveProjectMedia(project);
	if (!media) {
		throw new Error("Project file does not reference any recorded media");
	}
	// Prefer the main process's approved session paths: they carry the
	// packed-project sibling fallback when the stored absolute paths are stale.
	try {
		const sessionResult = await window.electronAPI.getCurrentRecordingSession();
		const session = sessionResult?.session;
		if (session?.screenVideoPath) {
			media.screenVideoPath = session.screenVideoPath;
			if (media.webcamVideoPath && session.webcamVideoPath) {
				media.webcamVideoPath = session.webcamVideoPath;
			}
		}
	} catch {
		// Fall back to the paths stored in the project file.
	}
	const editor = legacyEditorForMigration(project.editor);

	const probed = await probeVideoDimensions(toFileUrl(media.screenVideoPath));

	// Migrate the .openscreen project onto the AxcutDocument the native
	// compositor consumes. The migration is pure and carries zooms, annotations,
	// trims and the legacy editor settings; the clip's duration is unknown until
	// probed, so applyProbedDuration must run or the export is a single frame.
	let axcutDocument = migrateProjectDataToAxcutDocument({
		...project,
		media,
		editor,
	});
	const primaryAssetId = axcutDocument.project.primaryAssetId ?? axcutDocument.assets[0]?.id;
	if (!primaryAssetId) {
		throw new Error("Project migration produced no media asset");
	}
	if (probed.durationMs > 0) {
		axcutDocument = applyProbedDuration(axcutDocument, primaryAssetId, probed.durationMs / 1000);
	}
	// The screen's dimensions, for the same reason as the camera's below: the pure migration
	// cannot know them, and the scene's screen box, the output frame and Auto all read them off
	// `asset.video`. Without them the CLI laid every recording out as 1920x1080 while sizing the
	// export from the probe, two answers to one question.
	if (probed.width > 0 && probed.height > 0) {
		axcutDocument = {
			...axcutDocument,
			assets: axcutDocument.assets.map((asset) =>
				asset.id === primaryAssetId
					? {
							...asset,
							video: {
								codec: "unknown",
								fps: 0,
								...asset.video,
								width: probed.width,
								height: probed.height,
							},
						}
					: asset,
			),
		};
	}

	// The camera's dimensions decide the PiP's layout box, and this is the one caller the
	// document cannot answer for: there is no editor session here to have probed and saved
	// them, so without this the CLI lays the box out from a hardcoded 4:3 and a 16:9 camera
	// exports framed differently from the same project opened in the app.
	//
	// Failure-tolerant on purpose, unlike the screen probe above which is allowed to reject:
	// a camera file that has gone missing should cost the export its camera, not the export.
	if (media.webcamVideoPath) {
		const camera = await probeVideoDimensions(toFileUrl(media.webcamVideoPath)).catch(() => null);
		if (camera) {
			axcutDocument = {
				...axcutDocument,
				assets: axcutDocument.assets.map((asset) =>
					asset.cameraTrack
						? {
								...asset,
								cameraTrack: {
									...asset.cameraTrack,
									width: camera.width,
									height: camera.height,
								},
							}
						: asset,
				),
			};
		}
	}
	return {
		document: axcutDocument,
		editor,
		screenVideoPath: media.screenVideoPath,
		durationMs: probed.durationMs,
		sourceDims: { width: probed.width, height: probed.height },
	};
}

/** The project at `projectPath`, whichever shape it was saved in. */
export async function loadCliProject(projectPath: string): Promise<ExportProject> {
	const loaded = await nativeBridgeClient.project.loadProjectFileFromPath(projectPath);
	if (!loaded.success || loaded.project === undefined) {
		throw new Error(loaded.error ?? loaded.message ?? "Failed to load project file");
	}
	if (isAxcutDocumentFile(loaded.project)) {
		return loadDocumentProject(loaded.project, (videoPath) =>
			probeVideoDimensions(toFileUrl(videoPath)),
		);
	}
	if (validateProjectData(loaded.project)) return loadLegacyProject(loaded.project);
	throw new Error("Project file is not a valid .openscreen project");
}
