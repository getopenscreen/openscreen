import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { renameWithRetry } from "../atomic-rename";

/**
 * Manages the lifetime of the on-disk model artifact used by the STT stack.
 *
 * The model is a single GGML file downloaded from HuggingFace
 * (`ggerganov/whisper.cpp` — the model-file repo predates and is separate
 * from the `ggml-org` GitHub org the engine itself now lives under;
 * `ggml-org/whisper.cpp` on HuggingFace is a different, access-gated repo
 * and returns 401 on every file including README.md — confirmed by curl).
 * whisper.cpp bakes precision into the file, so
 * there is no runtime `--int8` flag; OpenScreen ships the q8_0 quantized
 * `small` multilingual model by default.
 *
 * The file is verified by SHA-256 and written atomically (via .partial rename)
 * to prevent partial downloads from being treated as complete.
 *
 * Word timestamps come from whisper.cpp's native DTW token timestamps. The
 * Silero VAD model only decides which audio whisper decodes, and gives the
 * speech edges phrases are anchored on. The CTC aligners (`CTC_ALIGNERS`) re-time
 * the words for the languages that have one, and are fetched only when a
 * transcription detects such a language. See `technical-documentation/architecture/transcription-and-captions.md`.
 */

export type SttModelId = "whisper" | "silero-vad";

export interface SttModelFile {
	/** Relative path within the model directory (e.g. "ggml-small-q8_0.bin"). */
	name: string;
	/** HuggingFace resolve URL for this file. */
	url: string;
	/** Expected SHA-256 hex digest; null to skip verification. */
	expectedSha256: string | null;
	/** Approximate download size in bytes (for progress reporting). */
	approximateBytes: number;
}

export interface SttModelDescriptor {
	/** Display + cache directory name. */
	cacheDir: string;
	/** HuggingFace repo identifier (e.g. "ggerganov/whisper.cpp"). */
	repoId: string;
	/** List of model files to download (currently a single GGML file). */
	files: SttModelFile[];
}

const MODEL_BASE = "https://huggingface.co";
// ponytail: this is deliberately NOT "ggml-org/whisper.cpp" — that HF repo
// (matching the GitHub org the engine now lives under) is access-gated and
// returns 401 Unauthorized on every file, confirmed by curl. whisper.cpp's
// own models/download-ggml-model.sh pulls from ggerganov/whisper.cpp, the
// long-standing public model-file repo that never moved when the engine's
// GitHub org was renamed.
const MODEL_REPO = "ggerganov/whisper.cpp";
const MODEL_FILE = "ggml-small-q8_0.bin";
// Pinned to a commit rather than `main` so `expectedSha256` is an invariant and
// not a bet: `main` is a mutable branch pointer, and a re-upload under it would
// now invalidate every cache in the field at once instead of merely breaking new
// installs. This revision was checked against HuggingFace's paths-info API — its
// LFS oid for MODEL_FILE is exactly the digest below.
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";

const VAD_REPO = "ggml-org/whisper-vad";
const VAD_FILE = "ggml-silero-v6.2.0.bin";
const VAD_REVISION = "9ffd54a1e1ee413ddf265af9913beaf518d1639b";

export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	whisper: {
		cacheDir: "whisper-ggml",
		repoId: MODEL_REPO,
		files: [
			{
				name: MODEL_FILE,
				url: `${MODEL_BASE}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE}`,
				expectedSha256: "49C8FB02B65E6049D5FA6C04F81F53B867B5EC9540406812C643F177317F779F",
				approximateBytes: 264_000_000,
			},
		],
	},
	"silero-vad": {
		cacheDir: "whisper-ggml",
		repoId: VAD_REPO,
		files: [
			{
				name: VAD_FILE,
				url: `${MODEL_BASE}/${VAD_REPO}/resolve/${VAD_REVISION}/${VAD_FILE}`,
				expectedSha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
				approximateBytes: 885_098,
			},
		],
	},
};

/**
 * The CTC aligners that re-time whisper's words (electron/stt/ctcAlign.ts), per
 * language whisper reports. A language missing here keeps whisper's DTW times.
 *
 * Each file is a wav2vec2 CTC model converted to GGUF by
 * `scripts/convert-wav2vec2-gguf.mjs` (deterministic: re-running it on the source
 * named in `source` reproduces the digest below), then published under a `v0.0.0-*`
 * release tag like the other binaries that need a permanent URL but are not a
 * product version (see scripts/fetch-onnxruntime.mjs). Apache-2.0, both of them.
 */
const ALIGNER_RELEASE =
	"https://github.com/getopenscreen/openscreen/releases/download/v0.0.0-ctc-aligners-1";

export interface CtcAlignerFile extends SttModelFile {
	/** HuggingFace repo and revision the file was converted from. */
	source: string;
}

export const CTC_ALIGNERS: Record<string, CtcAlignerFile> = {
	en: {
		name: "w2v-en-base-q8_0.gguf",
		url: `${ALIGNER_RELEASE}/w2v-en-base-q8_0.gguf`,
		expectedSha256: "b7f21a97208f368d3505bd9a7bc9ff3795b1169d8e3b036028082eb25eb464ae",
		approximateBytes: 109_040_064,
		source: "facebook/wav2vec2-base-960h@22aad52d435eb6dbaf354bdad9b0da84ce7d6156",
	},
	fr: {
		name: "w2v-fr-large-q8_0.gguf",
		url: `${ALIGNER_RELEASE}/w2v-fr-large-q8_0.gguf`,
		expectedSha256: "e3c284da3e27564db07ac226bf6402a4d7856b806455b3e0f5283f29f9495f48",
		approximateBytes: 348_037_120,
		// The repo's safetensors conversion PR: main only has pytorch_model.bin.
		source: "jonatasgrosman/wav2vec2-large-xlsr-53-french@70db24a266633ffcc8edce4e72f3a5cb69d602d6",
	},
};

const ALIGNER_DIR = "ctc-aligner";

/** Where the aligner for `language` lives, or null when there is none for it. */
export function alignerPath(baseDir: string, language: string): string | null {
	const file = Object.keys(CTC_ALIGNERS).includes(language) ? CTC_ALIGNERS[language] : null;
	return file ? path.join(baseDir, ALIGNER_DIR, file.name) : null;
}

/**
 * The aligner for `language` when it is already on disk and intact, without
 * touching the network: null when it is missing, corrupt, or the language has
 * none. A local read, so a transcription can afford to wait for it.
 */
export async function cachedAligner(baseDir: string, language: string): Promise<string | null> {
	const filePath = alignerPath(baseDir, language);
	if (!filePath || !existsSync(filePath)) return null;
	const actual = await sha256OfFile(filePath).catch(() => "");
	return actual === CTC_ALIGNERS[language].expectedSha256 ? filePath : null;
}

/** Abort an aligner download that receives no bytes for this long. */
export const ALIGNER_STALL_MS = 30_000;

/**
 * Make sure the aligner for `language` is on disk, downloading and verifying it
 * like the whisper model. Null when the language has none; throws when the
 * download fails, stalls for `stallMs` or is aborted through `signal`, which the
 * caller turns into "keep whisper's times".
 */
export async function ensureAligner(opts: {
	baseDir: string;
	language: string;
	signal?: AbortSignal;
	stallMs?: number;
	fetcher?: typeof fetch;
}): Promise<string | null> {
	const filePath = alignerPath(opts.baseDir, opts.language);
	if (!filePath) return null;
	const file = CTC_ALIGNERS[opts.language];
	await ensureFile(filePath, file.url, file.expectedSha256, {
		fetcher: opts.fetcher,
		signal: opts.signal,
		stallMs: opts.stallMs ?? ALIGNER_STALL_MS,
	});
	return filePath;
}

export function modelPaths(baseDir: string): Record<SttModelId, string> {
	return {
		whisper: path.join(baseDir, STT_MODELS.whisper.cacheDir, MODEL_FILE),
		"silero-vad": path.join(baseDir, STT_MODELS["silero-vad"].cacheDir, VAD_FILE),
	};
}

/**
 * True when the GGML model files exist and are non-empty.
 */
export async function areModelsPresent(
	baseDir: string,
	only: SttModelId[] = ["whisper", "silero-vad"],
): Promise<boolean> {
	const paths = modelPaths(baseDir);
	try {
		const results = await Promise.all(
			only.map(async (id) => {
				const s = await stat(paths[id]);
				return s.isFile() && s.size > 0;
			}),
		);
		return results.every(Boolean);
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
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

/**
 * `signal` aborts the request and the waits between attempts; `waiting` is told
 * when a backoff starts and ends, so a stall timer does not count it.
 */
async function fetchWithRetry(
	url: string,
	fetcher: typeof fetch,
	signal?: AbortSignal,
	waiting: (yes: boolean) => void = () => undefined,
): Promise<Response> {
	let lastErr: unknown;
	const backoff = async (ms: number) => {
		waiting(true);
		await sleep(ms, signal);
		waiting(false);
	};
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetcher(url, {
				headers: { "user-agent": "openscreen-stt" },
				signal,
			});
			if (res.ok && res.body) return res;
			if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUS.has(res.status)) {
				throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
			}
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				await backoff(backoffMs(attempt, res.headers.get("retry-after")));
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			if (err instanceof Error && err.message.startsWith("Failed to download")) {
				throw err;
			}
			if (signal?.aborted || attempt >= MAX_ATTEMPTS) throw signal?.reason ?? err;
			await backoff(backoffMs(attempt, null));
		}
	}
	throw lastErr;
}

export interface DownloadOptions {
	/** Called with cumulative bytes for progress reporting. */
	onProgress?: (bytes: number) => void;
	/** Override fetch (for tests); defaults to `globalThis.fetch`. */
	fetcher?: typeof fetch;
	/** Aborts the download (and the waits between attempts). */
	signal?: AbortSignal;
	/** Abort when no byte arrives for this long, backoffs aside. Off when unset. */
	stallMs?: number;
}

/**
 * Stream a model file to disk atomically (<filename>.partial → rename on
 * success), optionally verify the SHA-256.
 *
 * If the file already exists, is non-empty, and matches the expected hash,
 * skips the download; otherwise a replacement is fetched and the stale copy is
 * only displaced once that replacement has itself been verified.
 */
async function ensureFile(
	filePath: string,
	fileUrl: string,
	expectedSha256: string | null,
	options: DownloadOptions = {},
): Promise<void> {
	if (existsSync(filePath)) {
		const s = await stat(filePath);
		if (s.isFile() && s.size > 0) {
			if (!expectedSha256) return;
			const actual = await sha256OfFile(filePath);
			if (actual.toLowerCase() === expectedSha256.toLowerCase()) return;
			// Deliberately leave the stale file where it is. Moving it aside now
			// would buy nothing — the rename at the end of this function is already
			// atomic, so there is no window to close — while costing the user their
			// only model if the replacement never lands (offline, HF 5xx, ENOSPC)
			// and stranding 264 MB that nothing ever cleans up.
		}
	}

	await mkdir(path.dirname(filePath), { recursive: true });

	const fetcher = options.fetcher ?? fetch;
	const tmp = `${filePath}.partial`;
	// One controller for the caller's abort and the stall timer: a connection that
	// stops sending leaves `pipeline` pending forever, with nothing else to end it.
	const controller = new AbortController();
	const onAbort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) onAbort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let stall: ReturnType<typeof setTimeout> | undefined;
	const arm = (on = true) => {
		clearTimeout(stall);
		if (!on || !options.stallMs) return;
		const ms = options.stallMs;
		stall = setTimeout(
			() => controller.abort(new Error(`download stalled: no data for ${ms / 1000}s`)),
			ms,
		);
	};
	try {
		arm();
		const res = await fetchWithRetry(fileUrl, fetcher, controller.signal, (waiting) =>
			arm(!waiting),
		);
		let downloaded = 0;
		const source = Readable.fromWeb(res.body as never);
		source.on("data", (chunk: Buffer | Uint8Array) => {
			arm();
			downloaded += chunk.length;
			options.onProgress?.(downloaded);
		});
		const { createWriteStream } = await import("node:fs");
		await pipeline(source, createWriteStream(tmp), { signal: controller.signal });
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined);
		throw controller.signal.aborted ? (controller.signal.reason ?? error) : error;
	} finally {
		arm(false);
		options.signal?.removeEventListener("abort", onAbort);
	}

	if (expectedSha256) {
		const actual = await sha256OfFile(tmp);
		if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
			// Drop the bad download and keep whatever was already on disk: when both
			// copies mismatch, the bytes the user has been running are exactly the
			// ones worth diagnosing. The cleanup is guarded because a Windows AV
			// scanner still holding the handle raises EPERM/EBUSY, and that bare
			// errno would escape in place of the mismatch message below.
			await rm(tmp, { force: true }).catch(() => undefined);
			throw new Error(
				`SHA-256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`,
			);
		}
	}
	await renameWithRetry(tmp, filePath);
}

export interface EnsureModelsOptions {
	baseDir: string;
	/** Models to ensure; defaults to all (`whisper`, `silero-vad`). */
	only?: SttModelId[];
	onProgress?: (event: {
		id: SttModelId;
		file: string;
		downloadedBytes: number;
		totalBytes: number;
	}) => void;
	fetcher?: typeof fetch;
}

/** Ensure the GGML model files are present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	const targets = (opts.only ?? (["whisper", "silero-vad"] as SttModelId[])).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		filePath: modelPaths(opts.baseDir)[id],
	}));

	for (const { id, descriptor, filePath } of targets) {
		await mkdir(path.dirname(filePath), { recursive: true });

		const file = descriptor.files[0];
		await ensureFile(filePath, file.url, file.expectedSha256, {
			onProgress: (bytes) =>
				opts.onProgress?.({
					id,
					file: file.name,
					downloadedBytes: bytes,
					totalBytes: file.approximateBytes,
				}),
			fetcher: opts.fetcher,
		});
	}
}
