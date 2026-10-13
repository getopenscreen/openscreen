import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { DocumentNotFoundError } from "../ai-edition/document-service";
import type { OpenedVideo } from "./hidden-video";
import { FRAME_WIDTH, frameTimes, MAX_FRAMES } from "./media-tools";
import type { McpToolDeps } from "./openscreen-mcp-server";

function error(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

export function createProjectFrameToolRegistrar(deps: McpToolDeps): (server: McpServer) => void {
	const openVideo = deps.openVideo;
	if (!openVideo) return () => undefined;
	let busy = false;
	return (server) =>
		server.registerTool(
			"getFrames",
			{
				description:
					"Read still frames from a video asset in an OpenScreen project. These are frames of the original recording, not the edited preview or export. Omit projectId for the project open in the editor; omit assetId for its primary video. Times are seconds in that source video. At most 12 frames per call.",
				inputSchema: z.object({
					projectId: z.string().optional(),
					assetId: z.string().optional(),
					atSec: z.array(z.number().nonnegative()).max(MAX_FRAMES).optional(),
					count: z.number().int().min(1).max(MAX_FRAMES).optional(),
				}),
				annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			},
			async ({ projectId, assetId, atSec, count }) => {
				if (busy) return error("Frame extraction is already running. Try again when it finishes.");
				busy = true;
				try {
					const snapshot = await deps.host.snapshot();
					let rawDocument: unknown;
					if (projectId === undefined) {
						if (!snapshot) return error("No project is open in the OpenScreen editor.");
						rawDocument = snapshot.document;
					} else if (
						(snapshot?.document as { project?: { id?: unknown } } | null)?.project?.id === projectId
					) {
						rawDocument = snapshot?.document;
					} else {
						try {
							rawDocument = (await deps.projects.getProjectForUpdate(projectId)).document;
						} catch (cause) {
							if (cause instanceof DocumentNotFoundError)
								return error(`No project has the id "${projectId}".`);
							throw cause;
						}
					}
					const parsed = documentSchema.safeParse(rawDocument);
					if (!parsed.success) return error("The project could not be read.");
					const document = parsed.data;
					const selectedId = assetId ?? document.project.primaryAssetId;
					const asset = document.assets.find(
						(item) => item.id === selectedId && item.kind === "video",
					);
					if (!asset) return error("No matching video asset exists in this project.");

					let video: OpenedVideo;
					try {
						video = await openVideo(asset.originalPath);
					} catch {
						return error("OpenScreen could not decode this project's video asset.");
					}
					try {
						const times = frameTimes(video.durationSec, atSec ?? null, count ?? 6);
						const content: CallToolResult["content"] = [
							{
								type: "text",
								text: `${times.length} source frame(s) from asset ${asset.id}; ${video.width}x${video.height}, ${video.durationSec.toFixed(2)}s. These do not show edits.`,
							},
						];
						for (const time of times) {
							const frame = await video.capture(time, FRAME_WIDTH);
							content.push({ type: "text", text: `${time.toFixed(2)}s in source video` });
							content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
						}
						return { content };
					} catch {
						return error("OpenScreen could not capture frames from this project's video asset.");
					} finally {
						video.close();
					}
				} finally {
					busy = false;
				}
			},
		);
}
