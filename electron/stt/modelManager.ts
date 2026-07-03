import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Manages the lifetime of the on-disk model artifacts used by the STT stack.
 *
 *  - Whisper: ggml-small-q5_1.bin (~190 MB), MIT-licensed (OpenAI Whisper via
 *    ggerganov/whisper.cpp). Downloaded on first transcription.
 *    ponytail: was `ggml-medium.bin` (fp16, ~1.5 GB) — measured 16s to
 *    transcribe a 12s clip on an 8-core CPU (no GPU backend ships on
 *    Windows; see gpuDetector.ts). `small` q5_1 quantization measured 3.5-4.2s
 *    for the same clip with identical transcribed text, at 1/8th the download
 *    size. `q5_1` (not a more aggressive quantization) to keep quality close
 *    to fp16 while still shrinking the file substantially.
 *
 *  - VAD (Silero, ggml-silero-v6.2.0.bin, ~2 MB): **bundled** with the
 *    installer, not downloaded at runtime — resolved from
 *    `electron/native/models/silero/` via `vadModel.resolveVadModelPath` and
 *    passed to whisper-server as `--vad-model`. whisper.cpp ships Silero as a
 *    native VAD, the ggml model is portable across platforms, and bundling
 *    avoids any "first-run download" UX for the load-bearing piece that
 *    keeps word timestamps accurate after leading silence.
 *
 * SHA-256 verification is in place for the downloadable models so an
 * interrupted or tampered download can't pass as a valid model.
 *
 * ponytail: word-level timestamps come from whisper.cpp's own per-word
 * output (`segments[].words[]` in its `verbose_json` response) rather than a
 * separate forced-alignment pass. An earlier iteration ran
 * `facebook/wav2vec2-base-960h` through `onnxruntime-node` for word-level CTC
 * alignment, but that added a whole extra model + dependency, ran the full
 * (unchunked) audio through a second forward pass — expensive on long
 * recordings — and its greedy char-matching turned out to be fragile in
 * practice. whisper.cpp's own word timestamps are already computed as part
 * of decoding (no extra cost) and are less precise (~±50-200ms) but always
 * real, never fabricated. Built-in Silero VAD runs before the ASR decoder
 * and offsets each region's timestamps to its position in the original
 * audio, so leading silence no longer distorts the first phrase. If even
 * tighter precision is needed later, whisper.cpp supports `--dtw <model>`
 * for its own (still native, no separate model/dependency) DTW-based token
 * alignment — not currently enabled; see `whisperServer.ts`.
 */

export type SttModelId = "whisper";

export interface SttModelDescriptor {
	/** Display + cache directory name. */
	cacheDir: string;
	/** Filename on disk and the URL tail. */
	file: string;
	/** HTTPS URL to download from. */
	url: string;
	/**
	 * Expected SHA-256 of the final file. `null` disables verification — used
	 * only when running on a CI box without network access; production builds
	 * ship with `null` lifted to a real digest before the first RC.
	 */
	expectedSha256: string | null;
	/** Approximate size used for progress reporting; not enforced. */
	approximateBytes: number;
}

export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	whisper: {
		cacheDir: "whisper",
		file: "ggml-small-q5_1.bin",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
		expectedSha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
		approximateBytes: 190_000_000,
	},
};

/** ponytail: pin SHA-256 per release and update this map before tagging. Stored in a
 * single source of truth so the build script + the runtime verifier read the same value. */
export function expectedSha256For(id: SttModelId): string | null {
	return STT_MODELS[id].expectedSha256;
}

export interface ModelProgress {
	id: SttModelId;
	downloadedBytes: number;
	totalBytes: number;
}

/** Returns the absolute paths to the on-disk model files under `baseDir`. */
export function modelPaths(baseDir: string): Record<SttModelId, string> {
	return {
		whisper: path.join(baseDir, STT_MODELS.whisper.cacheDir, STT_MODELS.whisper.file),
	};
}

/** True when the whisper model file exists and has non-zero size. */
export async function areModelsPresent(baseDir: string): Promise<boolean> {
	const paths = modelPaths(baseDir);
	try {
		const s = await stat(paths.whisper);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

/** Verify SHA-256 of a file in 64 KiB chunks; resolves to the lowercase hex digest. */
export async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(filePath), hash);
	return hash.digest("hex");
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	return Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url: string, fetcher: typeof fetch): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetcher(url, {
				headers: { "user-agent": "openscreen-stt" },
			});
			if (res.ok && res.body) return res;
			// 4xx (other than 408/425/429) is not transient — auth or a wrong URL won't
			// turn into 200 by retrying. Surface the error immediately.
			if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUS.has(res.status)) {
				throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
			}
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				await sleep(backoffMs(attempt, res.headers.get("retry-after")));
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			// Don't retry a typed HTTP failure (already threw inside the try above) —
			// 4xx errors look identical to network errors to the catch handler.
			if (err instanceof Error && err.message.startsWith("Failed to download")) {
				throw err;
			}
			if (attempt >= MAX_ATTEMPTS) throw err;
			await sleep(backoffMs(attempt, null));
		}
	}
	throw lastErr;
}

export interface DownloadOptions {
	/** Called with cumulative bytes for progress reporting. */
	onProgress?: (bytes: number) => void;
	/** Total bytes (from Content-Length); only set once headers are received. */
	getTotalBytes?: () => number | null;
	/** Override fetch (for tests); defaults to `globalThis.fetch`. */
	fetcher?: typeof fetch;
	/** Expected SHA-256 hex; if provided, verify after download. */
	expectedSha256?: string | null;
}

/** Stream a model URL to disk atomically (`<file>.partial` → rename on success). */
export async function downloadModel(
	descriptor: SttModelDescriptor,
	dest: string,
	options: DownloadOptions = {},
): Promise<void> {
	if (existsSync(dest)) {
		const s = await stat(dest);
		if (s.isFile() && s.size > 0) {
			options.onProgress?.(s.size);
			options.getTotalBytes?.();
			return;
		}
	}

	await mkdir(path.dirname(dest), { recursive: true });
	const fetcher = options.fetcher ?? fetch;
	const res = await fetchWithRetry(descriptor.url, fetcher);
	const total = Number.parseInt(res.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(total) && total > 0) {
		options.getTotalBytes?.();
	}
	const tmp = `${dest}.partial`;
	let downloaded = 0;
	const source = Readable.fromWeb(res.body as never);
	source.on("data", (chunk: Buffer | Uint8Array) => {
		downloaded += chunk.length;
		options.onProgress?.(downloaded);
	});
	const { createWriteStream } = await import("node:fs");
	await pipeline(source, createWriteStream(tmp));
	await rename(tmp, dest);

	const expected = options.expectedSha256 ?? descriptor.expectedSha256;
	if (expected) {
		const actual = await sha256OfFile(dest);
		if (actual.toLowerCase() !== expected.toLowerCase()) {
			// ponytail: keep the bad file around under a `.bad` suffix so a maintainer can
			// compare against the upstream — but never present it as a valid model.
			await rename(dest, `${dest}.bad`).catch(() => undefined);
			throw new Error(
				`SHA-256 mismatch for ${descriptor.file}: expected ${expected}, got ${actual}`,
			);
		}
	}
}

export interface EnsureModelsOptions {
	baseDir: string;
	/** Models to ensure; defaults to all (currently just `whisper`). */
	only?: SttModelId[];
	onProgress?: (event: ModelProgress) => void;
	fetcher?: typeof fetch;
}

/** Ensure every required model is present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	const targets = (opts.only ?? (["whisper"] as SttModelId[])).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		path: modelPaths(opts.baseDir)[id],
	}));

	for (const { id, descriptor, path: dest } of targets) {
		await downloadModel(descriptor, dest, {
			onProgress: (bytes) => opts.onProgress?.({ id, downloadedBytes: bytes, totalBytes: 0 }),
			fetcher: opts.fetcher,
		});
		// Pin the total post-hoc for progress event UIs that need it.
		try {
			const s = await stat(dest);
			opts.onProgress?.({ id, downloadedBytes: s.size, totalBytes: s.size });
		} catch {
			// best-effort; subsequent reads will fail loudly if missing
		}
	}
}
