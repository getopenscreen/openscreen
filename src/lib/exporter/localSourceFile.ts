/**
 * Loads a local recording as a `File` suitable for `web-demuxer`, without ever
 * holding the whole recording in memory.
 *
 * The naive path — `electronAPI.readBinaryFile` → `new File([arrayBuffer])` —
 * breaks for long recordings in two ways:
 *   1. The main process reads with Node's `fs.readFile`, which throws
 *      `ERR_FS_FILE_TOO_LARGE` for any file above 2 GiB (a hard cap on a single
 *      read). A 2h 1080p60 recording is ~6-7 GB, so it can never be read.
 *   2. Even if it could, a multi-GB `ArrayBuffer`/`Blob` in the renderer would
 *      exhaust memory on typical machines (e.g. 16 GB RAM).
 *
 * `web-demuxer` reads a `File` on demand (it slices the file inside its worker),
 * so it does not need the bytes up front. For recordings above a safe threshold
 * we stream the file into an OPFS-backed file in fixed-size chunks and hand back
 * the disk-backed `File` from `getFile()`. Memory stays flat regardless of size.
 *
 * Small recordings keep the original in-memory path — it is simpler and avoids
 * an extra on-disk copy for the common case.
 */

// Stay comfortably under Node's 2 GiB single-read cap so read-binary-file never
// throws ERR_FS_FILE_TOO_LARGE. Anything larger is streamed via OPFS instead.
const LARGE_FILE_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024;

// Chunk size for streaming a large file into OPFS. Large enough to keep IPC
// overhead low, small enough that peak memory stays bounded.
const COPY_CHUNK_BYTES = 32 * 1024 * 1024;

const OPFS_CACHE_DIR = "openscreen-source-cache";

export interface MaterializeProgress {
	copiedBytes: number;
	totalBytes: number;
}

/** Stable non-cryptographic hash for building a cache key from a path. */
function hashString(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * Returns a `File` for a local recording path/URL, streaming large files through
 * OPFS so nothing multi-GB is ever held in memory.
 *
 * @param videoUrl  Local file path or `file://` URL of the recording.
 * @param filename  Preferred file name for the returned `File`.
 * @param onProgress  Optional progress callback for the large-file copy.
 */
export async function materializeLocalSourceFile(
	videoUrl: string,
	filename: string,
	onProgress?: (progress: MaterializeProgress) => void,
): Promise<File> {
	const api = window.electronAPI;
	if (!api) {
		throw new Error("Local source loading is only available in the desktop app.");
	}

	const info = await api.getReadableFileInfo(videoUrl);
	if (!info.success || typeof info.size !== "number") {
		throw new Error(info.message || info.error || "Failed to read source video");
	}

	// Common case: small enough to read in one shot.
	if (info.size <= LARGE_FILE_THRESHOLD_BYTES) {
		const result = await api.readBinaryFile(videoUrl);
		if (!result.success || !result.data) {
			throw new Error(result.message || result.error || "Failed to read source video");
		}
		const name = (result.path || filename).split(/[\\/]/).pop() || filename;
		return new File([result.data], name, { type: "video/mp4" });
	}

	// Large recording: stream into OPFS and hand back a disk-backed File.
	// web-demuxer detects the container from content, so the File name is
	// irrelevant here — the OPFS entry keeps its cache-key name.
	return copyToOpfsFile(videoUrl, info.size, info.mtimeMs ?? 0, onProgress);
}

async function copyToOpfsFile(
	videoUrl: string,
	size: number,
	mtimeMs: number,
	onProgress?: (progress: MaterializeProgress) => void,
): Promise<File> {
	const getDirectory = navigator.storage?.getDirectory?.bind(navigator.storage);
	if (!getDirectory) {
		throw new Error(
			"This recording is larger than 2 GB and cannot be exported: " +
				"local storage (OPFS) is unavailable to stream it.",
		);
	}

	const root = await getDirectory();
	const dir = await root.getDirectoryHandle(OPFS_CACHE_DIR, { create: true });

	// Cache key ties the copy to this exact file revision so repeated exports of
	// the same recording reuse the cached copy instead of re-streaming gigabytes.
	const cacheName = `${hashString(videoUrl)}-${size}-${Math.round(mtimeMs)}.bin`;

	await pruneStaleEntries(dir, cacheName);

	const handle = await dir.getFileHandle(cacheName, { create: true });

	// Reuse a complete prior copy.
	const existing = await handle.getFile();
	if (existing.size === size) {
		onProgress?.({ copiedBytes: size, totalBytes: size });
		return existing;
	}

	const writable = await handle.createWritable();
	try {
		let offset = 0;
		while (offset < size) {
			const length = Math.min(COPY_CHUNK_BYTES, size - offset);
			const chunk = await window.electronAPI.readFileChunk(videoUrl, offset, length);
			if (!chunk.success || !chunk.data) {
				throw new Error(chunk.message || chunk.error || "Failed to read source video chunk");
			}
			await writable.write(chunk.data);
			offset += chunk.data.byteLength;
			onProgress?.({ copiedBytes: offset, totalBytes: size });
			// Guard against a short read that would otherwise loop forever.
			if (chunk.data.byteLength === 0) {
				throw new Error("Source video read returned no data before reaching the end.");
			}
		}
		await writable.close();
	} catch (error) {
		try {
			await writable.abort();
		} catch {
			// ignore abort failure; surface the original error
		}
		// Drop the partial copy so a retry does not resume from a corrupt file.
		try {
			await dir.removeEntry(cacheName);
		} catch {
			// ignore cleanup failure
		}
		throw error;
	}

	const file = await handle.getFile();
	if (file.size !== size) {
		throw new Error(
			`Streamed copy is incomplete (${file.size} of ${size} bytes); the source video may still be in use.`,
		);
	}
	return file;
}

/** Removes any cached copies in the directory other than the current key. */
async function pruneStaleEntries(dir: FileSystemDirectoryHandle, keepName: string): Promise<void> {
	// FileSystemDirectoryHandle async iteration is available in Chromium/Electron.
	const entries = (
		dir as unknown as {
			keys?: () => AsyncIterableIterator<string>;
		}
	).keys?.();
	if (!entries) return;
	const toRemove: string[] = [];
	for await (const name of entries) {
		if (name !== keepName) toRemove.push(name);
	}
	await Promise.all(toRemove.map((name) => dir.removeEntry(name).catch(() => undefined)));
}
