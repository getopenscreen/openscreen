// The two CLI commands that only touch the project file and its media:
// `openscreen pack` and `openscreen info`. They live outside cliMain.ts so they
// carry no `electron` import and stay unit-testable — the caller passes the
// writer, so nothing here knows about process.stdout either.

import fs from "node:fs/promises";
import path from "node:path";
import { isAxcutDocumentFile, parseDocumentFile } from "../../src/lib/ai-edition/schema";

/** Writes one already-newline-terminated chunk of CLI output. */
export type CliWriter = (text: string) => void;

export interface PackedProjectData {
	version?: number;
	media?: { screenVideoPath?: string; webcamVideoPath?: string; cursorCaptureMode?: string };
	videoPath?: string;
	editor?: Record<string, unknown>;
}

const isFile = (candidate: string): Promise<boolean> =>
	fs
		.stat(candidate)
		.then((stats) => stats.isFile())
		.catch(() => false);

/** Copies a project and everything it references into one portable folder. */
export async function runPackCommand(
	projectPath: string,
	outDir: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const emit = (message: string) => {
		if (!json) out(`${message}\n`);
	};

	const raw = await fs.readFile(projectPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	// A document can hold several assets, a camera track and imported audio, each with its own
	// path, and the loader's sibling fallback only covers the v2 shape. Say so rather than
	// report that it has no video.
	if (isAxcutDocumentFile(parsed)) {
		throw new Error(
			"pack does not support projects saved by the editor yet, only legacy v2 project files",
		);
	}
	const data = parsed as PackedProjectData;
	const media = data.media ?? (data.videoPath ? { screenVideoPath: data.videoPath } : undefined);
	const screenVideoPath = media?.screenVideoPath;
	if (!screenVideoPath) {
		throw new Error("Project file does not reference a screen video");
	}

	const projectDir = path.dirname(path.resolve(projectPath));
	const resolveSource = async (mediaPath: string): Promise<string> => {
		if (await isFile(mediaPath)) return mediaPath;
		// Moved project: the stored absolute path is stale but the media travelled
		// with the .openscreen file. Same rule as the loader's sibling fallback.
		const sibling = path.join(projectDir, path.basename(mediaPath));
		if (await isFile(sibling)) return sibling;
		throw new Error(`Referenced media not found: ${mediaPath}`);
	};

	await fs.mkdir(outDir, { recursive: true });

	const copied: string[] = [];
	const copyIn = async (sourcePath: string): Promise<string> => {
		const ext = path.extname(sourcePath);
		const stem = path.basename(sourcePath, ext);
		let destination = path.join(outDir, stem + ext);
		// Screen and webcam can share a basename across directories; don't overwrite.
		for (let n = 1; copied.includes(destination); n++) {
			destination = path.join(outDir, `${stem}-${n}${ext}`);
		}
		if (path.resolve(sourcePath) !== path.resolve(destination)) {
			await fs.copyFile(sourcePath, destination);
		}
		copied.push(destination);
		return destination;
	};

	const screenSource = await resolveSource(screenVideoPath);
	const newScreenPath = await copyIn(screenSource);

	let newWebcamPath: string | undefined;
	if (media.webcamVideoPath) {
		newWebcamPath = await copyIn(await resolveSource(media.webcamVideoPath));
	}

	// Cursor telemetry sidecar sits at "<video path>.cursor.json".
	const cursorSidecar = `${screenSource}.cursor.json`;
	const hasCursorData = await isFile(cursorSidecar);
	if (hasCursorData) {
		await copyIn(cursorSidecar);
	}

	const packedProject: PackedProjectData = {
		...data,
		media: {
			...media,
			screenVideoPath: newScreenPath,
			...(newWebcamPath ? { webcamVideoPath: newWebcamPath } : {}),
		},
	};
	delete packedProject.videoPath;
	const packedProjectPath = path.join(outDir, path.basename(projectPath));
	await fs.writeFile(packedProjectPath, JSON.stringify(packedProject, null, 2), "utf8");

	if (json) {
		out(
			`${JSON.stringify({
				event: "done",
				success: true,
				projectPath: packedProjectPath,
				files: [packedProjectPath, ...copied],
				cursorData: hasCursorData,
			})}\n`,
		);
	} else {
		emit(`Packed project → ${packedProjectPath}`);
		for (const file of copied) {
			emit(`  + ${path.basename(file)}`);
		}
		if (!hasCursorData) {
			emit("  (no cursor telemetry sidecar found)");
		}
		emit(
			"The folder is self-contained: if the stored paths go stale after moving it, the loader falls back to files next to the project.",
		);
	}
	return 0;
}

/** Prints what a project references and whether its media is still reachable. */
export async function runInfoCommand(
	projectPath: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const raw = await fs.readFile(projectPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	const fields = isAxcutDocumentFile(parsed)
		? documentInfoFields(parseDocumentFile(parsed))
		: legacyInfoFields(parsed as PackedProjectData);
	const screenVideoPath = fields.screenVideoPath;
	const mediaExists = screenVideoPath
		? await fs
				.access(screenVideoPath)
				.then(() => true)
				.catch(() => false)
		: false;

	const summary = {
		projectPath,
		version: fields.version,
		screenVideoPath,
		screenVideoExists: mediaExists,
		webcamVideoPath: fields.webcamVideoPath,
		cursorCaptureMode: fields.cursorCaptureMode,
		exportFormat: fields.exportFormat,
		exportQuality: fields.exportQuality,
		aspectRatio: fields.aspectRatio,
		zoomRegions: fields.zoomRegions,
		trimRegions: fields.trimRegions,
		speedRegions: fields.speedRegions,
		annotationRegions: fields.annotationRegions,
	};

	if (json) {
		out(`${JSON.stringify(summary)}\n`);
	} else {
		out(
			[
				`Project:  ${summary.projectPath} (version ${summary.version ?? "?"})`,
				`Video:    ${summary.screenVideoPath ?? "(none)"}${mediaExists ? "" : "  [MISSING]"}`,
				`Webcam:   ${summary.webcamVideoPath ?? "(none)"}`,
				`Cursor:   ${summary.cursorCaptureMode ?? "(unknown)"}`,
				`Export:   ${summary.exportFormat ?? "?"} / ${summary.exportQuality ?? "?"} / ${summary.aspectRatio ?? "?"}`,
				`Timeline: ${summary.zoomRegions} zooms, ${summary.trimRegions} trims, ${summary.speedRegions} speed regions, ${summary.annotationRegions} annotations`,
			].join("\n") + "\n",
		);
	}
	return summary.screenVideoPath && !mediaExists ? 1 : 0;
}

/** What `openscreen info` reports, read off either shape of project file. */
interface ProjectInfoFields {
	/** The v2 `version`, or a document's `schemaVersion`. */
	version: number | null;
	screenVideoPath: string | null;
	webcamVideoPath: string | null;
	cursorCaptureMode: string | null;
	exportFormat: string | null;
	exportQuality: string | null;
	aspectRatio: string | null;
	zoomRegions: number;
	trimRegions: number;
	speedRegions: number;
	annotationRegions: number;
}

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

function legacyInfoFields(data: PackedProjectData): ProjectInfoFields {
	const editor = data.editor ?? {};
	const count = (key: string) =>
		Array.isArray(editor[key]) ? (editor[key] as unknown[]).length : 0;
	return {
		version: data.version ?? null,
		screenVideoPath: data.media?.screenVideoPath ?? data.videoPath ?? null,
		webcamVideoPath: data.media?.webcamVideoPath ?? null,
		cursorCaptureMode: data.media?.cursorCaptureMode ?? null,
		exportFormat: stringOrNull(editor.exportFormat),
		exportQuality: stringOrNull(editor.exportQuality),
		aspectRatio: stringOrNull(editor.aspectRatio),
		zoomRegions: count("zoomRegions"),
		trimRegions: count("trimRegions"),
		speedRegions: count("speedRegions"),
		annotationRegions: count("annotationRegions"),
	};
}

/**
 * A project the editor saved. Its media is the primary asset; the export settings are only
 * there when a migrated v2 project left them in `legacyEditor` (the ExportDialog keeps its own).
 * Speed regions live in `legacyEditor.speedRegions`, not `timeline.speedRanges`: that is where
 * the editor writes them and where the scene reads them (`sceneDescription.ts`).
 */
function documentInfoFields(doc: ReturnType<typeof parseDocumentFile>): ProjectInfoFields {
	const primary =
		doc.assets.find((asset) => asset.id === doc.project.primaryAssetId) ?? doc.assets[0];
	const editor = doc.legacyEditor ?? {};
	return {
		version: doc.schemaVersion,
		screenVideoPath: primary?.originalPath ?? null,
		webcamVideoPath: primary?.cameraTrack?.sourcePath ?? null,
		cursorCaptureMode: null,
		exportFormat: stringOrNull(editor.exportFormat),
		exportQuality: stringOrNull(editor.exportQuality),
		aspectRatio: stringOrNull(editor.aspectRatio),
		zoomRegions: doc.zoomRanges.length,
		trimRegions: doc.timeline.trimRanges.length,
		speedRegions: Array.isArray(editor.speedRegions) ? editor.speedRegions.length : 0,
		annotationRegions: doc.annotations.length,
	};
}
