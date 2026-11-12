// The renderer's side of Google Drive sync: hand a project's video to the main process, which
// decides whether to upload it (sync on, the project not unsynced) and into which Drive file.
//
// Never throws. A recording or an export has already succeeded locally by the time this runs,
// and a failed upload must not turn that into a failure: the caller gets "failed" and says so.

import { nativeBridgeClient } from "@/native/client";

export type DriveSyncOutcome = "uploaded" | "skipped" | "failed";

export async function syncProjectVideoToDrive(
	projectId: string,
	title: string,
	videoPath: string,
): Promise<DriveSyncOutcome> {
	try {
		const result = await nativeBridgeClient.drive.syncProject(projectId, title, videoPath);
		return result.uploaded ? "uploaded" : "skipped";
	} catch (error) {
		console.warn("[drive] upload failed:", error);
		// Only an answer from the main process is an upload that failed. No bridge at all, or one
		// without Drive (the headless CLI), means there is no Drive to sync to: nothing to report.
		// Read off the error rather than `instanceof NativeBridgeRequestError`, which only
		// answers for the one class instance and not across a mocked or re-bundled module.
		const code = (error as { code?: unknown } | null)?.code;
		const driveAnswered =
			typeof code === "string" && code !== "UNAVAILABLE" && code !== "UNSUPPORTED_ACTION";
		return driveAnswered ? "failed" : "skipped";
	}
}
