import fs from "node:fs/promises";

/**
 * Deletes the file a failed native start left, only while it is still empty.
 *
 * Every native helper may create its output before the first frame, so a start
 * that never began can leave a 0-byte mp4. Any byte on disk keeps the file: an
 * empty one holds nothing to lose. Never throws.
 */
export async function removeEmptyCaptureOutput(filePath: string): Promise<void> {
	try {
		const stats = await fs.stat(filePath);
		if (stats.isFile() && stats.size === 0) {
			await fs.rm(filePath, { force: true });
		}
	} catch {
		// Nothing there, or nothing we may remove: either way nothing is lost.
	}
}
