import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measureWav, readWavLayout } from "./audio-report";

type Encoding = "s16" | "s24" | "f32";

/** A WAV of `channels` (one array of samples each, in -1..1), as a writer would lay it out. */
function wav(
	channels: Float64Array[],
	sampleRate = 48_000,
	encoding: Encoding = "s16",
	options: { extensible?: boolean; before?: Buffer } = {},
): Buffer {
	const bytesPerSample = encoding === "s16" ? 2 : encoding === "s24" ? 3 : 4;
	const frames = channels[0].length;
	const data = Buffer.alloc(frames * channels.length * bytesPerSample);
	for (let i = 0; i < frames; i++) {
		channels.forEach((samples, c) => {
			const at = (i * channels.length + c) * bytesPerSample;
			const value = Math.max(-1, Math.min(1, samples[i]));
			if (encoding === "f32") data.writeFloatLE(value, at);
			else if (encoding === "s16") data.writeInt16LE(Math.round(value * 32767), at);
			else data.writeIntLE(Math.round(value * 8388607), at, 3);
		});
	}
	const tag = encoding === "f32" ? 3 : 1;
	const fmt = Buffer.alloc(options.extensible ? 40 : 16);
	fmt.writeUInt16LE(options.extensible ? 0xfffe : tag, 0);
	fmt.writeUInt16LE(channels.length, 2);
	fmt.writeUInt32LE(sampleRate, 4);
	fmt.writeUInt32LE(sampleRate * channels.length * bytesPerSample, 8);
	fmt.writeUInt16LE(channels.length * bytesPerSample, 12);
	fmt.writeUInt16LE(bytesPerSample * 8, 14);
	if (options.extensible) {
		fmt.writeUInt16LE(22, 16);
		fmt.writeUInt16LE(bytesPerSample * 8, 18);
		fmt.writeUInt16LE(tag, 24);
	}
	const chunk = (id: string, body: Buffer) => {
		const head = Buffer.alloc(8);
		head.write(id, 0, "latin1");
		head.writeUInt32LE(body.length, 4);
		return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
	};
	const body = Buffer.concat([
		Buffer.from("WAVE", "latin1"),
		chunk("fmt ", fmt),
		...(options.before ? [chunk("LIST", options.before)] : []),
		chunk("data", data),
	]);
	const riff = Buffer.alloc(8);
	riff.write("RIFF", 0, "latin1");
	riff.writeUInt32LE(body.length, 4);
	return Buffer.concat([riff, body]);
}

const dbToAmplitude = (db: number) => 10 ** (db / 20);

/** A sine at `hz`, `db` dBFS at its crest, for `seconds`. */
function tone(db: number, seconds: number, sampleRate = 48_000, hz = 1_000, phase = 0) {
	const samples = new Float64Array(Math.round(seconds * sampleRate));
	const amplitude = dbToAmplitude(db);
	for (let i = 0; i < samples.length; i++) {
		samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
	}
	return samples;
}

function join(...parts: Float64Array[]): Float64Array {
	const joined = new Float64Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		joined.set(part, at);
		at += part.length;
	}
	return joined;
}

const silence = (seconds: number, sampleRate = 48_000) =>
	new Float64Array(Math.round(seconds * sampleRate));

let dir = "";
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-report-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function measure(file: Buffer) {
	const filePath = path.join(dir, "audio.wav");
	await fs.writeFile(filePath, file);
	return measureWav(filePath);
}

describe("measureWav", () => {
	it("reads a stereo tone at its level: -23 dBFS on both channels is -23 LUFS", async () => {
		const sine = tone(-23, 5);
		const report = await measure(wav([sine, sine]));
		expect(report).toMatchObject({ durationSec: 5, sampleRate: 48_000, channels: 2, silences: [] });
		expect(report.integratedLufs).toBeCloseTo(-23, 1);
		expect(report.truePeakDbtp).toBeCloseTo(-23, 1);
	});

	it("weights the same at another sample rate", async () => {
		const sine = tone(-23, 5, 44_100);
		const report = await measure(wav([sine, sine], 44_100));
		expect(report.sampleRate).toBe(44_100);
		expect(report.integratedLufs).toBeCloseTo(-23, 1);
	});

	it("weights low and high tones as the standard's own filter does", async () => {
		// BS.1770-4's two filters at 48 kHz, as the standard prints them. A 1 kHz tone cannot tell
		// a wrong weighting from a right one; these two can.
		const stages = [
			{
				b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
				a: [1, -1.69065929318241, 0.73248077421585],
			},
			{ b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] },
		];
		const gainDb = (hz: number) => {
			const w = (2 * Math.PI * hz) / 48_000;
			const power = (c: number[]) =>
				(c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w)) ** 2 +
				(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w)) ** 2;
			return 10 * Math.log10(stages.reduce((all, { b, a }) => (all * power(b)) / power(a), 1));
		};
		// Far from flat: the low tone is turned down, the high one up by several decibels.
		expect(gainDb(100)).toBeLessThan(-0.5);
		expect(gainDb(10_000)).toBeGreaterThan(3);
		for (const hz of [100, 10_000]) {
			const sine = tone(-23, 10, 48_000, hz);
			const { integratedLufs } = await measure(wav([sine, sine], 48_000, "f32"));
			// A stereo sine at -23 dBFS carries a mean square of -23 dB over its two channels.
			expect(integratedLufs).toBeCloseTo(-0.691 - 23 + gainDb(hz), 1);
		}
	});

	it("finds a peak between the very last samples", async () => {
		// Half a second of nothing, then two samples: the wave they belong to crests between them.
		const burst = new Float64Array(24_002);
		burst[24_000] = Math.SQRT1_2;
		burst[24_001] = Math.SQRT1_2;
		const { truePeakDbtp } = await measure(wav([burst], 48_000, "f32"));
		// The samples themselves stand at -3 dB.
		expect(truePeakDbtp).toBeGreaterThan(-2);
		expect(truePeakDbtp).toBeLessThan(0);
	});

	it("counts one channel alone 3 LU under two", async () => {
		const report = await measure(wav([tone(-23, 5)]));
		expect(report.integratedLufs).toBeCloseTo(-26, 1);
	});

	it("finds the peak between the samples, which no sample shows", async () => {
		// A quarter of the sample rate, 45° off: every sample sits 3 dB under the wave's crest.
		const report = await measure(wav([tone(0, 1, 48_000, 12_000, Math.PI / 4)], 48_000, "f32"));
		expect(report.truePeakDbtp).toBeGreaterThan(-0.6);
		expect(report.truePeakDbtp).toBeLessThan(0.3);
	});

	it("leaves a quiet passage out of the loudness, as the R128 gate does", async () => {
		const mixed = join(tone(-23, 10), tone(-50, 10));
		const report = await measure(wav([mixed, mixed]));
		// Ungated, the quiet half would pull the figure down to -26. The few blocks that straddle
		// the change of level still count, as the standard has it: a hair under -23.
		expect(report.integratedLufs).toBeGreaterThan(-23.2);
		expect(report.integratedLufs).toBeLessThan(-22.9);
	});

	it("lists the stretches with no sound of half a second or more, not the shorter ones", async () => {
		const film = join(silence(1), tone(-20, 1), silence(0.3), tone(-20, 1), silence(0.8));
		const { silences, durationSec } = await measure(wav([film, film]));
		expect(durationSec).toBeCloseTo(4.1, 5);
		expect(silences).toHaveLength(2);
		expect(silences[0].startSec).toBe(0);
		expect(silences[0].endSec).toBeCloseTo(1, 2);
		expect(silences[1].startSec).toBeCloseTo(3.3, 2);
		expect(silences[1].endSec).toBeCloseTo(4.1, 2);
	});

	it("has no loudness and no peak to give for digital silence", async () => {
		const report = await measure(wav([silence(2), silence(2)]));
		expect(report.integratedLufs).toBeNull();
		expect(report.truePeakDbtp).toBeNull();
		expect(report.silences).toEqual([{ startSec: 0, endSec: 2 }]);
	});

	it("reads 24-bit samples behind an extensible header and a chunk of tags", async () => {
		const sine = tone(-23, 2);
		const report = await measure(
			wav([sine, sine], 48_000, "s24", { extensible: true, before: Buffer.from("INFOodd") }),
		);
		expect(report.channels).toBe(2);
		expect(report.durationSec).toBe(2);
		expect(report.integratedLufs).toBeCloseTo(-23, 1);
	});

	it("says why it cannot read a file", async () => {
		await expect(measure(Buffer.from("not a wav at all"))).rejects.toThrow("Not a WAV file");
		const mp3InWav = wav([tone(-23, 0.1)]);
		mp3InWav.writeUInt16LE(85, 20);
		await expect(measure(mp3InWav)).rejects.toThrow("Unsupported WAV encoding (format 85)");
	});
});

describe("readWavLayout", () => {
	it("runs the samples to the end of the file when a streaming writer left their size open", () => {
		const file = wav([tone(-23, 0.01)]);
		const dataSizeAt = file.indexOf("data", 0, "latin1") + 4;
		file.writeUInt32LE(0xffffffff, dataSizeAt);
		const layout = readWavLayout(file, file.length);
		expect(layout.dataBytes).toBe(file.length - layout.dataStart);
		expect(layout).toMatchObject({
			channels: 1,
			sampleRate: 48_000,
			bytesPerSample: 2,
			float: false,
		});
	});
});
