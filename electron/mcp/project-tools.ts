// The project's own fields and its media, as MCP tools: rename the project, import a
// file into its media, remove one. Run by the tool runner like any document edit
// (openscreen-mcp-server.ts), so the project open in the editor changes there, live
// and one Ctrl/Cmd+Z step, and any other project meets the same checkpoint rule. The
// app's channel serves them too, so `openscreen mcp` hands them to the running app.
//
// Deleting a project is deliberately not here: it cannot be undone, and nothing an
// agent makes needs it.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createId } from "../../src/lib/ai-edition/document/ids";
import type { AxcutAsset, AxcutDocument } from "../../src/lib/ai-edition/schema";
import type { AgentToolExecution } from "../ai-edition/agent-tools";
import {
	assetKindForPath,
	documentWithAsset,
	documentWithoutAsset,
	unsupportedAssetPath,
} from "../ai-edition/document-service";
import {
	DEFAULT_HOLD_SEC,
	IMAGE_EXTENSIONS,
	isImagePath,
	MAX_HOLD_SEC,
	MIN_HOLD_SEC,
	type StillClip,
} from "../media/stillClip";
import type { OpenedVideo } from "./hidden-video";

export const SET_PROJECT_INFO_TOOL = "setProjectInfo";
export const IMPORT_MEDIA_TOOL = "importMedia";
export const REMOVE_MEDIA_TOOL = "removeMedia";

/** The runner's edits to a project that are not the document executor's. */
export const PROJECT_EDIT_TOOLS: ReadonlySet<string> = new Set([
	SET_PROJECT_INFO_TOOL,
	IMPORT_MEDIA_TOOL,
	REMOVE_MEDIA_TOOL,
]);

const setProjectInfoArgs = z.object({
	title: z.string().describe("The project's new name."),
});

const importMediaArgs = z.object({
	path: z
		.string()
		.describe(
			"Absolute path of the file. Video: .mp4, .mov, .m4v, .webm, .mkv, .avi, .wmv. Audio: .mp3, .wav, .m4a, .aac, .flac, .ogg, .oga, .opus, .webm. Image: .png, .jpg, .jpeg, .webp.",
		),
	holdSec: z
		.number()
		.min(MIN_HOLD_SEC)
		.max(MAX_HOLD_SEC)
		.optional()
		.describe(
			`For an image only: how many seconds the video made from it lasts. Default ${DEFAULT_HOLD_SEC}. A clip of it can be shortened later with setClipRange but not made longer: import the image again with a longer holdSec.`,
		),
	kind: z
		.enum(["video", "audio"])
		.optional()
		.describe(
			"What the file is. Default: audio for an audio-only extension, video otherwise, so pass audio for a .webm that holds only sound.",
		),
	label: z.string().optional().describe("Its name in the project's media. Default: the file name."),
});

const removeMediaArgs = z.object({
	assetId: z.string().describe("The asset to remove, from getCurrentDocument's assets."),
});

export const PROJECT_TOOLS = [
	{
		name: SET_PROJECT_INFO_TOOL,
		description:
			"Rename the project: its title in OpenScreen's project list and in the editor's top bar, as renaming it there does. Changes nothing else.",
		inputSchema: setProjectInfoArgs,
		destructive: false,
	},
	{
		name: IMPORT_MEDIA_TOOL,
		description:
			"Add a video, audio or image file from disk to the project's media, as the editor's Import does. It does not place it on the timeline. An audio file is then played by a track you lay with addAudio. An image becomes a silent video of holdSec seconds showing the image, placed with insertClip like any footage (still: true in the result, with the picture's width and height); its transparent pixels become black, so a logo laid over the picture is an image annotation, which the editor adds and these tools do not, and an image larger than 3840x2160 is scaled down to fit. A video or an image becomes the project's footage when it has none yet (a project createProject made without a video): replaceTimeline then lays it out. Returns the new assetId and the file's durationSec, null when OpenScreen could not read it (the editor reads it again when it opens the project).",
		inputSchema: importMediaArgs,
		destructive: false,
	},
	{
		name: REMOVE_MEDIA_TOOL,
		description:
			"Remove a file from the project's media. Refused while the timeline still uses it: remove its clips (removeClip) and its audio tracks (removeModifier) first. The file on disk is left alone.",
		inputSchema: removeMediaArgs,
		destructive: true,
	},
] as const;

function failure(message: string): AgentToolExecution {
	return { ok: false, resultJson: JSON.stringify({ error: message }) };
}

/** Why `filePath` cannot be imported as `kind`, or `null` when it can. */
export async function mediaPathProblem(
	filePath: string,
	kind: "video" | "audio" | "image",
): Promise<string | null> {
	if (!path.isAbsolute(filePath)) return `The path must be absolute, got "${filePath}".`;
	const unsupported = kind === "image" ? null : unsupportedAssetPath({ path: filePath, kind });
	if (unsupported) return unsupported;
	const stat = await fs.stat(filePath).catch(() => null);
	if (!stat?.isFile()) return `No file at "${filePath}".`;
	return null;
}

export function setProjectInfo(document: AxcutDocument, rawArgs: unknown): AgentToolExecution {
	const parsed = setProjectInfoArgs.safeParse(rawArgs);
	if (!parsed.success) return failure(parsed.error.message);
	// Trimmed and never empty, as the editor's name field commits it.
	const title = parsed.data.title.trim();
	if (!title) return failure("title must not be empty.");
	return {
		ok: true,
		resultJson: JSON.stringify({ ok: true, title }),
		document: { ...document, project: { ...document.project, title } },
	};
}

export function removeMedia(document: AxcutDocument, rawArgs: unknown): AgentToolExecution {
	const parsed = removeMediaArgs.safeParse(rawArgs);
	if (!parsed.success) return failure(parsed.error.message);
	const { assetId } = parsed.data;
	if (!document.assets.some((asset) => asset.id === assetId)) {
		return failure(`Unknown asset: ${assetId}. getCurrentDocument lists the project's assets.`);
	}
	const clips = document.timeline.clips.filter((clip) => clip.assetId === assetId);
	const tracks = document.audioTracks.filter((track) => track.assetId === assetId);
	if (clips.length > 0 || tracks.length > 0) {
		const uses = [
			...(clips.length ? [`clips ${clips.map((clip) => clip.id).join(", ")} (removeClip)`] : []),
			...(tracks.length
				? [`audio tracks ${tracks.map((track) => track.id).join(", ")} (removeModifier)`]
				: []),
		];
		return failure(
			`Asset ${assetId} is still on the timeline, so nothing was removed. Remove its ${uses.join(" and its ")} first.`,
		);
	}
	const next = documentWithoutAsset(document, assetId);
	return {
		ok: true,
		resultJson: JSON.stringify({
			ok: true,
			removed: assetId,
			primaryAssetId: next.project.primaryAssetId ?? null,
		}),
		document: next,
	};
}

export interface ImportMediaDeps {
	/** The duration probe the editor's footage goes through (hidden-video.ts). */
	openVideo?(filePath: string): Promise<OpenedVideo>;
	/** Lets the editor read the file, as picking it in the editor would. */
	approveMedia?(filePath: string): void;
	/** Turns an image into the silent video it is imported as (stillClip.ts). */
	makeStill?(imagePath: string, holdSec: number): Promise<StillClip>;
}

/**
 * Checks and measures the file, then returns the edit that files it: computed before the
 * runner reads the project, so the slow probe never holds a snapshot open. A string is
 * why it cannot be imported.
 */
export async function prepareImportMedia(
	rawArgs: unknown,
	deps: ImportMediaDeps,
): Promise<((document: AxcutDocument) => Promise<AgentToolExecution>) | string> {
	const parsed = importMediaArgs.safeParse(rawArgs);
	if (!parsed.success) return JSON.stringify({ error: parsed.error.message });
	const { path: filePath, label, holdSec } = parsed.data;
	const kind = parsed.data.kind ?? assetKindForPath(filePath);
	const image = kind === "video" && isImagePath(filePath);
	if (holdSec !== undefined && !image) {
		return JSON.stringify({ error: "holdSec is for an image only." });
	}
	const problem = await mediaPathProblem(filePath, image ? "image" : kind);
	if (problem) {
		const images = problem.startsWith("Unsupported video")
			? ` Image: ${IMAGE_EXTENSIONS.join(", ")}.`
			: "";
		return JSON.stringify({ error: problem + images });
	}
	if (image) return prepareStill(filePath, holdSec ?? DEFAULT_HOLD_SEC, label, deps);

	const sizeBytes = (await fs.stat(filePath)).size;
	// Not fatal, as in the editor: a file Chromium cannot decode may still be one the
	// compositor plays, and the editor probes it again once it opens the project.
	const probed = await deps.openVideo?.(filePath).then(
		(video) => {
			video.close();
			return video;
		},
		() => null,
	);
	const durationSec =
		probed && Number.isFinite(probed.durationSec) && probed.durationSec > 0
			? probed.durationSec
			: undefined;
	deps.approveMedia?.(filePath);

	return async (document) => {
		const asset: AxcutAsset = {
			id: createId("asset"),
			kind,
			label: label?.trim() || path.basename(filePath),
			originalPath: filePath,
			sizeBytes,
			cameraTrack: null,
			...(durationSec ? { durationSec } : {}),
			...(kind === "video" && probed && probed.width > 0
				? { video: { codec: "unknown", width: probed.width, height: probed.height, fps: 0 } }
				: {}),
		};
		const next = documentWithAsset(document, asset);
		return {
			ok: true,
			resultJson: JSON.stringify({
				ok: true,
				assetId: asset.id,
				kind,
				label: asset.label,
				durationSec: durationSec ?? null,
				primaryAssetId: next.project.primaryAssetId ?? null,
			}),
			document: next,
		};
	};
}

/** An image is filed as the video made from it: an ordinary video asset whose length is the hold. */
async function prepareStill(
	imagePath: string,
	holdSec: number,
	label: string | undefined,
	deps: ImportMediaDeps,
): Promise<((document: AxcutDocument) => Promise<AgentToolExecution>) | string> {
	if (!deps.makeStill) return JSON.stringify({ error: "Images cannot be imported here." });
	let still: StillClip;
	try {
		still = await deps.makeStill(imagePath, holdSec);
	} catch (error) {
		return JSON.stringify({
			error: `"${imagePath}" could not be imported: ${(error as Error).message}`,
		});
	}
	const sizeBytes = (await fs.stat(still.path)).size;
	deps.approveMedia?.(still.path);

	return async (document) => {
		const asset: AxcutAsset = {
			id: createId("asset"),
			kind: "video",
			label: label?.trim() || path.basename(imagePath),
			originalPath: still.path,
			sizeBytes,
			cameraTrack: null,
			durationSec: holdSec,
			video: { codec: "h264", width: still.width, height: still.height, fps: 30 },
		};
		const next = documentWithAsset(document, asset);
		return {
			ok: true,
			resultJson: JSON.stringify({
				ok: true,
				assetId: asset.id,
				kind: "video",
				still: true,
				label: asset.label,
				durationSec: holdSec,
				width: still.width,
				height: still.height,
				primaryAssetId: next.project.primaryAssetId ?? null,
			}),
			document: next,
		};
	};
}
