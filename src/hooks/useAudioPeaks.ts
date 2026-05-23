import { useEffect, useState } from "react";

// Module-level cache keyed by URL — survives re-mounts within the same page session.
const peaksCache = new Map<string, Float32Array>();

let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
	if (!_audioCtx) _audioCtx = new AudioContext();
	return _audioCtx;
}

function computePeaks(audioBuffer: AudioBuffer): Float32Array {
	const N = Math.min(24000, Math.ceil(audioBuffer.duration * 200));
	const nCh = audioBuffer.numberOfChannels;
	const totalSamples = audioBuffer.length;
	const blockSize = totalSamples / N;
	const peaks = new Float32Array(N * 2); // [min0, max0, min1, max1, …]

	const channels: Float32Array[] = [];
	for (let c = 0; c < nCh; c++) channels.push(audioBuffer.getChannelData(c));

	for (let i = 0; i < N; i++) {
		const start = Math.floor(i * blockSize);
		const end = Math.floor((i + 1) * blockSize);
		let minVal = 0;
		let maxVal = 0;
		for (let j = start; j < end; j++) {
			let sample = 0;
			for (let c = 0; c < nCh; c++) sample += channels[c][j];
			sample /= nCh;
			if (sample < minVal) minVal = sample;
			if (sample > maxVal) maxVal = sample;
		}
		peaks[i * 2] = minVal;
		peaks[i * 2 + 1] = maxVal;
	}

	return peaks;
}

/**
 * Decodes audio from `videoUrl` and returns a Float32Array of paired
 * [min, max] peak values (length = 2 * N blocks). Returns `null` while
 * decoding is in progress, and stays `null` when the file has no audio
 * track or decoding fails (silent degradation).
 *
 * Results are cached at module scope by URL so re-mounts are free.
 */
export function useAudioPeaks(videoUrl?: string): Float32Array | null {
	const [peaks, setPeaks] = useState<Float32Array | null>(() =>
		videoUrl ? (peaksCache.get(videoUrl) ?? null) : null,
	);

	useEffect(() => {
		if (!videoUrl) {
			setPeaks(null);
			return;
		}

		const cached = peaksCache.get(videoUrl);
		if (cached) {
			setPeaks(cached);
			return;
		}

		let cancelled = false;

		(async () => {
			try {
				const response = await fetch(videoUrl);
				if (cancelled) return;
				const arrayBuffer = await response.arrayBuffer();
				if (cancelled) return;
				const audioBuffer = await getAudioCtx().decodeAudioData(arrayBuffer);
				if (cancelled) return;
				const p = computePeaks(audioBuffer);
				peaksCache.set(videoUrl, p);
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
