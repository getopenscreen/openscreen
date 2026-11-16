import { randomUUID } from "node:crypto";
import { copyFileSync, renameSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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

/**
 * Replace `destination` with `data` through a staged file renamed over it: a failed write
 * leaves the file already there intact (#1104). The staging name is short, so a
 * destination name near the 255-byte limit still fits.
 *
 * The new file keeps the replaced file's mode, and its owner and group as far as we may
 * set them, as an in-place write would. The mode is set by chmod, not by `writeFile`'s
 * `mode`, which the umask masks (a 664 file came back 644). Best effort: a filesystem
 * without POSIX modes must not fail the save. Windows ACLs are not copied.
 */
export async function writeFileReplacing(destination: string, data: Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const partialPath = path.join(path.dirname(destination), `.openscreen-${randomUUID()}.partial`);
	const replaced = await fs.stat(destination).then(
		(stats) => (stats.isFile() ? stats : undefined),
		() => undefined,
	);
	try {
		await fs.writeFile(partialPath, data);
		if (replaced && process.platform !== "win32") {
			// Only root may give a file away; the group alone is allowed to any of our groups.
			await fs
				.chown(partialPath, replaced.uid, replaced.gid)
				.catch(() => fs.chown(partialPath, -1, replaced.gid))
				.catch(() => undefined);
			await fs.chmod(partialPath, replaced.mode & 0o777).catch(() => undefined);
		}
		await renameWithRetry(partialPath, destination);
	} catch (error) {
		await fs.rm(partialPath, { force: true });
		throw error;
	}
}
