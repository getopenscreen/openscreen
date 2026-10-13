import { BrowserWindow, type IpcMain } from "electron";
import { parseSrtTranscript } from "../../src/lib/ai-edition/document/srtImport";
import {
	exportSourceAudioFile,
	exportSourceSrtFile,
	inspectSourceAudio,
	sourceAudioExtension,
	unusedExportPath,
} from "../media/sourceExport";
import type {
	SourceAudioExportRequest,
	SourceExportResult,
	SourceSrtExportRequest,
} from "../media/sourceExportContract";
import { showSaveDialogOver } from "../messageBox";

export function registerSourceExportHandlers(
	ipc: Pick<IpcMain, "handle">,
	readableApprovedPath: (filePath: string) => string | null,
): void {
	const active = new Map<number, AbortController>();
	ipc.handle("source-audio:cancel", (event) => {
		active.get(event.sender.id)?.abort();
	});
	ipc.handle(
		"source-audio:export",
		async (event, request: SourceAudioExportRequest): Promise<SourceExportResult> => {
			if (active.has(event.sender.id))
				return { success: false, error: "An audio export is already running." };
			const controller = new AbortController();
			active.set(event.sender.id, controller);
			const cancel = () => controller.abort();
			event.sender.once("destroyed", cancel);
			try {
				if (
					!request ||
					typeof request.sourcePath !== "string" ||
					!["original", "wav", "m4a"].includes(request.format)
				) {
					throw new Error("Invalid audio export request.");
				}
				const sourcePath = readableApprovedPath(request.sourcePath);
				if (!sourcePath) throw new Error("The source file is not approved for reading.");
				const codec = await inspectSourceAudio(sourcePath, controller.signal);
				const extension = sourceAudioExtension(request.format, codec);
				const suffix =
					request.format === "original"
						? "-audio-original"
						: request.format === "wav"
							? "-audio-uncompressed"
							: "-audio-compressed";
				const selected = await showSaveDialogOver(BrowserWindow.fromWebContents(event.sender), {
					defaultPath: await unusedExportPath(sourcePath, suffix, extension),
					filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
					properties: ["createDirectory", "showOverwriteConfirmation"],
				});
				if (selected.canceled || !selected.filePath || controller.signal.aborted)
					return { success: false, canceled: true };
				await exportSourceAudioFile(
					{ sourcePath, outputPath: selected.filePath, format: request.format, codec },
					{ signal: controller.signal },
				);
				return { success: true, path: selected.filePath };
			} catch (error) {
				if (controller.signal.aborted) return { success: false, canceled: true };
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			} finally {
				event.sender.removeListener("destroyed", cancel);
				active.delete(event.sender.id);
			}
		},
	);
	ipc.handle(
		"source-srt:export",
		async (event, request: SourceSrtExportRequest): Promise<SourceExportResult> => {
			try {
				if (
					!request ||
					typeof request.sourcePath !== "string" ||
					typeof request.srtText !== "string" ||
					(request.scope !== undefined &&
						request.scope !== "source" &&
						request.scope !== "timeline") ||
					Buffer.byteLength(request.srtText, "utf8") > 5 * 1024 * 1024
				) {
					throw new Error("Invalid SRT export request (maximum 5 MiB).");
				}
				const sourcePath = readableApprovedPath(request.sourcePath);
				if (!sourcePath) throw new Error("The source file is not approved for reading.");
				parseSrtTranscript("export-validation", request.srtText);
				const selected = await showSaveDialogOver(BrowserWindow.fromWebContents(event.sender), {
					defaultPath: await unusedExportPath(
						sourcePath,
						request.scope === "timeline" ? "-timeline-subtitles" : "-subtitles",
						"srt",
					),
					filters: [{ name: "SRT", extensions: ["srt"] }],
					properties: ["createDirectory", "showOverwriteConfirmation"],
				});
				if (selected.canceled || !selected.filePath) return { success: false, canceled: true };
				await exportSourceSrtFile(sourcePath, selected.filePath, request.srtText);
				return { success: true, path: selected.filePath };
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}
