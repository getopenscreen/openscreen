// Pitch-preserving audio time-stretch (WSOLA) used by the offline export path for
// speed regions faster than the browser's 16× playbackRate ceiling.
//
// WSOLA (Waveform Similarity Overlap-Add) resamples the *time* axis while leaving
// the frequency content — and therefore the pitch — untouched: it slides a
// windowed grain along the input at the analysis hop (speed × synthesis hop) and
// overlap-adds it at the fixed synthesis hop, nudging each grain by up to a search
// radius to the position that best continues the previous output (avoiding the
// phase-cancellation clicks of plain overlap-add).
//
// The stretcher is streaming: push() feeds decoded PCM incrementally and returns
// finished output, so a multi-hour region never has to be held in memory at once.

export interface WsolaOptions {
	sampleRate: number;
	channels: number;
	/** Output is 1/speed as long as the input (speed > 1 compresses / speeds up). */
	speed: number;
	frameSize?: number;
	searchRadius?: number;
	/**
	 * Hint of the total output length (samples). When the output is short relative
	 * to the default grain — a short region at very high speed — the grain size is
	 * shrunk so several grains still sample across the whole region instead of one
	 * grain capturing only its first few ms.
	 */
	expectedOutputSamples?: number;
}

const DEFAULT_FRAME_SEC = 0.04; // 40 ms grains
const MIN_FRAME_SEC = 0.005; // floor grain size for extreme compression
const DEFAULT_SEARCH_SEC = 0.01; // ±10 ms similarity search
const TARGET_GRAINS = 8; // aim for at least this many grains across a region
const PASSTHROUGH_EPSILON = 1e-3;

function hann(length: number): Float32Array {
	const w = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
	}
	return w;
}

/**
 * Streaming WSOLA time-stretcher. One instance handles a single constant speed.
 * All channels share the grain positions chosen from a mono mix so the stereo
 * image is preserved.
 */
export class WsolaTimeStretcher {
	private readonly channels: number;
	private readonly passthrough: boolean;
	private readonly N: number;
	private readonly Hs: number;
	private readonly Ha: number;
	private readonly W: number;
	private readonly window: Float32Array;

	// Input sliding buffer (per channel + a mono mix for the similarity search).
	private buf: Float32Array[];
	private mono: Float32Array;
	private bufStart = 0; // absolute input index of buf[*][0]

	// Output sliding accumulator + the summed window weight per output sample, used
	// to normalize the overlap-add so grain-edge samples reach full amplitude (no
	// fade-in from silence at a segment start) regardless of the WSOLA shifts.
	private out: Float32Array[];
	private winSum: Float32Array;
	private outStart = 0; // absolute output index of out[*][0]

	private idealPos = 0; // fractional ideal analysis position for the next grain
	private grainPos = 0; // integer input index of the next grain to place
	private frame = 0; // synthesis frame counter
	private placedAny = false;

	constructor(opts: WsolaOptions) {
		this.channels = Math.max(1, opts.channels);
		this.passthrough = Math.abs(opts.speed - 1) < PASSTHROUGH_EPSILON;

		let n = opts.frameSize ?? Math.round(opts.sampleRate * DEFAULT_FRAME_SEC);
		if (n < 4) n = 4;
		if (n % 2 !== 0) n += 1;
		let hs = n / 2;

		// Shrink the grain when the whole output would otherwise be shorter than a
		// few default grains, so short/high-speed regions are still sampled across.
		if (opts.expectedOutputSamples != null && opts.expectedOutputSamples > 0) {
			const minHs = Math.max(2, Math.round((opts.sampleRate * MIN_FRAME_SEC) / 2));
			const targetHs = Math.floor(opts.expectedOutputSamples / TARGET_GRAINS);
			hs = Math.min(hs, Math.max(minHs, targetHs));
		}

		this.Hs = hs;
		this.N = hs * 2;
		this.Ha = hs * opts.speed;
		this.W = Math.min(opts.searchRadius ?? Math.round(opts.sampleRate * DEFAULT_SEARCH_SEC), hs);
		this.window = hann(this.N);

		this.buf = Array.from({ length: this.channels }, () => new Float32Array(0));
		this.mono = new Float32Array(0);
		this.out = Array.from({ length: this.channels }, () => new Float32Array(0));
		this.winSum = new Float32Array(0);
	}

	/** Feed more input PCM (per-channel planar). Returns any finished output PCM. */
	push(planar: Float32Array[]): Float32Array[] {
		if (this.passthrough) {
			// Copy so callers may reuse their buffers; output === input for 1× spans.
			return planar.map((p) => p.slice());
		}
		this.append(planar);
		return this.process(false);
	}

	/** Drain all remaining output. Call once after the final push(). */
	flush(): Float32Array[] {
		if (this.passthrough) return this.emptyChunk();
		return this.process(true);
	}

	private emptyChunk(): Float32Array[] {
		return Array.from({ length: this.channels }, () => new Float32Array(0));
	}

	private append(planar: Float32Array[]): void {
		const addLen = planar[0]?.length ?? 0;
		if (addLen === 0) return;
		const oldLen = this.buf[0].length;
		for (let c = 0; c < this.channels; c++) {
			const next = new Float32Array(oldLen + addLen);
			next.set(this.buf[c], 0);
			next.set(planar[c] ?? planar[0], oldLen);
			this.buf[c] = next;
		}
		const mono = new Float32Array(oldLen + addLen);
		mono.set(this.mono, 0);
		for (let i = 0; i < addLen; i++) {
			let sum = 0;
			for (let c = 0; c < this.channels; c++) sum += planar[c]?.[i] ?? planar[0][i];
			mono[oldLen + i] = sum / this.channels;
		}
		this.mono = mono;
	}

	private bufEnd(): number {
		return this.bufStart + this.buf[0].length;
	}

	private sampleAt(channel: number, absIndex: number): number {
		return this.buf[channel][absIndex - this.bufStart] ?? 0;
	}

	private monoAt(absIndex: number): number {
		const i = absIndex - this.bufStart;
		return i >= 0 && i < this.mono.length ? this.mono[i] : 0;
	}

	private process(final: boolean): Float32Array[] {
		const emitted: Float32Array[] = Array.from(
			{ length: this.channels },
			() => new Float32Array(0),
		);

		while (true) {
			// Input we must have buffered before this frame can be placed and the next
			// grain position searched.
			const searchTarget = Math.round(this.idealPos + this.Ha);
			const requiredEnd = Math.max(
				this.grainPos + this.N,
				this.grainPos + this.Hs + this.N,
				searchTarget + this.W + this.N,
			);
			if (!final && this.bufEnd() < requiredEnd) break;
			// Nothing left to place once the grain itself runs past the buffer.
			if (this.grainPos + this.N > this.bufEnd()) break;

			this.placeGrain(this.grainPos);
			const placedFrame = this.frame;

			// Choose the next grain: search near the ideal position for the shift that
			// best continues the just-placed grain.
			const refStart = this.grainPos + this.Hs;
			const bestDelta = this.findBestDelta(refStart, searchTarget);
			this.grainPos = searchTarget + bestDelta;
			this.idealPos += this.Ha;
			this.frame += 1;

			// Output below the placed frame's start is final; emit and drop it.
			this.collect(placedFrame * this.Hs, emitted);
			// Input below the next grain is no longer referenced.
			this.discardBelow(this.grainPos);
		}

		if (final) {
			this.collectAll(emitted);
		}
		return emitted;
	}

	private placeGrain(pos: number): void {
		const outAbs = this.frame * this.Hs;
		this.ensureOut(outAbs + this.N);
		const base = outAbs - this.outStart;
		for (let c = 0; c < this.channels; c++) {
			const dst = this.out[c];
			for (let k = 0; k < this.N; k++) {
				dst[base + k] += this.sampleAt(c, pos + k) * this.window[k];
			}
		}
		for (let k = 0; k < this.N; k++) {
			this.winSum[base + k] += this.window[k];
		}
		this.placedAny = true;
	}

	private findBestDelta(refStart: number, target: number): number {
		// Normalized cross-correlation of the natural continuation (ref) against each
		// candidate grain within ±W. Falls back to 0 when input is too short (flush tail).
		if (refStart + this.N > this.bufEnd()) return 0;

		let refEnergy = 0;
		for (let k = 0; k < this.N; k++) {
			const r = this.monoAt(refStart + k);
			refEnergy += r * r;
		}
		if (refEnergy === 0) return 0;

		let bestDelta = 0;
		let bestScore = -Infinity;
		const loDelta = Math.max(-this.W, this.bufStart - target);
		const hiDelta = Math.min(this.W, this.bufEnd() - this.N - target);
		for (let delta = loDelta; delta <= hiDelta; delta++) {
			const candStart = target + delta;
			let dot = 0;
			let energy = 0;
			for (let k = 0; k < this.N; k++) {
				const c = this.monoAt(candStart + k);
				dot += c * this.monoAt(refStart + k);
				energy += c * c;
			}
			const score = energy > 0 ? dot / Math.sqrt(energy) : 0;
			if (score > bestScore) {
				bestScore = score;
				bestDelta = delta;
			}
		}
		return bestDelta;
	}

	private ensureOut(absEnd: number): void {
		const needed = absEnd - this.outStart;
		if (needed <= this.out[0].length) return;
		const nextLen = Math.max(needed, this.out[0].length * 2, this.N * 4);
		for (let c = 0; c < this.channels; c++) {
			const grown = new Float32Array(nextLen);
			grown.set(this.out[c], 0);
			this.out[c] = grown;
		}
		const grownWin = new Float32Array(nextLen);
		grownWin.set(this.winSum, 0);
		this.winSum = grownWin;
	}

	private collect(absEnd: number, emitted: Float32Array[]): void {
		const count = absEnd - this.outStart;
		if (count <= 0) return;
		for (let c = 0; c < this.channels; c++) {
			const chunk = this.out[c].slice(0, count);
			// Normalize by the summed window weight so overlap-add gain is 1 everywhere,
			// including the first/last grain edges (no fade-in from silence).
			for (let i = 0; i < count; i++) {
				const w = this.winSum[i];
				if (w > 1e-6) chunk[i] /= w;
			}
			emitted[c] = concat(emitted[c], chunk);
			this.out[c] = this.out[c].slice(count);
		}
		this.winSum = this.winSum.slice(count);
		this.outStart = absEnd;
	}

	private collectAll(emitted: Float32Array[]): void {
		if (!this.placedAny) return;
		// The last placed frame ends at (frame-1)*Hs + N.
		const end = (this.frame - 1) * this.Hs + this.N;
		this.collect(end, emitted);
	}

	private discardBelow(absIndex: number): void {
		const drop = absIndex - this.bufStart;
		if (drop <= 0) return;
		for (let c = 0; c < this.channels; c++) {
			this.buf[c] = this.buf[c].slice(drop);
		}
		this.mono = this.mono.slice(drop);
		this.bufStart = absIndex;
	}
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Float32Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
