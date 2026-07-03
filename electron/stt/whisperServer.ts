import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	access,
	constants as fsConstants,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { resolveBinaryPath } from "./gpuDetector";
import type { SttBackend, SttPhraseSegment, SttWordSegment } from "./transcriptionContract";

/** whisper-server takes no stdin and writes to stdout+stderr — match Node's return type. */
type WhisperChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Owns the long-lived `whisper-server` process used to recognize speech.
 *
 * Lifecycle:
 *   1. `start()` resolves the binary on disk via `gpuDetector.resolveBinaryPath`.
 *   2. Allocates a free localhost port, spawns `whisper-server -m <model> --port <p>`.
 *   3. Polls the server's HTTP root until 200 (whisper-server answers `GET /`).
 *   4. `transcribe(samples)` writes a temporary WAV and POSTs to `/inference`.
 *
 * Concurrency: simple single-flight queue — the second call awaits the first.
 * whisper-server handles one inference at a time anyway; serializing avoids
 * two transcriptions stepping on each other's uploads.
 */

export interface WhisperServerStartOptions {
	/** Absolute path to the ggml model file (small-q5_1.bin by default). */
	modelPath: string;
	/**
	 * Absolute path to the bundled Silero VAD model. Required — whisper-server
	 * is started with `--vad --vad-model <path>` to get reliable word-level
	 * timestamps across leading silence (otherwise the first ~5 words after a
	 * long silent stretch get compressed into the wrong window). See
	 * `vadModel.ts` for the resolution contract.
	 */
	vadModelPath: string;
	/** Externally-resolved binary path (skips gpuDetector on startup); null = auto. */
	binaryPath?: string | null;
	/** Externally-resolved backend (logs only); null = auto. */
	backend?: SttBackend | null;
}

export interface WhisperServerStatus {
	running: boolean;
	pid: number | null;
	port: number | null;
	backend: SttBackend | null;
	startedAtMs: number | null;
	lastError: string | null;
}

/**
 * Per-word entry inside a `verbose_json` segment. whisper.cpp computes these
 * as part of normal decoding (no separate model/pass) — precision is
 * ~±50-200ms, not frame-accurate, but always real. For tighter precision,
 * whisper-server supports a `--dtw <model>` flag (native DTW-based token
 * alignment, still no extra dependency) — not currently enabled; revisit if
 * word-level precision becomes a problem in practice.
 */
interface WhisperJsonWord {
	word?: string;
	start?: number;
	end?: number;
}

/**
 * Phrase segment as emitted by whisper-server's `/inference` JSON response.
 * `start`/`end` is the `verbose_json` shape (numbers, in `segments`); `timestamps`
 * is kept as a fallback for older/alternate whisper-server builds that emit
 * `transcription: [{ timestamps: { from, to } }]` instead.
 */
interface WhisperJsonSegment {
	text?: string;
	start?: number;
	end?: number;
	timestamps?: { from?: string | number; to?: string | number };
	words?: WhisperJsonWord[];
}

interface WhisperJsonResponse {
	segments?: WhisperJsonSegment[];
	transcription?: WhisperJsonSegment[];
	language?: string;
	detected_language?: string;
	result?: { language?: string };
}

export class WhisperServerManager {
	private process: WhisperChild | null = null;
	private port: number | null = null;
	private backend: SttBackend | null = null;
	private lastError: string | null = null;
	private startedAtMs: number | null = null;
	private inFlight: Promise<unknown> = Promise.resolve();

	/** Used for buffered stderr from the helper; surfaced on shutdown + poll failures. */
	private stderrTail = "";
	private readonly stderrTailMax = 64 * 1024;

	/** Allocate a free TCP port on the loopback interface; resolves to the picked port. */
	private static async pickFreePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer();
			server.unref();
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					server.close();
					reject(new Error("Could not allocate port"));
					return;
				}
				const port = addr.port;
				server.close(() => resolve(port));
			});
		});
	}

	/** Check the server's HTTP root for a 200; resolves once responsive. */
	private static async pollUntilReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		// 250ms pacing keeps the round-trip overhead under 1s while polling out to 30s.
		while (Date.now() < deadline) {
			try {
				const res = await fetch(baseUrl, { method: "GET" });
				if (res.ok) return;
			} catch {
				// not up yet
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`whisper-server at ${baseUrl} did not respond within ${timeoutMs}ms`);
	}

	private recordError(message: string): void {
		this.lastError = message;
	}

	/** True when a process is alive and a model is loaded. */
	get status(): WhisperServerStatus {
		return {
			running: this.process !== null && this.port !== null,
			pid: this.process?.pid ?? null,
			port: this.port,
			backend: this.backend,
			startedAtMs: this.startedAtMs,
			lastError: this.lastError,
		};
	}

	/**
	 * Spawn the helper if not running and return once `/` returns 200. Idempotent —
	 * if a server is already up we just return its port so the caller never pays
	 * the cold-start cost twice.
	 */
	async start(options: WhisperServerStartOptions): Promise<{ port: number; backend: SttBackend }> {
		if (this.process && this.port) {
			return { port: this.port, backend: this.backend ?? options.backend ?? "whisper-cpu" };
		}

		const resolved = options.binaryPath
			? { path: options.binaryPath, backend: options.backend ?? "whisper-cpu" }
			: await resolveBinaryPath();
		if (!resolved.path) {
			const message =
				"whisper-server binary not found; build it via scripts/build-whisper-binaries.sh";
			this.recordError(message);
			throw new Error(message);
		}
		try {
			// ponytail: on Windows, `fs.access(X_OK)` is a no-op that always rejects
			// because Windows doesn't expose POSIX execute bits. Trust the .exe
			// extension + `existsSync` and let `spawn` raise a real error if
			// something's wrong. On POSIX, the X_OK check still catches chmod-mistakes.
			if (process.platform !== "win32") {
				await access(resolved.path, fsConstants.X_OK);
			} else if (!existsSync(resolved.path)) {
				throw new Error("not found");
			}
		} catch {
			const message = `whisper-server binary at ${resolved.path} is not executable`;
			this.recordError(message);
			throw new Error(message);
		}
		if (!existsSync(options.modelPath)) {
			throw new Error(`Whisper model not found at ${options.modelPath}`);
		}
		if (!existsSync(options.vadModelPath)) {
			throw new Error(`Silero VAD model not found at ${options.vadModelPath}`);
		}

		const port = await WhisperServerManager.pickFreePort();
		const child = spawn(
			resolved.path,
			[
				"-m",
				options.modelPath,
				"--port",
				String(port),
				// whisper-server exposes `--host` (not `-h`; `-h` is the help flag).
				// Pin to localhost so future upstream defaults don't accidentally
				// expose the HTTP endpoint on 0.0.0.0.
				"--host",
				"127.0.0.1",
				// ponytail: whisper-server's own default is a hardcoded 4 threads,
				// regardless of the host's actual core count. Measured 16s → 11.5s
				// (-30%) on an 8-core/16-thread CPU just from raising this to the
				// logical core count — free, no quality tradeoff, unlike model size.
				"--threads",
				String(Math.max(1, os.cpus().length)),
				// ponytail: whisper-server expects WAV (16-bit LE PCM, 16 kHz mono)
				// already. We pre-convert in `writeSamplesAsWav`, so do NOT enable
				// `--convert` (which would require an ffmpeg runtime we don't ship).
				//
				// ponytail: VAD is required, not optional. whisper.cpp's built-in
				// Silero VAD runs before the ASR decoder, splits the audio into
				// speech regions, and only feeds those to the decoder. Word
				// timestamps come out already absolute because each region is
				// offset by its start in the original audio (no manual
				// offset arithmetic required from our side).
				//
				// ponytail: there is no "fallback to plain whisper.cpp" path. Earlier
				// iterations trimmed leading silence with a peak detector and then
				// added the trim back as an offset — the detector had false
				// positives (silent music intros, room tone) and was deleted. VAD
				// either runs or transcription refuses to start.
				"--vad",
				"--vad-model",
				options.vadModelPath,
				// ponytail: `--dtw <model>` (e.g. `--dtw small`) enables native
				// DTW-based token-level timestamp alignment — tighter precision than
				// the default cross-attention word timestamps we currently parse in
				// transcribeImpl(), still no extra model/dependency. Not enabled: the
				// default word timestamps have been accurate enough in testing with
				// VAD enabled. Revisit if word-level precision becomes a real
				// problem (e.g. captions/edits visibly drifting from speech).
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		this.process = child;
		this.port = port;
		this.backend = resolved.backend;
		this.startedAtMs = Date.now();
		this.stderrTail = "";
		this.lastError = null;

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			this.stderrTail = (this.stderrTail + text).slice(-this.stderrTailMax);
		});
		child.once("exit", (code) => {
			if (this.process === child) {
				const reason =
					code === null
						? "exited without code"
						: `exited with code ${code}; stderr=${this.stderrTail.slice(-512)}`;
				this.recordError(reason);
				this.process = null;
				this.port = null;
				this.startedAtMs = null;
			}
		});
		child.once("error", (err) => {
			this.recordError(`spawn error: ${err.message}`);
		});

		const baseUrl = `http://127.0.0.1:${port}`;
		try {
			await WhisperServerManager.pollUntilReady(baseUrl);
		} catch (err) {
			await this.stop();
			throw err instanceof Error ? err : new Error(String(err));
		}
		return { port, backend: resolved.backend };
	}

	/** Send SIGTERM and wait for the helper to exit. Resolves even if it was already down. */
	async stop(): Promise<void> {
		if (!this.process) {
			this.port = null;
			this.startedAtMs = null;
			return;
		}
		const child = this.process;
		this.process = null;
		this.port = null;
		this.startedAtMs = null;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.kill("SIGTERM");
		try {
			await Promise.race([
				exited,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000)),
			]);
		} catch {
			child.kill("SIGKILL");
		}
	}

	private baseUrl(): string {
		if (!this.port) throw new Error("whisper-server not started");
		return `http://127.0.0.1:${this.port}`;
	}

	private async ensureReady(): Promise<void> {
		if (!this.process || !this.port) {
			throw new Error("whisper-server not started; call start() first");
		}
	}

	private async runMultipartInfer(opts: {
		wavPath: string;
		language?: string;
	}): Promise<WhisperJsonResponse> {
		await this.ensureReady();
		const url = `${this.baseUrl()}/inference`;
		const form = new FormData();
		const fileBuffer = await readFile(opts.wavPath);
		const blob = new Blob([fileBuffer], { type: "audio/wav" });
		form.set("file", blob, path.basename(opts.wavPath));
		// ponytail: `response_format=json` only returns `{ text }` with no
		// per-segment timing at all — `verbose_json` is what actually populates
		// `segments`/`transcription`, which is what we parse below.
		form.set("response_format", "verbose_json");
		// ponytail: whisper-server's `--language` default is `en`, NOT auto-detect
		// (`whisper-server --help`: `[en     ] spoken language ('auto' for
		// auto-detect)`). If we leave the form field out, every audio gets decoded
		// as English — which on a French clip looks like English hallucination.
		// Our IPC contract promises "Omit / `auto` → Whisper detects" (see
		// `transcriptionContract.ts:48-52`); honor that by always sending a
		// value and translating both "not specified" and the literal "auto"
		// into the explicit `auto` keyword whisper-server expects.
		form.set("language", opts.language && opts.language !== "auto" ? opts.language : "auto");
		const res = await fetch(url, { method: "POST", body: form });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`whisper-server /inference HTTP ${res.status}: ${text.slice(0, 512)}`);
		}
		return (await res.json()) as WhisperJsonResponse;
	}

	/** One segment's `from`/`to` come from whisper-server as floats-in-strings ("0.000"). */
	private toSec(value: string | number | undefined, fallback: number): number {
		if (value === undefined) return fallback;
		const n = typeof value === "string" ? Number(value) : value;
		return Number.isFinite(n) ? n : fallback;
	}

	/** Run one transcription; serializes concurrent callers. */
	async transcribe(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
	}> {
		const task = this.inFlight.then(() => this.transcribeImpl(opts));
		// swallow rejection so the chain stays alive; callers await via `task` directly
		this.inFlight = task.catch(() => undefined);
		return task;
	}

	private async transcribeImpl(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
	}> {
		const wavPath = await writeSamplesAsWav(opts.samples);
		try {
			const json = await this.runMultipartInfer({ wavPath, language: opts.language });
			const raw = json.segments ?? json.transcription ?? [];
			const segments: SttPhraseSegment[] = raw
				.map((seg) => {
					const text = (seg.text ?? "").trim();
					const startSec = this.toSec(seg.start ?? seg.timestamps?.from, 0);
					const endSec = this.toSec(seg.end ?? seg.timestamps?.to, startSec + 0.5);
					return { text, startSec, endSec: Math.max(endSec, startSec + 0.05) };
				})
				.filter((s) => s.text.length > 0);
			// ponytail: when whisper.cpp runs with `--vad`, each speech region
			// gets transcribed in isolation, so the `segments[].words[]` timestamps
			// come back *relative to the cropped region* — NOT absolute. The
			// parent segment's bounds, on the other hand, are absolute.
			// Without composing word.start + parent_segment.start, the first
			// word after a long silent stretch lands at t=0 instead of where
			// the speech actually starts (verified against a 5s-silence clip:
			// raw "Hello" start = 0.03s, parent seg start = 5.51s, composed
			// absolute = 5.54s). The VAD model itself emits its segments in
			// absolute coords — we mirror that.
			//
			// When VAD is disabled (no longer supported by our pipeline but
			// tested independently), segments start at 0 and the offset is
			// harmless because it's a no-op.
			//
			// See the WhisperJsonWord doc comment for the precision tradeoff
			// (~±50-200ms even with VAD).
			const wordSegments: SttWordSegment[] = raw
				.flatMap((seg, idx) => {
					const segmentStartSec = segments[idx]?.startSec ?? 0;
					return (seg.words ?? []).map((w) => {
						const word = (w.word ?? "").trim();
						const wordLocalStart = this.toSec(w.start, 0);
						const wordLocalEnd = this.toSec(w.end, wordLocalStart + 0.05);
						const startSec = Math.max(0, wordLocalStart + segmentStartSec);
						const endSec = Math.max(startSec + 0.02, wordLocalEnd + segmentStartSec);
						return { word, startSec, endSec };
					});
				})
				.filter((w) => w.word.length > 0);
			const detectedLanguage =
				json.detected_language ?? json.language ?? json.result?.language ?? "auto";
			return { segments, wordSegments, detectedLanguage };
		} finally {
			await cleanupWav(wavPath);
		}
	}
}

/** Writes a 16-bit PCM mono 16 kHz WAV file and returns its path. */
export async function writeSamplesAsWav(samples: Float32Array): Promise<string> {
	const sampleRate = 16_000;
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataLength = samples.length * (bitsPerSample / 8);
	const fileLength = 44 + dataLength;

	const buf = Buffer.alloc(44 + dataLength);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(fileLength - 8, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(numChannels, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(byteRate, 28);
	buf.writeUInt16LE(blockAlign, 32);
	buf.writeUInt16LE(bitsPerSample, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(dataLength, 40);
	// 16-bit PCM conversion with hard clipping so a malformed input can't clip the writer.
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		buf.writeInt16LE(Math.round(s * 32_767), 44 + i * 2);
	}

	const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openscreen-stt-"));
	const outPath = path.join(tmpDir, "audio.wav");
	await writeFile(outPath, buf);
	return outPath;
}

/** Remove a wav file plus the directory `writeSamplesAsWav` created for it. */
export async function cleanupWav(wavPath: string): Promise<void> {
	const dir = path.dirname(wavPath);
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
