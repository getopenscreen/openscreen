// What a film sounds like, in numbers: its integrated loudness, its true peak and the stretches
// with no sound at all, measured on the WAV an audio export writes. An agent cannot listen, and
// a still frame says nothing of the sound: these three numbers are how it checks a mix.
//
// The file is read in chunks and measured as it goes, so an hour of audio costs no more memory
// than a minute.

import { open } from "node:fs/promises";

export interface AudioReport {
	durationSec: number;
	sampleRate: number;
	channels: number;
	/** LUFS, per ITU-R BS.1770-4 with the EBU R128 gates; `null` when nothing clears them. */
	integratedLufs: number | null;
	/** dBTP, the highest peak of the signal oversampled four times; `null` for digital silence. */
	truePeakDbtp: number | null;
	/** Every stretch of at least `SILENCE_MIN_SEC` that stays under `SILENCE_FLOOR`. */
	silences: Array<{ startSec: number; endSec: number }>;
}

/** Under -60 dBFS nothing is heard: an encoder's dither, not a sound someone placed. */
const SILENCE_FLOOR = 10 ** (-60 / 20);
/** Shorter than this is a breath between two words, not dead air. */
const SILENCE_MIN_SEC = 0.5;

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
/** Gating blocks last 400 ms and overlap by 75 %: four hops of 100 ms. */
const HOPS_PER_BLOCK = 4;

/** Samples each side of an oversampled point: BS.1770's own interpolator spans as many. */
const TAPS_PER_PHASE = 12;
const OVERSAMPLING = 4;

type Biquad = readonly [b0: number, b1: number, b2: number, a1: number, a2: number];

/** The K-weighting of BS.1770 at any sample rate: a high shelf for the head, then a high-pass.
 *  Derived from the standard's analogue prototypes, as libebur128 does; at 48 kHz they are the
 *  standard's own coefficients. */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
	const shelfK = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
	const shelfQ = 0.7071752369554196;
	const vh = 10 ** (3.999843853973347 / 20);
	const vb = vh ** 0.4996667741545416;
	const shelfNorm = 1 + shelfK / shelfQ + shelfK * shelfK;
	const passK = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
	const passQ = 0.5003270373238773;
	const passNorm = 1 + passK / passQ + passK * passK;
	return [
		[
			(vh + (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfNorm,
			(2 * (shelfK * shelfK - vh)) / shelfNorm,
			(vh - (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfNorm,
			(2 * (shelfK * shelfK - 1)) / shelfNorm,
			(1 - shelfK / shelfQ + shelfK * shelfK) / shelfNorm,
		],
		[
			1,
			-2,
			1,
			(2 * (passK * passK - 1)) / passNorm,
			(1 - passK / passQ + passK * passK) / passNorm,
		],
	];
}

/** A windowed-sinc interpolator, one row of taps per point between two samples. Each row sums
 *  to one, so a steady level comes through at its own height. */
function interpolator(): Float64Array[] {
	const length = TAPS_PER_PHASE * OVERSAMPLING;
	const centre = (length - 1) / 2;
	return Array.from({ length: OVERSAMPLING }, (_, phase) => {
		const taps = new Float64Array(TAPS_PER_PHASE);
		let sum = 0;
		for (let k = 0; k < TAPS_PER_PHASE; k++) {
			const n = k * OVERSAMPLING + phase;
			const x = (Math.PI * (n - centre)) / OVERSAMPLING;
			const sinc = x === 0 ? 1 : Math.sin(x) / x;
			const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 0.5)) / length);
			taps[k] = sinc * window;
			sum += taps[k];
		}
		return taps.map((tap) => tap / sum);
	});
}

const INTERPOLATOR = interpolator();

/** Measures interleaved samples pushed frame by frame. */
class AudioMeter {
	private readonly filters: [Biquad, Biquad];
	/** Per channel, the two filters' memories: x1, x2, y1, y2, twice. */
	private readonly state: Float64Array;
	/** Per channel, the last `TAPS_PER_PHASE` samples, oldest first from `historyAt`. */
	private readonly history: Float64Array;
	private historyAt = 0;
	private readonly hopFrames: number;
	private hopEnergy = 0;
	private hopFilled = 0;
	/** Mean square of each finished 100 ms hop, the channels summed. */
	private readonly hops: number[] = [];
	private peak = 0;
	private frames = 0;
	private quietSince: number | null = 0;
	private readonly silences: Array<{ startSec: number; endSec: number }> = [];

	constructor(
		private readonly sampleRate: number,
		private readonly channels: number,
	) {
		this.filters = kWeighting(sampleRate);
		this.state = new Float64Array(channels * 8);
		this.history = new Float64Array(channels * TAPS_PER_PHASE);
		this.hopFrames = Math.round(sampleRate / 10);
	}

	/** One frame: `frame[c]` is channel `c`'s sample, in -1..1. */
	push(frame: Float64Array): void {
		let loudest = 0;
		for (let c = 0; c < this.channels; c++) {
			const x = frame[c];
			const magnitude = Math.abs(x);
			if (magnitude > loudest) loudest = magnitude;
			this.hopEnergy += this.weighted(c, x) ** 2;
			this.history[c * TAPS_PER_PHASE + this.historyAt] = x;
		}
		this.historyAt = (this.historyAt + 1) % TAPS_PER_PHASE;
		if (loudest > this.peak) this.peak = loudest;
		this.measureBetweenSamples();

		if (loudest < SILENCE_FLOOR) {
			this.quietSince ??= this.frames;
		} else {
			this.endSilence(this.frames);
		}
		this.frames++;
		if (++this.hopFilled === this.hopFrames) {
			this.hops.push(this.hopEnergy / this.hopFrames);
			this.hopEnergy = 0;
			this.hopFilled = 0;
		}
	}

	private weighted(channel: number, x: number): number {
		const s = this.state;
		let value = x;
		for (let stage = 0; stage < 2; stage++) {
			const [b0, b1, b2, a1, a2] = this.filters[stage];
			const at = channel * 8 + stage * 4;
			const y = b0 * value + b1 * s[at] + b2 * s[at + 1] - a1 * s[at + 2] - a2 * s[at + 3];
			s[at + 1] = s[at];
			s[at] = value;
			s[at + 3] = s[at + 2];
			s[at + 2] = y;
			value = y;
		}
		return value;
	}

	/** The signal between the two samples in the middle of the history, where the interpolator
	 *  is centred: half its span behind the newest sample. */
	private measureBetweenSamples(): void {
		// The newest sample, kept positive for the modulo below.
		const newest = this.historyAt - 1 + TAPS_PER_PHASE;
		const half = TAPS_PER_PHASE / 2;
		for (let c = 0; c < this.channels; c++) {
			const base = c * TAPS_PER_PHASE;
			const around = Math.max(
				Math.abs(this.history[base + ((newest - half + 1) % TAPS_PER_PHASE)]),
				Math.abs(this.history[base + ((newest - half) % TAPS_PER_PHASE)]),
			);
			// A peak between two samples rises a few decibels above them at most: where they are
			// well under the peak already found, there is none to look for.
			if (around === 0 || around * 2 < this.peak) continue;
			for (const taps of INTERPOLATOR) {
				let value = 0;
				for (let k = 0; k < TAPS_PER_PHASE; k++) {
					value += taps[k] * this.history[base + ((newest - k) % TAPS_PER_PHASE)];
				}
				if (Math.abs(value) > this.peak) this.peak = Math.abs(value);
			}
		}
	}

	/** Lets the last samples reach the middle of the history: a peak right at the end counts. */
	private flushHistory(): void {
		for (let i = 0; i < TAPS_PER_PHASE / 2; i++) {
			for (let c = 0; c < this.channels; c++) {
				this.history[c * TAPS_PER_PHASE + this.historyAt] = 0;
			}
			this.historyAt = (this.historyAt + 1) % TAPS_PER_PHASE;
			this.measureBetweenSamples();
		}
	}

	private endSilence(atFrame: number): void {
		if (this.quietSince === null) return;
		const startSec = this.quietSince / this.sampleRate;
		const endSec = atFrame / this.sampleRate;
		if (endSec - startSec >= SILENCE_MIN_SEC) this.silences.push({ startSec, endSec });
		this.quietSince = null;
	}

	finish(): AudioReport {
		this.endSilence(this.frames);
		this.flushHistory();
		return {
			durationSec: this.frames / this.sampleRate,
			sampleRate: this.sampleRate,
			channels: this.channels,
			integratedLufs: this.integratedLoudness(),
			truePeakDbtp: this.peak > 0 ? 20 * Math.log10(this.peak) : null,
			silences: this.silences,
		};
	}

	private integratedLoudness(): number | null {
		const blocks: number[] = [];
		for (let i = 0; i + HOPS_PER_BLOCK <= this.hops.length; i++) {
			let sum = 0;
			for (let k = 0; k < HOPS_PER_BLOCK; k++) sum += this.hops[i + k];
			blocks.push(sum / HOPS_PER_BLOCK);
		}
		const lufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);
		const mean = (values: number[]) =>
			values.reduce((sum, value) => sum + value, 0) / values.length;
		const heard = blocks.filter((block) => lufs(block) > ABSOLUTE_GATE_LUFS);
		if (heard.length === 0) return null;
		const relativeGate = lufs(mean(heard)) + RELATIVE_GATE_LU;
		const counted = heard.filter((block) => lufs(block) > relativeGate);
		return counted.length === 0 ? null : lufs(mean(counted));
	}
}

interface WavLayout {
	sampleRate: number;
	channels: number;
	bytesPerSample: number;
	float: boolean;
	dataStart: number;
	dataBytes: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Where a WAV's samples are and how they are written, from its header. */
export function readWavLayout(header: Buffer, fileBytes: number): WavLayout {
	if (
		header.length < 12 ||
		header.toString("latin1", 0, 4) !== "RIFF" ||
		header.toString("latin1", 8, 12) !== "WAVE"
	) {
		throw new Error("Not a WAV file");
	}
	let format: Omit<WavLayout, "dataStart" | "dataBytes"> | null = null;
	let at = 12;
	while (at + 8 <= header.length) {
		const id = header.toString("latin1", at, at + 4);
		const size = header.readUInt32LE(at + 4);
		const body = at + 8;
		if (id === "fmt " && body + 16 <= header.length) {
			let tag = header.readUInt16LE(body);
			const bits = header.readUInt16LE(body + 14);
			// The extensible form keeps the real format in the first bytes of its sub-format.
			if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 26 && body + 26 <= header.length) {
				tag = header.readUInt16LE(body + 24);
			}
			if (tag !== WAVE_FORMAT_PCM && tag !== WAVE_FORMAT_FLOAT) {
				throw new Error(`Unsupported WAV encoding (format ${tag})`);
			}
			format = {
				channels: header.readUInt16LE(body + 2),
				sampleRate: header.readUInt32LE(body + 4),
				bytesPerSample: bits / 8,
				float: tag === WAVE_FORMAT_FLOAT,
			};
		} else if (id === "data") {
			if (!format) throw new Error("The WAV's samples come before its format");
			const supported = format.float
				? [4, 8].includes(format.bytesPerSample)
				: [1, 2, 3, 4].includes(format.bytesPerSample);
			if (!supported || format.channels < 1 || format.sampleRate < 1) {
				throw new Error("Unsupported WAV sample format");
			}
			// A writer that streams leaves the size at zero or all ones: the samples run to the end.
			const declared = size === 0 || size === 0xffffffff ? Number.POSITIVE_INFINITY : size;
			return { ...format, dataStart: body, dataBytes: Math.min(declared, fileBytes - body) };
		}
		at = body + size + (size % 2);
	}
	throw new Error("The WAV has no samples");
}

function sampleReader(layout: WavLayout): (buffer: Buffer, at: number) => number {
	if (layout.float) {
		return layout.bytesPerSample === 4
			? (buffer, at) => buffer.readFloatLE(at)
			: (buffer, at) => buffer.readDoubleLE(at);
	}
	switch (layout.bytesPerSample) {
		case 1:
			return (buffer, at) => (buffer[at] - 128) / 128;
		case 2:
			return (buffer, at) => buffer.readInt16LE(at) / 32768;
		case 3:
			return (buffer, at) => buffer.readIntLE(at, 3) / 8388608;
		default:
			return (buffer, at) => buffer.readInt32LE(at) / 2147483648;
	}
}

/** Enough for the chunks a writer puts before the samples (a LIST of tags, say). */
const HEADER_BYTES = 64 * 1024;
const CHUNK_FRAMES = 16_384;

/** Measures the WAV at `path`. Throws, saying why, when it is not a WAV this reads. */
export async function measureWav(path: string): Promise<AudioReport> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const header = Buffer.alloc(Math.min(HEADER_BYTES, size));
		await file.read(header, 0, header.length, 0);
		const layout = readWavLayout(header, size);
		const read = sampleReader(layout);
		const frameBytes = layout.bytesPerSample * layout.channels;
		const meter = new AudioMeter(layout.sampleRate, layout.channels);
		const frame = new Float64Array(layout.channels);
		const chunk = Buffer.alloc(CHUNK_FRAMES * frameBytes);
		const end = layout.dataStart + layout.dataBytes - (layout.dataBytes % frameBytes);
		for (let position = layout.dataStart; position < end; ) {
			const wanted = Math.min(chunk.length, end - position);
			const { bytesRead } = await file.read(chunk, 0, wanted, position);
			const whole = bytesRead - (bytesRead % frameBytes);
			if (whole === 0) break;
			for (let at = 0; at < whole; at += frameBytes) {
				for (let c = 0; c < layout.channels; c++) {
					frame[c] = read(chunk, at + c * layout.bytesPerSample);
				}
				meter.push(frame);
			}
			position += whole;
		}
		return meter.finish();
	} finally {
		await file.close();
	}
}
