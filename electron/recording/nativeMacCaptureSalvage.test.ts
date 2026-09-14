import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	describeSalvagedTake,
	inspectNativeMacCapture,
	salvageNativeMacCapture,
} from "./nativeMacCaptureSalvage";

/**
 * The fixtures are real takes from the macOS helper (Mac mini M1, macOS 26.5) with
 * every `mdat` payload zeroed and then gzipped, so they keep AVAssetWriter's exact
 * box structure — sample tables, fragments, the size-0 tail — in a few KB. The
 * expected frame counts are ffmpeg's packet counts on the ORIGINAL files; zeroing
 * payloads does not move a single box.
 *
 * - writer-died-4s: shipped 1.11.0-rc.1 helper, writer failed with -16364 (3 moof).
 * - writer-died-1s-no-moof: the same death within the first second (mvex, 0 moof).
 * - helper-killed-29s: main helper SIGKILLed 30 s in (28 moof, size-0 tail mdat).
 * - helper-killed-9s-main: main helper after #661, SIGKILLed 10 s in.
 * - clean-flat-8s: a clean stop, which finishWriting rewrites flat.
 */
const FIXTURES = path.join(__dirname, "__fixtures__", "macos-fmp4");

/** Box offsets in helper-killed-29s, read off the original file. */
const KILLED_29S = {
	moov: 1_201_426,
	firstMoof: 2_371_612,
	lastMoof: 35_918_587,
	wide: 35_919_355,
	tailMdat: 35_919_363,
};

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-mac-salvage-"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** A private copy of a fixture, optionally cut to its first `bytes` bytes. */
async function take(fixture: string, bytes?: number) {
	const data = gunzipSync(await fs.readFile(path.join(FIXTURES, `${fixture}.mp4.gz`)));
	const target = path.join(
		dir,
		`${fixture}-${bytes ?? "whole"}-${Math.random().toString(36).slice(2)}.mp4`,
	);
	await fs.writeFile(target, bytes === undefined ? data : data.subarray(0, bytes));
	return target;
}

async function sizeOf(filePath: string) {
	return (await fs.stat(filePath)).size;
}

describe("inspectNativeMacCapture on real helper output", () => {
	it.each([
		["writer-died-4s", 231, 4],
		["writer-died-1s-no-moof", 58, 1],
		["helper-killed-29s", 1652, 29],
		["helper-killed-9s-main", 513, 9],
		["clean-flat-8s", 461, 8],
	])("finds every frame ffmpeg reads in %s", async (fixture, frames, seconds) => {
		const inspection = await inspectNativeMacCapture(await take(fixture));

		expect(inspection).toMatchObject({ ok: true, videoSamples: frames });
		if (!inspection.ok) throw new Error("unreachable");
		expect(inspection.validBytes).toBe(inspection.fileBytes);
		expect(Math.abs(inspection.durationSec - seconds)).toBeLessThan(0.2);
	});

	/**
	 * #571's check rejected this file at random: its last `mdat` has a size field of 0,
	 * and mp4box aborted whenever a read-chunk boundary fell inside it.
	 */
	it("reads a take whose last mdat declares size 0, with no read-size dependence", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.tailMdat + 8);
		await expect(inspectNativeMacCapture(file)).resolves.toMatchObject({
			ok: true,
			videoSamples: 1652,
		});
	});

	/** The fragment still being written when the take died: a final mdat cut short. */
	it("accepts a final mdat cut short, keeping the fragments indexed before it", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.lastMoof - 1000);
		const inspection = await inspectNativeMacCapture(file);
		expect(inspection).toMatchObject({ ok: true, videoSamples: 1596 });
		if (!inspection.ok) throw new Error("unreachable");
		expect(inspection.validBytes).toBe(inspection.fileBytes);
	});

	it("marks where a torn moof starts without changing the file", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.lastMoof + 300);
		const inspection = await inspectNativeMacCapture(file);

		expect(inspection).toMatchObject({
			ok: true,
			validBytes: KILLED_29S.lastMoof,
			videoSamples: 1596,
		});
		expect(await sizeOf(file)).toBe(KILLED_29S.lastMoof + 300);
	});

	it("rejects a file whose movie header is torn", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.moov + 500);
		await expect(inspectNativeMacCapture(file)).resolves.toMatchObject({
			ok: false,
			reason: "no movie header in the readable part of the file",
		});
	});

	it("rejects a file cut before its movie header", async () => {
		const file = await take("helper-killed-29s", 600_000);
		await expect(inspectNativeMacCapture(file)).resolves.toMatchObject({ ok: false });
	});

	it("rejects something that is not an MP4 at all", async () => {
		const file = path.join(dir, "notes.txt");
		await fs.writeFile(file, "this is not a recording\n".repeat(10));
		await expect(inspectNativeMacCapture(file)).resolves.toMatchObject({
			ok: false,
			reason: "not an MP4 file",
		});
	});

	it("rejects a file that is not there", async () => {
		await expect(inspectNativeMacCapture(path.join(dir, "missing.mp4"))).resolves.toMatchObject({
			ok: false,
		});
	});
});

describe("salvageNativeMacCapture", () => {
	it("leaves a readable take exactly as it is", async () => {
		const file = await take("writer-died-4s");
		const before = await sizeOf(file);

		await expect(salvageNativeMacCapture(file)).resolves.toMatchObject({
			ok: true,
			screenVideoPath: file,
			videoSamples: 231,
			truncatedBytes: 0,
		});
		expect(await sizeOf(file)).toBe(before);
	});

	/**
	 * A file cut inside a moof opens nowhere (ffmpeg, libavformat and Chromium all
	 * refuse it), though mp4box accepts it. Cut back to that moof it opens with every
	 * earlier fragment: ffmpeg reads 1596 frames from exactly this cut.
	 */
	it("cuts a torn last moof off and keeps every fragment before it", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.lastMoof + 300);

		await expect(salvageNativeMacCapture(file)).resolves.toMatchObject({
			ok: true,
			videoSamples: 1596,
			truncatedBytes: 300,
		});
		expect(await sizeOf(file)).toBe(KILLED_29S.lastMoof);
	});

	it("keeps the first second when the first moof is the torn one", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.firstMoof + 300);

		await expect(salvageNativeMacCapture(file)).resolves.toMatchObject({
			ok: true,
			videoSamples: 58,
		});
		expect(await sizeOf(file)).toBe(KILLED_29S.firstMoof);
	});

	it("cuts off a box header left half-written at the end", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.wide + 4);

		await expect(salvageNativeMacCapture(file)).resolves.toMatchObject({
			ok: true,
			videoSamples: 1652,
			truncatedBytes: 4,
		});
	});

	/** Nothing is cut from a file that cannot be recovered anyway. */
	it("does not touch a file it cannot recover", async () => {
		const file = await take("helper-killed-29s", KILLED_29S.moov + 500);

		await expect(salvageNativeMacCapture(file)).resolves.toMatchObject({ ok: false });
		expect(await sizeOf(file)).toBe(KILLED_29S.moov + 500);
	});
});

describe("describeSalvagedTake", () => {
	it("quotes the readable part of an NSError", () => {
		expect(
			describeSalvagedTake(
				'Recording stopped: the video file could not be written (video append: Error Domain=AVFoundationErrorDomain Code=-11807 "Disk Full" UserInfo={NSLocalizedDescription=Disk Full, NSUnderlyingError=0x1 {Error Domain=NSPOSIXErrorDomain Code=28}}).',
				35.01,
			),
		).toBe("Recording stopped after 0:35: Disk Full. The part recorded until then was saved.");
	});

	it("uses the whole message when there is no NSError in it", () => {
		expect(describeSalvagedTake("The recorder stopped unexpectedly (signal SIGKILL).", 9)).toBe(
			"Recording stopped after 0:09: The recorder stopped unexpectedly (signal SIGKILL). The part recorded until then was saved.",
		);
	});

	it("counts hours on a long take", () => {
		expect(describeSalvagedTake("Disk Full", 3725)).toBe(
			"Recording stopped after 1:02:05: Disk Full. The part recorded until then was saved.",
		);
	});
});
