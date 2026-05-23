import { useEffect, useRef, useState } from "react";
import { loadFileAsArrayBuffer } from "@/lib/exporter/streamingDecoder";

let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

/**
 * Offloads peak computation to a Web Worker (zero-copy via Transferable).
 * Returns a Promise that resolves with the peaks Float32Array.
 */
function computePeaksInWorker(audioBuffer: AudioBuffer): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./audioPeaksWorker.ts", import.meta.url), {
			type: "module",
		});

		// slice() creates an owned copy so the transfer is safe and the
		// AudioBuffer remains valid if anything else holds a reference.
		const channels: Float32Array[] = [];
		for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
			channels.push(audioBuffer.getChannelData(c).slice());
		}

		worker.onmessage = (e: MessageEvent<Float32Array>) => {
			worker.terminate();
			resolve(e.data);
		};

		worker.onerror = (e) => {
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
 * Decodes audio from `videoUrl` and returns a Float32Array of paired
 * [min, max] peak values (length = 2 * N blocks). Returns `null` while
 * decoding is in progress, and stays `null` when the file has no audio
 * track or decoding fails (silent degradation).
 *
 * - File loading uses the Electron IPC bridge for local paths (same as the exporter).
 * - Peak computation runs in a Web Worker to avoid blocking the main thread.
 * - Results are cached in a ref scoped to the hook instance (survives re-renders
 *   and waveform toggle off/on, but not component unmount).
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

		let cancelled = false;

		(async () => {
			try {
				const arrayBuffer = await loadFileAsArrayBuffer(videoUrl);
				if (cancelled) return;
				const audioBuffer = await getAudioCtx().decodeAudioData(arrayBuffer);
				if (cancelled) return;
				const p = await computePeaksInWorker(audioBuffer);
				if (cancelled) return;
				cacheRef.current.set(videoUrl, p);
				setPeaks(p);
			} catch {
				// No audio track or unsupported format — silent degradation.
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [videoUrl]);

	return peaks;
}
