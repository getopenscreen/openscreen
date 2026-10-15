import { copyFileSync, renameSync, rmSync } from "node:fs";
import fs from "node:fs/promises";

/**
 * The Microsoft Store build is an MSIX package: Windows redirects its writes under AppData
 * into the package's private copy of the folder. A rename between that copy and the real
 * folder fails with EXDEV, even inside one directory (#1255). Copying then deleting is the
 * only way across. It is not atomic, so it is taken only when the rename cannot be. A
 * second staging copy beside the destination would not restore atomicity: the source
 * already is one, and its rename is the one that failed.
 *
 * Never for a case-only rename: on a case-insensitive disk both names are the same file,
 * and copying it onto itself then deleting the source would lose it.
 */
function mustCopyInstead(error: unknown, from: string, to: string): boolean {
	return (
		(error as NodeJS.ErrnoException)?.code === "EXDEV" && from.toLowerCase() !== to.toLowerCase()
	);
}

/**
 * The rename half of a temp-then-rename save. Windows fails a rename onto an open file with
 * EPERM/EBUSY: an indexer, an antivirus or a backup agent can hold the destination for a few
 * milliseconds after we last touched it. The write itself is sound, so retry briefly rather
 * than surface a save error the user cannot act on. POSIX renames don't hit this and take
 * the first attempt. EXDEV falls back to a copy, see `mustCopyInstead`.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
	const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			if (mustCopyInstead(error, from, to)) {
				await fs.copyFile(from, to);
				await fs.rm(from, { force: true });
				return;
			}
			const code = (error as NodeJS.ErrnoException)?.code ?? "";
			if (attempt >= 5 || !RETRYABLE.has(code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
		}
	}
}

/** `renameSync` with the same EXDEV fallback, for the saves that must stay synchronous. */
export function renameSyncWithFallback(from: string, to: string): void {
	try {
		renameSync(from, to);
	} catch (error) {
		if (!mustCopyInstead(error, from, to)) throw error;
		copyFileSync(from, to);
		rmSync(from, { force: true });
	}
}
