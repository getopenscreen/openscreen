// What `openscreen export` reads from a project file, and the loader for the shape the editor
// saves (the AxcutDocument itself). Kept out of CliExportRunner.tsx so it is testable without a
// renderer: the one thing it needs from the DOM, reading a video's metadata, is passed in.

import {
	normalizeProjectEditor,
	type ProjectEditorState,
} from "@/components/video-editor/projectPersistence";
import type { Dims } from "@/lib/ai-edition/document/outputFormat";
import { type AxcutDocument, parseDocumentFile } from "@/lib/ai-edition/schema";

/** Reads a video file's dimensions and duration. */
export type VideoProbe = (
	videoPath: string,
) => Promise<{ width: number; height: number; durationMs: number }>;

/** What the export reads from a project file, whichever shape it was saved in. */
export interface ExportProject {
	document: AxcutDocument;
	/** The v2 editor fields the export reads: format, quality and the GIF settings. */
	editor: ProjectEditorState;
	/** The primary screen recording, where `--auto-zoom` looks up the cursor telemetry. */
	screenVideoPath: string;
	/** Its length in ms, the span `--auto-zoom` suggests zooms over. */
	durationMs: number;
	/** The output size when no clip on the timeline reports one. */
	sourceDims: Dims;
}

/**
 * A project the editor saved: the AxcutDocument itself, at any `schemaVersion`, upgraded and
 * validated as the editor's "Browse files…" does. The main process has already relinked moved
 * media and granted the paths the document declares, as when the editor opens it. Its assets
 * carry their own dimensions and duration, so nothing is migrated and nothing is probed unless
 * an asset lacks them.
 *
 * The ExportDialog keeps format, quality and the GIF settings in its own state, not in the
 * document: they are read from `legacyEditor` when a migrated v2 project left them there, and
 * otherwise take the same defaults as a v2 project. The command-line flags win either way.
 */
export async function loadDocumentProject(raw: unknown, probe: VideoProbe): Promise<ExportProject> {
	const document = parseDocumentFile(raw);
	const primary =
		document.assets.find((asset) => asset.id === document.project.primaryAssetId) ??
		document.assets[0];
	if (!primary?.originalPath) {
		throw new Error("Project file does not reference any recorded media");
	}
	const { video, durationSec } = primary;
	const known = video && video.width > 0 && video.height > 0 && (durationSec ?? 0) > 0;
	const probed = known ? null : await probe(primary.originalPath);
	return {
		document,
		editor: normalizeProjectEditor((document.legacyEditor ?? {}) as Partial<ProjectEditorState>),
		screenVideoPath: primary.originalPath,
		durationMs: probed ? probed.durationMs : (durationSec ?? 0) * 1000,
		sourceDims: probed
			? { width: probed.width, height: probed.height }
			: { width: video?.width ?? 0, height: video?.height ?? 0 },
	};
}
