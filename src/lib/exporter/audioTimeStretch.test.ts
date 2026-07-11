import { describe, expect, it } from "vitest";
import { WsolaTimeStretcher } from "./audioTimeStretch";

const SR = 48000;

function sine(freq: number, seconds: number, sampleRate = SR): Float32Array {
	const out = new Float32Array(Math.round(seconds * sampleRate));
	for (let i = 0; i < out.length; i++) {
		out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
	}
	return out;
}

// Feed a signal through the stretcher in small chunks (as decoding would) and
// return the concatenated per-channel output.
function stretch(channelsIn: Float32Array[], speed: number, chunk = 2048): Float32Array[] {
	const channels = channelsIn.length;
	const st = new WsolaTimeStretcher({ sampleRate: SR, channels, speed });
	const acc: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(0));
	const append = (dst: Float32Array[], next: Float32Array[]) => {
		for (let c = 0; c < channels; c++) {
			const merged = new Float32Array(dst[c].length + next[c].length);
			merged.set(dst[c], 0);
			merged.set(next[c], dst[c].length);
			dst[c] = merged;
		}
	};
	for (let off = 0; off < channelsIn[0].length; off += chunk) {
		const slice = channelsIn.map((p) => p.subarray(off, Math.min(off + chunk, p.length)));
		append(acc, st.push(slice));
	}
	append(acc, st.flush());
	return acc;
}

function rms(signal: Float32Array, from = 0, to = signal.length): number {
	let sum = 0;
	for (let i = from; i < to; i++) sum += signal[i] * signal[i];
	return Math.sqrt(sum / Math.max(1, to - from));
}

// Zero-crossings per second — a pitch proxy that is invariant to time-stretching.
function crossingsPerSecond(signal: Float32Array): number {
	let crossings = 0;
	for (let i = 1; i < signal.length; i++) {
		if ((signal[i - 1] < 0 && signal[i] >= 0) || (signal[i - 1] >= 0 && signal[i] < 0)) {
			crossings++;
		}
	}
	return crossings / (signal.length / SR);
}

describe("WsolaTimeStretcher", () => {
	it("compresses duration by the speed factor", () => {
		const input = sine(440, 1.0);
		const [out] = stretch([input], 4);
		const expected = input.length / 4;
		// WSOLA overshoots the ideal length by up to ~one trailing grain (~40 ms); the
		// exporter clamps each segment to its exact expected length for A/V sync.
		const grain = Math.round(SR * 0.04);
		expect(out.length).toBeGreaterThan(expected - grain);
		expect(out.length).toBeLessThan(expected + 2 * grain);
	});

	it("preserves pitch when speeding up 4x", () => {
		const input = sine(440, 1.0);
		const [out] = stretch([input], 4);
		// A 440 Hz tone crosses zero ~880 times/second regardless of tempo.
		expect(crossingsPerSecond(out)).toBeGreaterThan(880 * 0.85);
		expect(crossingsPerSecond(out)).toBeLessThan(880 * 1.15);
	});

	it("preserves pitch at an extreme 50x speed-up", () => {
		const input = sine(440, 4.0);
		const [out] = stretch([input], 50);
		expect(out.length).toBeGreaterThan(0);
		expect(out.every((s) => Number.isFinite(s))).toBe(true);
		expect(crossingsPerSecond(out)).toBeGreaterThan(880 * 0.7);
		expect(crossingsPerSecond(out)).toBeLessThan(880 * 1.3);
	});

	it("expands duration when slowing down below 1x", () => {
		const input = sine(300, 0.5);
		const [out] = stretch([input], 0.5);
		const expected = input.length / 0.5;
		expect(out.length).toBeGreaterThan(expected * 0.9);
		expect(out.length).toBeLessThan(expected * 1.1);
		expect(crossingsPerSecond(out)).toBeGreaterThan(600 * 0.85);
		expect(crossingsPerSecond(out)).toBeLessThan(600 * 1.15);
	});

	it("passes 1x audio through untouched (per channel)", () => {
		const left = sine(220, 0.2);
		const right = sine(330, 0.2);
		const [outL, outR] = stretch([left, right], 1);
		expect(outL.length).toBe(left.length);
		expect(outR.length).toBe(right.length);
		expect(Array.from(outL.slice(0, 100))).toEqual(Array.from(left.slice(0, 100)));
		expect(Array.from(outR.slice(0, 100))).toEqual(Array.from(right.slice(0, 100)));
	});

	it("keeps output bounded to roughly unit amplitude (constant-overlap-add)", () => {
		const input = sine(500, 0.5);
		const [out] = stretch([input], 8);
		let peak = 0;
		for (const s of out) peak = Math.max(peak, Math.abs(s));
		expect(peak).toBeGreaterThan(0.7);
		expect(peak).toBeLessThan(1.2);
	});

	it("samples across a short high-speed region instead of only its first grain", () => {
		// 1s of tone at 100x -> ~480 output samples. Without the adaptive grain hint the
		// default 40ms hop (Ha=96000) places a single grain and drops ~99% of the region.
		const input = sine(440, 1.0);
		const st = new WsolaTimeStretcher({
			sampleRate: SR,
			channels: 1,
			speed: 100,
			expectedOutputSamples: 480,
		});
		const first = st.push([input])[0];
		const tail = st.flush()[0];
		const out = new Float32Array(first.length + tail.length);
		out.set(first, 0);
		out.set(tail, first.length);

		// Content is present across the whole output, including its second half (which
		// comes from grains sampled ~500-750ms into the region, not just the start).
		expect(out.length).toBeGreaterThan(300);
		expect(rms(out)).toBeGreaterThan(0.2);
		expect(rms(out, Math.floor(out.length / 2))).toBeGreaterThan(0.2);
	});

	it("does not fade in from silence at the start of a segment", () => {
		// Window-sum normalization must give the first grain's leading half full
		// amplitude rather than a ~20ms Hann ramp up from zero.
		const input = sine(440, 2.0);
		const [out] = stretch([input], 20);
		let peakStart = 0;
		for (let i = 0; i < Math.min(200, out.length); i++)
			peakStart = Math.max(peakStart, Math.abs(out[i]));
		expect(peakStart).toBeGreaterThan(0.3);
	});
});
