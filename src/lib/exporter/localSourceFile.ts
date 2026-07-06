import { MAX_IN_MEMORY_SOURCE_BYTES } from "./sourceFileLimits";

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
 * Concurrency: copies are deduplicated per cache entry — concurrent callers of
 * the same recording (e.g. the trim waveform and an export) share one in-flight
 * copy instead of racing two writables on the same OPFS handle. Each caller can
 * pass an `AbortSignal`; the underlying copy is aborted only once every joined
 * caller has aborted. Successful callers take one cache reference each and must
 * call {@link releaseLocalSourceFile} with the returned File's `.name`.
 *
 * Small recordings keep the original in-memory path — it is simpler and avoids
 * an extra on-disk copy for the common case.
 */

// Chunk size for streaming a large file into OPFS. Large enough to keep IPC
// overhead low, small enough that peak memory stays bounded.
const COPY_CHUNK_BYTES = 32 * 1024 * 1024;

const OPFS_CACHE_DIR = "openscreen-source-cache";

export interface MaterializeProgress {
	copiedBytes: number;
	totalBytes: number;
}

export interface MaterializeOptions {
	onProgress?: (progress: MaterializeProgress) => void;
	/** Aborts the wait; the shared copy stops once every joined caller aborts. */
	signal?: AbortSignal;
	/** Override the in-memory threshold (testing only). */
	thresholdBytes?: number;
	/** Override the OPFS copy chunk size (testing only). */
	chunkBytes?: number;
}

/**
 * Reference counts of OPFS cache entries currently read by a live demuxer, keyed
 * by cache-entry name (which equals the returned File's `.name`). Pruning never
 * removes a name with a live reference, so a concurrent export or caption pass
 * reading a different recording — or a different revision of the same one —
 * cannot have its copy deleted. Keying by cache name (not source URL) keeps
 * revisions independent: releasing one never touches another's count.
 */
const activeCacheRefs = new Map<string, number>();

/** One shared in-flight copy per cache entry; concurrent callers join it. */
interface InflightCopy {
	promise: Promise<void>;
	controller: AbortController;
	consumers: number;
	progressListeners: Set<(progress: MaterializeProgress) => void>;
	lastProgress?: MaterializeProgress;
}

const inflightCopies = new Map<string, InflightCopy>();

function retainCache(cacheName: string): void {
	activeCacheRefs.set(cacheName, (activeCacheRefs.get(cacheName) ?? 0) + 1);
}

/**
 * Releases a reference taken by {@link materializeLocalSourceFile}. Pass the
 * returned File's `.name`. No-op for small/remote sources, whose names were
 * never retained.
 */
export function releaseLocalSourceFile(cacheName: string): void {
	const refs = activeCacheRefs.get(cacheName);
	if (refs === undefined) return;
	if (refs <= 1) activeCacheRefs.delete(cacheName);
	else activeCacheRefs.set(cacheName, refs - 1);
}

/** Names that must survive pruning: referenced by a demuxer or mid-copy. */
function keepSet(): Set<string> {
	const keep = new Set(activeCacheRefs.keys());
	for (const name of inflightCopies.keys()) keep.add(name);
	return keep;
}

/**
 * Removes cache entries left behind by a previous session (or by exports whose
 * source was never materialized again). Call once at app startup: nothing is
 * referenced or mid-copy at that point, so everything stale is reclaimed.
 */
export async function clearStaleSourceCache(): Promise<void> {
	const getDirectory = navigator.storage?.getDirectory?.bind(navigator.storage);
	if (!getDirectory) return;
	try {
		const root = await getDirectory();
		const dir = await root.getDirectoryHandle(OPFS_CACHE_DIR);
		await pruneStaleEntries(dir, keepSet());
	} catch {
		// No cache directory yet — nothing to clean.
	}
}

const MIME_BY_EXTENSION: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
};

/** Infers a video MIME type from the file extension (recordings can be mp4 or webm). */
function mimeTypeForPath(p: string): string {
	const clean = p.toLowerCase().split(/[?#]/, 1)[0];
	const dot = clean.lastIndexOf(".");
	const ext = dot >= 0 ? clean.slice(dot + 1) : "";
	return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** Stable non-cryptographic hash for building a cache key from a path. */
function hashString(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Returns a `File` for a local recording path/URL, streaming large files through
 * OPFS so nothing multi-GB is ever held in memory.
 *
 * @param videoUrl  Local file path or `file://` URL of the recording.
 * @param filename  Preferred file name for the returned `File`.
 * @param options   Progress callback, abort signal, (testing) size overrides.
 */
export async function materializeLocalSourceFile(
	videoUrl: string,
	filename: string,
	options?: MaterializeOptions,
): Promise<File> {
	const api = window.electronAPI;
	if (!api) {
		throw new Error("Local source loading is only available in the desktop app.");
	}

	throwIfAborted(options?.signal);
	const threshold = options?.thresholdBytes ?? MAX_IN_MEMORY_SOURCE_BYTES;

	const info = await api.getReadableFileInfo(videoUrl);
	if (!info.success || typeof info.size !== "number") {
		throw new Error(info.message || info.error || "Failed to read source video");
	}
	throwIfAborted(options?.signal);

	// Common case: small enough to read in one shot.
	if (info.size <= threshold) {
		const result = await api.readBinaryFile(videoUrl);
		if (!result.success || !result.data) {
			throw new Error(result.message || result.error || "Failed to read source video");
		}
		throwIfAborted(options?.signal);
		const name = (result.path || filename).split(/[\\/]/).pop() || filename;
		return new File([result.data], name, { type: mimeTypeForPath(name) });
	}

	// Large recording: stream into OPFS and hand back a disk-backed File.
	// web-demuxer detects the container from content, so the File name is
	// irrelevant here — the OPFS entry keeps its cache-key name.
	return copyToOpfsFile(videoUrl, info.size, info.mtimeMs ?? 0, options);
}

async function copyToOpfsFile(
	videoUrl: string,
	size: number,
	mtimeMs: number,
	options?: MaterializeOptions,
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
	const signal = options?.signal;

	// Join (or start) the shared in-flight copy for this entry. Loop so a caller
	// that races a flight aborted by its last consumer can start a fresh one.
	for (;;) {
		throwIfAborted(signal);

		let flight = inflightCopies.get(cacheName);
		if (flight?.controller.signal.aborted) {
			await flight.promise.catch(() => undefined);
			continue;
		}
		if (!flight) {
			const controller = new AbortController();
			const fresh: InflightCopy = {
				controller,
				consumers: 0,
				progressListeners: new Set(),
				promise: Promise.resolve(),
			};
			// Register BEFORE starting the copy so its own name is in keepSet()
			// when the copy prunes, and so concurrent prunes keep mid-write entries.
			inflightCopies.set(cacheName, fresh);
			fresh.promise = runCopy(
				dir,
				cacheName,
				videoUrl,
				size,
				controller.signal,
				options?.chunkBytes ?? COPY_CHUNK_BYTES,
				(p) => {
					fresh.lastProgress = p;
					for (const listener of fresh.progressListeners) listener(p);
				},
			).finally(() => {
				if (inflightCopies.get(cacheName) === fresh) inflightCopies.delete(cacheName);
			});
			// A flight abandoned by every consumer would otherwise be an unhandled rejection.
			fresh.promise.catch(() => undefined);
			flight = fresh;
		}

		flight.consumers += 1;
		if (options?.onProgress) {
			flight.progressListeners.add(options.onProgress);
			if (flight.lastProgress) options.onProgress(flight.lastProgress);
		}
		const joined = flight;
		const onAbort = () => {
			joined.consumers -= 1;
			// Last interested caller gone: stop the underlying copy.
			if (joined.consumers <= 0) joined.controller.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await joined.promise;
			throwIfAborted(signal);
			const handle = await dir.getFileHandle(cacheName);
			const file = await handle.getFile();
			retainCache(cacheName);
			return file;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (options?.onProgress) joined.progressListeners.delete(options.onProgress);
			if (!signal?.aborted) joined.consumers -= 1;
		}
	}
}

/** Streams the source into the cache entry; resolves once it is complete on disk. */
async function runCopy(
	dir: FileSystemDirectoryHandle,
	cacheName: string,
	videoUrl: string,
	size: number,
	signal: AbortSignal,
	chunkBytes: number,
	emitProgress: (progress: MaterializeProgress) => void,
): Promise<void> {
	try {
		await pruneStaleEntries(dir, keepSet());

		const handle = await dir.getFileHandle(cacheName, { create: true });

		// Reuse a complete prior copy.
		const existing = await handle.getFile();
		if (existing.size === size) {
			emitProgress({ copiedBytes: size, totalBytes: size });
			return;
		}

		const writable = await handle.createWritable();
		try {
			let offset = 0;
			while (offset < size) {
				throwIfAborted(signal);
				const length = Math.min(chunkBytes, size - offset);
				const chunk = await window.electronAPI.readFileChunk(videoUrl, offset, length);
				if (!chunk.success || !chunk.data) {
					throw new Error(chunk.message || chunk.error || "Failed to read source video chunk");
				}
				// Guard against a short read that would otherwise loop forever.
				if (chunk.data.byteLength === 0) {
					throw new Error("Source video read returned no data before reaching the end.");
				}
				await writable.write(chunk.data);
				offset += chunk.data.byteLength;
				emitProgress({ copiedBytes: offset, totalBytes: size });
			}
			await writable.close();
		} catch (error) {
			try {
				await writable.abort();
			} catch {
				// ignore abort failure; surface the original error
			}
			throw error;
		}

		const file = await handle.getFile();
		if (file.size !== size) {
			throw new Error(
				`Streamed copy is incomplete (${file.size} of ${size} bytes); the source video may still be in use.`,
			);
		}
	} catch (error) {
		// Drop the partial copy so a retry does not resume from a corrupt file.
		// (No caller has retained this entry — retains happen only after success —
		// but keep the guard in case a prior complete copy of the same name is
		// still being read.)
		if (!activeCacheRefs.has(cacheName)) {
			try {
				await dir.removeEntry(cacheName);
			} catch {
				// ignore cleanup failure
			}
		}
		throw error;
	}
}

/** Removes cached copies in the directory whose names are not in `keep`. */
async function pruneStaleEntries(dir: FileSystemDirectoryHandle, keep: Set<string>): Promise<void> {
	// FileSystemDirectoryHandle async iteration is available in Chromium/Electron.
	const entries = (
		dir as unknown as {
			keys?: () => AsyncIterableIterator<string>;
		}
	).keys?.();
	if (!entries) return;
	const toRemove: string[] = [];
	for await (const name of entries) {
		if (!keep.has(name)) toRemove.push(name);
	}
	await Promise.all(toRemove.map((name) => dir.removeEntry(name).catch(() => undefined)));
}
