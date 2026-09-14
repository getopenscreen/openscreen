import fs from "node:fs/promises";

/**
 * Recovering what a macOS take left on disk when its stop failed.
 *
 * # What a failed take leaves behind
 *
 * The helper's AVAssetWriter writes fragmented MP4 (`movieFragmentInterval` = 1 s).
 * A clean stop rewrites it flat — `ftyp mdat moov` — but a writer that died, or a
 * helper that was killed, leaves the fragmented shape as it was:
 *
 *     ftyp  mdat  moov[… mvex]  (mdat moof)*  wide  mdat
 *
 * The first `mdat` holds the first second, indexed by the `moov` sample table.
 * Each later fragment writes its `mdat` BEFORE the `moof` that indexes it, with an
 * absolute data offset (`tfhd` flag 0x1). The final `mdat` is the fragment that was
 * still open, and no `moof` indexes it. ffmpeg, libavformat, Chromium and the editor
 * all open such a file as it is, with the right duration (measured on real takes:
 * 4 s, 10 s, 29 s, 73 s).
 *
 * # Why this is not mp4box
 *
 * PR #571 fed mp4box in 1 MiB chunks, and that last `mdat` has a size field of 0:
 * whenever a multiple of the chunk size fell inside it, mp4box aborted with "Invalid
 * box type", so whether a take was kept depended on its byte length. mp4box also
 * accepted a file cut inside a `moof`, which nothing can open. This walk reads box
 * headers at their own offsets, so the read size never matters.
 *
 * # The one layout that has to be repaired
 *
 * A file cut inside a `moof` opens nowhere: ffmpeg, libavformat and Chromium all
 * refuse it. Cut back to the start of that `moof` it opens, and keeps every fragment
 * before it. So a torn tail is truncated and the file inspected again. The same cut
 * is applied to anything else left unfinished at the end, such as a header of a few
 * bytes, which players skip anyway: it costs nothing, and a file is never reported
 * recoverable while bytes that could break it are still on disk.
 */

import type { NativeMacCaptureStopResult } from "./nativeMacCaptureStop";

/** Guards against a corrupt size field making a structural box look enormous. */
const MAX_INDEX_BOX_BYTES = 64 * 1024 * 1024;

type Box = { type: string; start: number; headerSize: number; size: number };

export type NativeMacCaptureInspection =
	| {
			ok: true;
			fileBytes: number;
			/** Bytes from the start of the file up to the first box that is torn or unreadable. */
			validBytes: number;
			/** Video samples whose bytes lie entirely inside `validBytes`. */
			videoSamples: number;
			durationSec: number;
			fragments: number;
	  }
	| { ok: false; reason: string; fileBytes: number; validBytes: number };

export type NativeMacSalvageResult =
	| {
			ok: true;
			screenVideoPath: string;
			videoSamples: number;
			durationSec: number;
			/** Bytes cut off a torn tail before the file could be opened; 0 when none. */
			truncatedBytes: number;
	  }
	| { ok: false; reason: string };

function boxType(buffer: Buffer, offset: number) {
	return buffer.toString("latin1", offset, offset + 4);
}

function isPrintableType(type: string) {
	return /^[\x20-\x7e]{4}$/.test(type);
}

/** Complete child boxes of `[start, end)` inside an in-memory box. */
function childBoxes(buffer: Buffer, start: number, end: number): Box[] {
	const boxes: Box[] = [];
	let position = start;
	while (position + 8 <= end) {
		let size = buffer.readUInt32BE(position);
		const type = boxType(buffer, position + 4);
		let headerSize = 8;
		if (size === 1) {
			if (position + 16 > end) {
				break;
			}
			size = Number(buffer.readBigUInt64BE(position + 8));
			headerSize = 16;
		} else if (size === 0) {
			size = end - position;
		}
		if (size < headerSize || position + size > end) {
			break;
		}
		boxes.push({ type, start: position, headerSize, size });
		position += size;
	}
	return boxes;
}

function childBox(buffer: Buffer, parent: Box, type: string) {
	return childBoxes(buffer, parent.start + parent.headerSize, parent.start + parent.size).find(
		(box) => box.type === type,
	);
}

/** Offset of the first byte after a full box's version and flags. */
function fullBoxBody(box: Box) {
	return box.start + box.headerSize + 4;
}

async function readAt(handle: fs.FileHandle, position: number, length: number) {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

type TopLevel = { boxes: Box[]; validBytes: number };

/**
 * Walks the top-level boxes by their own offsets. A final `mdat` may run past the end
 * of the file — that is the fragment still being written — but any other box that
 * does, a header cut short, or bytes that are not a box header end the readable part
 * where they start.
 */
async function walkTopLevel(handle: fs.FileHandle, fileBytes: number): Promise<TopLevel> {
	const boxes: Box[] = [];
	let position = 0;
	while (position < fileBytes) {
		if (fileBytes - position < 8) {
			return { boxes, validBytes: position };
		}
		const header = await readAt(handle, position, 16);
		const type = boxType(header, 4);
		if (!isPrintableType(type)) {
			return { boxes, validBytes: position };
		}
		let size = header.readUInt32BE(0);
		let headerSize = 8;
		if (size === 1) {
			if (header.length < 16) {
				return { boxes, validBytes: position };
			}
			size = Number(header.readBigUInt64BE(8));
			headerSize = 16;
		} else if (size === 0) {
			size = fileBytes - position;
		}
		if (size < headerSize) {
			return { boxes, validBytes: position };
		}
		if (position + size > fileBytes) {
			if (type !== "mdat") {
				return { boxes, validBytes: position };
			}
			boxes.push({ type, start: position, headerSize, size: fileBytes - position });
			return { boxes, validBytes: fileBytes };
		}
		boxes.push({ type, start: position, headerSize, size });
		position += size;
	}
	return { boxes, validBytes: position };
}

type VideoTrack = {
	trackId: number;
	timescale: number;
	defaultSampleDuration: number;
	defaultSampleSize: number;
};

type SampleTally = { samples: number; duration: number };

/** Reads the video `trak`: its id, timescale and flat sample table, counting samples in the file. */
function readVideoTrack(
	moov: Buffer,
	validBytes: number,
): { track: VideoTrack; flat: SampleTally } | null {
	const root: Box = { type: "moov", start: 0, headerSize: 8, size: moov.length };
	for (const trak of childBoxes(moov, 8, moov.length).filter((box) => box.type === "trak")) {
		const tkhd = childBox(moov, trak, "tkhd");
		const mdia = childBox(moov, trak, "mdia");
		if (!tkhd || !mdia) {
			continue;
		}
		const hdlr = childBox(moov, mdia, "hdlr");
		if (!hdlr || boxType(moov, fullBoxBody(hdlr) + 4) !== "vide") {
			continue;
		}
		const mdhd = childBox(moov, mdia, "mdhd");
		const minf = childBox(moov, mdia, "minf");
		const stbl = minf ? childBox(moov, minf, "stbl") : undefined;
		const stsd = stbl ? childBox(moov, stbl, "stsd") : undefined;
		if (!mdhd || !stbl || !stsd) {
			continue;
		}
		// A visual sample entry: 8-byte header, 8 reserved/data-reference bytes, 16
		// pre-defined bytes, then width and height.
		const entry = fullBoxBody(stsd) + 4;
		if (moov.readUInt32BE(fullBoxBody(stsd)) === 0 || entry + 36 > stsd.start + stsd.size) {
			continue;
		}
		const width = moov.readUInt16BE(entry + 32);
		const height = moov.readUInt16BE(entry + 34);
		if (width === 0 || height === 0) {
			continue;
		}

		const tkhdVersion = moov[tkhd.start + tkhd.headerSize];
		const trackId = moov.readUInt32BE(fullBoxBody(tkhd) + (tkhdVersion === 1 ? 16 : 8));
		const mdhdVersion = moov[mdhd.start + mdhd.headerSize];
		const timescale = moov.readUInt32BE(fullBoxBody(mdhd) + (mdhdVersion === 1 ? 16 : 8));
		if (timescale === 0) {
			continue;
		}

		let defaultSampleDuration = 0;
		let defaultSampleSize = 0;
		const mvex = childBox(moov, root, "mvex");
		if (mvex) {
			for (const trex of childBoxes(moov, mvex.start + mvex.headerSize, mvex.start + mvex.size)) {
				if (trex.type === "trex" && moov.readUInt32BE(fullBoxBody(trex)) === trackId) {
					defaultSampleDuration = moov.readUInt32BE(fullBoxBody(trex) + 8);
					defaultSampleSize = moov.readUInt32BE(fullBoxBody(trex) + 12);
				}
			}
		}

		return {
			track: { trackId, timescale, defaultSampleDuration, defaultSampleSize },
			flat: tallyFlatSamples(moov, stbl, validBytes),
		};
	}
	return null;
}

function tallyFlatSamples(moov: Buffer, stbl: Box, validBytes: number): SampleTally {
	const stsz = childBox(moov, stbl, "stsz");
	const stsc = childBox(moov, stbl, "stsc");
	const stco = childBox(moov, stbl, "stco") ?? childBox(moov, stbl, "co64");
	const stts = childBox(moov, stbl, "stts");
	if (!stsz || !stsc || !stco) {
		return { samples: 0, duration: 0 };
	}

	const uniformSize = moov.readUInt32BE(fullBoxBody(stsz));
	const sampleCount = moov.readUInt32BE(fullBoxBody(stsz) + 4);
	const sizeOf = (index: number) =>
		uniformSize !== 0 ? uniformSize : moov.readUInt32BE(fullBoxBody(stsz) + 8 + index * 4);

	const chunkCount = moov.readUInt32BE(fullBoxBody(stco));
	const chunkOffset = (index: number) =>
		stco.type === "co64"
			? Number(moov.readBigUInt64BE(fullBoxBody(stco) + 4 + index * 8))
			: moov.readUInt32BE(fullBoxBody(stco) + 4 + index * 4);

	const deltas: number[] = [];
	if (stts) {
		const entries = moov.readUInt32BE(fullBoxBody(stts));
		for (let entry = 0; entry < entries && deltas.length < sampleCount; entry += 1) {
			const count = moov.readUInt32BE(fullBoxBody(stts) + 4 + entry * 8);
			const delta = moov.readUInt32BE(fullBoxBody(stts) + 8 + entry * 8);
			for (let index = 0; index < count && deltas.length < sampleCount; index += 1) {
				deltas.push(delta);
			}
		}
	}

	const runs = moov.readUInt32BE(fullBoxBody(stsc));
	let sample = 0;
	const tally: SampleTally = { samples: 0, duration: 0 };
	for (let run = 0; run < runs && sample < sampleCount; run += 1) {
		const firstChunk = moov.readUInt32BE(fullBoxBody(stsc) + 4 + run * 12);
		const samplesPerChunk = moov.readUInt32BE(fullBoxBody(stsc) + 8 + run * 12);
		const nextFirstChunk =
			run + 1 < runs ? moov.readUInt32BE(fullBoxBody(stsc) + 4 + (run + 1) * 12) : chunkCount + 1;
		for (let chunk = firstChunk; chunk < nextFirstChunk && chunk <= chunkCount; chunk += 1) {
			let position = chunkOffset(chunk - 1);
			for (let index = 0; index < samplesPerChunk && sample < sampleCount; index += 1) {
				const size = sizeOf(sample);
				if (position + size <= validBytes) {
					tally.samples += 1;
					tally.duration += deltas[sample] ?? 0;
				}
				position += size;
				sample += 1;
			}
		}
	}
	return tally;
}

/** Counts the video samples one `moof` indexes whose bytes are inside the file. */
function tallyFragmentSamples(
	moof: Buffer,
	moofStart: number,
	track: VideoTrack,
	validBytes: number,
): SampleTally {
	const tally: SampleTally = { samples: 0, duration: 0 };
	for (const traf of childBoxes(moof, 8, moof.length).filter((box) => box.type === "traf")) {
		const children = childBoxes(moof, traf.start + traf.headerSize, traf.start + traf.size);
		const tfhd = children.find((box) => box.type === "tfhd");
		if (!tfhd) {
			continue;
		}
		const tfhdFlags = moof.readUInt32BE(tfhd.start + tfhd.headerSize) & 0xffffff;
		if (moof.readUInt32BE(fullBoxBody(tfhd)) !== track.trackId) {
			continue;
		}
		let cursor = fullBoxBody(tfhd) + 4;
		let base = moofStart;
		if (tfhdFlags & 0x1) {
			base = Number(moof.readBigUInt64BE(cursor));
			cursor += 8;
		}
		if (tfhdFlags & 0x2) cursor += 4;
		let defaultDuration = track.defaultSampleDuration;
		if (tfhdFlags & 0x8) {
			defaultDuration = moof.readUInt32BE(cursor);
			cursor += 4;
		}
		let defaultSize = track.defaultSampleSize;
		if (tfhdFlags & 0x10) {
			defaultSize = moof.readUInt32BE(cursor);
		}

		let dataPosition = base;
		for (const trun of children.filter((box) => box.type === "trun")) {
			const end = trun.start + trun.size;
			const flags = moof.readUInt32BE(trun.start + trun.headerSize) & 0xffffff;
			const count = moof.readUInt32BE(fullBoxBody(trun));
			let field = fullBoxBody(trun) + 4;
			if (flags & 0x1) {
				dataPosition = base + moof.readInt32BE(field);
				field += 4;
			}
			if (flags & 0x4) field += 4;
			const perSample =
				(flags & 0x100 ? 4 : 0) +
				(flags & 0x200 ? 4 : 0) +
				(flags & 0x400 ? 4 : 0) +
				(flags & 0x800 ? 4 : 0);
			for (let index = 0; index < count && field + perSample <= end; index += 1) {
				let duration = defaultDuration;
				let size = defaultSize;
				if (flags & 0x100) {
					duration = moof.readUInt32BE(field);
					field += 4;
				}
				if (flags & 0x200) {
					size = moof.readUInt32BE(field);
					field += 4;
				}
				if (flags & 0x400) field += 4;
				if (flags & 0x800) field += 4;
				if (dataPosition >= 0 && dataPosition + size <= validBytes) {
					tally.samples += 1;
					tally.duration += duration;
				}
				dataPosition += size;
			}
		}
	}
	return tally;
}

/** What a capture file on disk can still give back, without changing it. */
export async function inspectNativeMacCapture(
	filePath: string,
): Promise<NativeMacCaptureInspection> {
	let handle: fs.FileHandle | null = null;
	let fileBytes = 0;
	try {
		handle = await fs.open(filePath, "r");
		fileBytes = (await handle.stat()).size;
		const { boxes, validBytes } = await walkTopLevel(handle, fileBytes);
		const fail = (reason: string): NativeMacCaptureInspection => ({
			ok: false,
			reason,
			fileBytes,
			validBytes,
		});

		if (boxes[0]?.type !== "ftyp") {
			return fail("not an MP4 file");
		}
		const moovBox = boxes.find((box) => box.type === "moov");
		if (!moovBox) {
			return fail("no movie header in the readable part of the file");
		}
		if (moovBox.size > MAX_INDEX_BOX_BYTES) {
			return fail("the movie header is implausibly large");
		}
		const video = readVideoTrack(await readAt(handle, moovBox.start, moovBox.size), validBytes);
		if (!video) {
			return fail("no video track");
		}

		let samples = video.flat.samples;
		let duration = video.flat.duration;
		let fragments = 0;
		for (const moof of boxes.filter((box) => box.type === "moof")) {
			if (moof.size > MAX_INDEX_BOX_BYTES) {
				continue;
			}
			fragments += 1;
			const tally = tallyFragmentSamples(
				await readAt(handle, moof.start, moof.size),
				moof.start,
				video.track,
				validBytes,
			);
			samples += tally.samples;
			duration += tally.duration;
		}
		if (samples === 0) {
			return fail("no complete video frame in the file");
		}
		return {
			ok: true,
			fileBytes,
			validBytes,
			videoSamples: samples,
			durationSec: duration / video.track.timescale,
			fragments,
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
			fileBytes,
			validBytes: 0,
		};
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Makes a failed take's file openable if it can be, and says what it holds.
 *
 * Only for a file no process is writing to any more: the helper must have exited.
 * A torn tail is cut off and the result inspected again, so success always means
 * the file on disk opens as it is.
 */
export async function salvageNativeMacCapture(filePath: string): Promise<NativeMacSalvageResult> {
	const first = await inspectNativeMacCapture(filePath);
	if (!first.ok) {
		return { ok: false, reason: first.reason };
	}
	if (first.validBytes === first.fileBytes) {
		return {
			ok: true,
			screenVideoPath: filePath,
			videoSamples: first.videoSamples,
			durationSec: first.durationSec,
			truncatedBytes: 0,
		};
	}

	try {
		await fs.truncate(filePath, first.validBytes);
	} catch (error) {
		return {
			ok: false,
			reason: `could not cut off the torn end: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const second = await inspectNativeMacCapture(filePath);
	if (!second.ok) {
		return { ok: false, reason: second.reason };
	}
	if (second.validBytes !== second.fileBytes) {
		return { ok: false, reason: "the file is still torn after cutting off its end" };
	}
	return {
		ok: true,
		screenVideoPath: filePath,
		videoSamples: second.videoSamples,
		durationSec: second.durationSec,
		truncatedBytes: first.fileBytes - second.fileBytes,
	};
}

function formatDuration(seconds: number) {
	// Rounded, not floored: the frame durations of a 35 s take sum to 34.98 s, and
	// "0:34" would contradict the length the editor then shows.
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const rest = String(total % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * The file a failed stop may be salvaged from, or null.
 *
 * Only once the helper has exited: a stop that timed out leaves a helper that may
 * still be inside finishWriting, and salvaging truncates.
 */
export function nativeMacSalvageTarget(
	result: NativeMacCaptureStopResult,
	targetPath: string | null,
): string | null {
	return !result.ok && result.exited && targetPath ? targetPath : null;
}

/** NSError descriptions that say nothing a person can act on. */
const GENERIC_ERROR_DESCRIPTIONS = new Set(["The operation could not be completed"]);

/**
 * The warning for a take whose stop failed but whose file was recovered.
 *
 * The helper's messages are a sentence followed by a raw NSError, e.g. "Recording
 * stopped: the video file could not be written (video append: Error Domain=…
 * NSLocalizedDescription=Disk Full …)". The sentence is kept; the NSError is
 * reduced to its localized description, and only when that says something —
 * AVFoundation's -11800 says "The operation could not be completed".
 */
export function describeSalvagedTake(failureMessage: string, durationSec: number) {
	const text = failureMessage.trim().replace(/^Recording stopped:\s*/i, "");
	const description = /NSLocalizedDescription=([^,}]+)/.exec(text)?.[1]?.trim();
	const usefulDescription =
		description && !GENERIC_ERROR_DESCRIPTIONS.has(description) ? description : undefined;

	let reason = text;
	const errorStart = text.indexOf("Error Domain=");
	if (errorStart !== -1) {
		const openParen = text.lastIndexOf("(", errorStart);
		const sentence = text.slice(0, openParen === -1 ? errorStart : openParen).trim();
		if (sentence && usefulDescription) {
			reason = `${sentence} (${usefulDescription})`;
		} else {
			reason = sentence || usefulDescription || description || "the recorder failed";
		}
	}
	reason = reason.replace(/[.\s]+$/, "");
	return `Recording stopped after ${formatDuration(durationSec)}: ${reason}. The part recorded until then was saved.`;
}
