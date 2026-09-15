// Pre-flight free-space check for recording start. Before this, the app had
// no disk-space awareness anywhere: a recording could run for its full
// duration and only fail once the user tried to save it, discarding the
// take. Catching it before capture starts costs one statfs() call and saves
// a wasted recording.
import fs from "node:fs/promises";

/** Recording output is usually well under this; below it, a take is likely to run out mid-capture. */
export const LOW_DISK_SPACE_THRESHOLD_BYTES = 500 * 1024 * 1024;

export interface DiskSpaceStatus {
	/** Bytes free on the filesystem backing the recordings directory. */
	availableBytes: number;
	low: boolean;
}

/**
 * Checks free space on the filesystem that backs `dir`. Never throws — a
 * platform or filesystem that doesn't support statfs (or a directory that
 * doesn't exist yet) reports as not-low, since a bad check must never block
 * a recording that would otherwise have worked.
 */
export async function checkDiskSpace(
	dir: string,
	thresholdBytes: number = LOW_DISK_SPACE_THRESHOLD_BYTES,
): Promise<DiskSpaceStatus> {
	try {
		const stats = await fs.statfs(dir);
		const availableBytes = stats.bavail * stats.bsize;
		return { availableBytes, low: availableBytes < thresholdBytes };
	} catch {
		return { availableBytes: Number.POSITIVE_INFINITY, low: false };
	}
}
