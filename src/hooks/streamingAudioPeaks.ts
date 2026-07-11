import { WebDemuxer } from "web-demuxer";
import { audioDataFrameToMono } from "@/lib/captioning/extractMono16kWebDemuxer";

/**
 * Streaming trim-waveform peaks for recordings too large to load into memory.
 *
 * The default waveform path reads the whole file and runs `decodeAudioData`,
 * which needs the full bytes up front — impossible for multi-GB recordings.
 * This module demuxes the audio track with web-demuxer (which reads the File
 * on demand), decodes it chunk by chunk with WebCodecs `AudioDecoder`, and
 * folds every decoded frame straight into min/max peak buckets, closing the
 * frame immediately. Peak memory is the buckets array (≤ 24k blocks ≈ 192 kB)
 * plus a handful of in-flight frames, regardless of recording length.
 *
 * Output matches `audioPeaksWorker.ts` exactly: Float32Array of length 2*N,
 * `[min0, max0, min1, max1, ...]`, N = min(24000, ceil(duration * 200)), with
 * min/max starting from 0 (silence baseline) and channels averaged per sample.
 */

const DECODE_QUEUE_BACKPRESSURE = 20;
const LOAD_TIMEOUT_MS = 60_000;
const READ_END_PADDING_SEC = 0.5;
// Keep in sync with audioPeaksWorker.ts so both paths render identically.
const MAX_PEAK_BLOCKS = 24_000;
const PEAK_BLOCKS_PER_SEC = 200;
// Upper bound for the duration fallback scan when container metadata is
// unreliable (MediaRecorder WebM often reports 0/Infinity — see
// streamingDecoder's validateDuration). Same ceiling as the export scan.
const SCAN_UNBOUNDED_FALLBACK_SEC = 24 * 60 * 60;

/**
 * Ground-truth duration from audio packet timestamps, for containers whose
 * metadata duration is missing or bogus. Demux-only (no decode), so it is a
 * fast forward pass even for multi-GB files.
 */
async function scanAudioDurationSec(demuxer: WebDemuxer, signal?: AbortSignal): Promise<number> {
	const reader = demuxer.read("audio", 0, SCAN_UNBOUNDED_FALLBACK_SEC).getReader();
	let maxEndUs = 0;
	try {
		while (!signal?.aborted) {
			const { done, value: chunk } = await reader.read();
			if (done || !chunk) break;
			const endUs = chunk.timestamp + (chunk.duration ?? 0);
			if (endUs > maxEndUs) maxEndUs = endUs;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* already closed */
		}
	}
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	return maxEndUs / 1e6;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = window.setTimeout(() => reject(new Error(message)), ms);
		promise
			.then((v) => {
				window.clearTimeout(id);
				resolve(v);
			})
			.catch((e) => {
				window.clearTimeout(id);
				reject(e instanceof Error ? e : new Error(String(e)));
			});
	});
}

/**
 * Computes trim-waveform peaks from a (typically OPFS-backed) File without ever
 * holding the decoded PCM in memory. Throws on no/unsupported audio track; the
 * caller (useAudioPeaks) degrades to no waveform.
 */
export async function computePeaksFromFileStreaming(
	file: File,
	signal?: AbortSignal,
): Promise<Float32Array> {
	const wasmUrl = new URL("./wasm/web-demuxer.wasm", window.location.href).href;
	const demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });
	try {
		await withTimeout(
			demuxer.load(file),
			LOAD_TIMEOUT_MS,
			"Timed out while parsing the source video for the waveform.",
		);
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		const mediaInfo = await withTimeout(
			demuxer.getMediaInfo(),
			LOAD_TIMEOUT_MS,
			"Timed out while reading media info for the waveform.",
		);

		let audioConfig: AudioDecoderConfig;
		try {
			audioConfig = await demuxer.getDecoderConfig("audio");
		} catch {
			throw new Error("No audio track found in this video.");
		}
		const codecCheck = await AudioDecoder.isConfigSupported(audioConfig);
		if (!codecCheck.supported) {
			throw new Error(`Audio codec not supported for waveform: ${audioConfig.codec}`);
		}
		const sampleRate = audioConfig.sampleRate || 48_000;

		// MediaRecorder WebM often reports a missing/bogus container duration
		// (see streamingDecoder's validateDuration); fall back to a demux-only
		// packet-timestamp scan so those recordings still get a waveform.
		let durationSec =
			Number.isFinite(mediaInfo.duration) && mediaInfo.duration > 0 ? mediaInfo.duration : 0;
		if (durationSec <= 0) {
			durationSec = await scanAudioDurationSec(demuxer, signal);
		}
		if (durationSec <= 0) {
			throw new Error("Unknown duration; cannot bucket waveform peaks.");
		}

		const blocks = Math.min(MAX_PEAK_BLOCKS, Math.ceil(durationSec * PEAK_BLOCKS_PER_SEC));
		const totalSamples = Math.max(1, Math.ceil(durationSec * sampleRate));
		const peaks = new Float32Array(blocks * 2); // [min0, max0, min1, max1, ...]

		const foldFrame = (frame: AudioData) => {
			const startSample = Math.round((frame.timestamp / 1e6) * sampleRate);
			const mono = audioDataFrameToMono(frame);
			frame.close();
			for (let i = 0; i < mono.length; i++) {
				const pos = startSample + i;
				if (pos < 0 || pos >= totalSamples) continue;
				let block = Math.floor((pos / totalSamples) * blocks);
				if (block >= blocks) block = blocks - 1;
				const sample = mono[i];
				if (sample < peaks[block * 2]) peaks[block * 2] = sample;
				if (sample > peaks[block * 2 + 1]) peaks[block * 2 + 1] = sample;
			}
		};

		let decodedFrames = 0;
		let decodeError: DOMException | null = null;
		const decoder = new AudioDecoder({
			output: (data: AudioData) => {
				decodedFrames++;
				foldFrame(data);
			},
			error: (e: DOMException) => {
				decodeError = e;
			},
		});
		decoder.configure(audioConfig);

		try {
			const reader = demuxer.read("audio", 0, durationSec + READ_END_PADDING_SEC).getReader();
			try {
				while (!signal?.aborted && !decodeError) {
					const { done, value: chunk } = await reader.read();
					if (done || !chunk) break;
					decoder.decode(chunk);
					while (decoder.decodeQueueSize > DECODE_QUEUE_BACKPRESSURE && !signal?.aborted) {
						await new Promise((r) => setTimeout(r, 1));
					}
				}
			} finally {
				try {
					await reader.cancel();
				} catch {
					/* already closed */
				}
			}

			// Flush only on the clean path; an aborted or errored decode should
			// not wait for the full pipeline to drain.
			if (!signal?.aborted && !decodeError && decoder.state === "configured") {
				await decoder.flush();
			}
		} finally {
			// Always release the decoder — a throw in the demux loop must not
			// leak a configured AudioDecoder (they hold codec-native memory).
			if (decoder.state !== "closed") {
				try {
					decoder.close();
				} catch {
					/* already closed */
				}
			}
		}
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		if (decodeError) throw decodeError;
		if (decodedFrames === 0) {
			throw new Error("Decoded zero audio frames from this video.");
		}
		return peaks;
	} finally {
		try {
			demuxer.destroy();
		} catch {
			/* already destroyed */
		}
	}
}
