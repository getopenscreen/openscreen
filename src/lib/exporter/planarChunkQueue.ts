// FIFO queue of planar PCM chunks with O(1) amortized append and front-drain.
//
// The offline audio time-stretch path produces output in many small chunks and
// drains fixed-size slices to the encoder. A grow-and-copy accumulator would be
// O(N^2) over a long run; this keeps each chunk by reference and only copies the
// samples that are actually pulled out (O(take) per drain, O(total) overall).

export class PlanarChunkQueue {
	private readonly channels: number;
	private readonly queue: Float32Array[][];
	private headOffset = 0; // consumed samples into queue[*][0] (shared across channels)
	private queuedLen = 0;

	constructor(channels: number) {
		this.channels = Math.max(1, channels);
		this.queue = Array.from({ length: this.channels }, () => []);
	}

	/** Samples currently buffered (per channel). */
	get length(): number {
		return this.queuedLen;
	}

	/** Append the first `count` samples of each channel plane (stored by reference). */
	push(planes: Float32Array[], count: number): void {
		if (count <= 0) return;
		for (let c = 0; c < this.channels; c++) {
			this.queue[c].push((planes[c] ?? planes[0]).subarray(0, count));
		}
		this.queuedLen += count;
	}

	/**
	 * Remove `take` samples from the front and return them as one planar buffer laid
	 * out [ch0 samples…, ch1 samples…, …]. `take` must be ≤ length.
	 */
	take(take: number): Float32Array {
		if (take <= 0) return new Float32Array(0);
		const data = new Float32Array(take * this.channels);
		for (let c = 0; c < this.channels; c++) {
			let need = take;
			let ci = 0;
			let off = this.headOffset;
			let dst = c * take;
			while (need > 0) {
				const chunk = this.queue[c][ci];
				const avail = chunk.length - off;
				const n = avail < need ? avail : need;
				data.set(chunk.subarray(off, off + n), dst);
				dst += n;
				need -= n;
				if (n < avail) {
					off += n;
				} else {
					ci += 1;
					off = 0;
				}
			}
		}
		// Advance the shared head / drop fully consumed chunks (identical layout per channel).
		let remaining = take;
		while (remaining > 0) {
			const avail = this.queue[0][0].length - this.headOffset;
			if (avail <= remaining) {
				for (let c = 0; c < this.channels; c++) this.queue[c].shift();
				this.headOffset = 0;
				remaining -= avail;
			} else {
				this.headOffset += remaining;
				remaining = 0;
			}
		}
		this.queuedLen -= take;
		return data;
	}
}
