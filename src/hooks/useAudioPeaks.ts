import { useEffect, useRef, useState } from "react";
import { materializeLocalSourceFile, releaseLocalSourceFile } from "@/lib/exporter/localSourceFile";
import { MAX_IN_MEMORY_SOURCE_BYTES } from "@/lib/exporter/sourceFileLimits";
import { loadFileAsArrayBuffer } from "@/lib/exporter/streamingDecoder";
import { computePeaksFromFileStreaming } from "./streamingAudioPeaks";

let _audioCtx: AudioContext | null = null;
/** Returns the shared AudioContext, creating it lazily on first call. */
function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

/**
 * Offloads peak computation to a Web Worker (zero-copy via Transferable).
 * On abort, the worker is terminated and the promise rejects with AbortError.
 */
function computePeaksInWorker(
	audioBuffer: AudioBuffer,
	signal?: AbortSignal,
): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}

		const worker = new Worker(new URL("./audioPeaksWorker.ts", import.meta.url), {
			type: "module",
		});

		const onAbort = () => {
			worker.terminate();
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		// slice() creates an owned copy so the transfer is safe and the
		// AudioBuffer remains valid if anything else holds a reference.
		const channels: Float32Array[] = [];
		for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
			channels.push(audioBuffer.getChannelData(c).slice());
		}

		worker.onmessage = (e: MessageEvent<Float32Array>) => {
			signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			resolve(e.data);
		};

		worker.onerror = (e) => {
			signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			reject(e);
		};

		worker.postMessage(
			{ channels, duration: audioBuffer.duration },
			channels.map((ch) => ch.buffer),
		);
	});
}

/**
 * Routes to the right peaks pipeline for the source size. Small/remote files
 * use the original decodeAudioData → worker path. Local recordings above the
 * in-memory limit stream instead: the file is materialized into OPFS (reused by
 * the export afterwards) and its audio is decoded chunk-by-chunk into peaks, so
 * the whole recording is never held in memory.
 */
async function computePeaksForUrl(videoUrl: string, signal?: AbortSignal): Promise<Float32Array> {
	const isRemoteUrl = /^(https?:|blob:|data:)/i.test(videoUrl);
	if (!isRemoteUrl && window.electronAPI?.getReadableFileInfo) {
		const info = await window.electronAPI.getReadableFileInfo(videoUrl);
		if (info.success && typeof info.size === "number" && info.size > MAX_IN_MEMORY_SOURCE_BYTES) {
			const filename = (videoUrl.split(/[\\/]/).pop() || "video").replace(/^file:/, "");
			// signal also aborts the OPFS copy (unless the export shares it).
			const file = await materializeLocalSourceFile(videoUrl, filename, { signal });
			try {
				return await computePeaksFromFileStreaming(file, signal);
			} finally {
				releaseLocalSourceFile(file.name);
			}
		}
	}

	const { data: arrayBuffer } = await loadFileAsArrayBuffer(videoUrl);
	const audioBuffer = await getAudioCtx().decodeAudioData(arrayBuffer);
	return computePeaksInWorker(audioBuffer, signal);
}

/**
 * Decodes audio from `videoUrl` into paired [min, max] peaks (length = 2 * N
 * blocks). Returns `null` while decoding, and stays `null` on no audio track or
 * decode failure (silent degradation). Results are cached in a ref scoped to the
 * hook instance, so they survive re-renders and waveform toggles but not unmount.
 */
export function useAudioPeaks(videoUrl?: string): Float32Array | null {
	const cacheRef = useRef<Map<string, Float32Array>>(new Map());
	const [peaks, setPeaks] = useState<Float32Array | null>(() =>
		videoUrl ? (cacheRef.current.get(videoUrl) ?? null) : null,
	);

	useEffect(() => {
		if (!videoUrl) {
			setPeaks(null);
			return;
		}

		const cached = cacheRef.current.get(videoUrl);
		if (cached) {
			setPeaks(cached);
			return;
		}

		setPeaks(null);
		let cancelled = false;
		const controller = new AbortController();

		(async () => {
			try {
				const p = await computePeaksForUrl(videoUrl, controller.signal);
				if (cancelled) return;
				cacheRef.current.set(videoUrl, p);
				setPeaks(p);
			} catch (err) {
				// AbortError means the effect cleaned up, so no state update needed.
				if (err instanceof DOMException && err.name === "AbortError") return;
				// No audio track or unsupported format: degrade to no waveform, but log
				// so an unexpectedly-missing waveform is diagnosable.
				console.warn("useAudioPeaks: could not decode audio for waveform:", err);
				if (!cancelled) setPeaks(null);
			}
		})();

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [videoUrl]);

	return peaks;
}
