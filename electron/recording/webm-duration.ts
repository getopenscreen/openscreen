import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fixParsedWebmDuration } from "@fix-webm-duration/fix";
import { WebmFile } from "@fix-webm-duration/parser";

export type DurationPatchResult =
	| { patched: true }
	| { patched: false; reason: "no-section" | "already-valid" | "io-error" | "internal" };

// Read 2MB from the start of the file. Headers for WebM recordings are typically well under 100KB.
const HEADER_CHUNK_SIZE = 2 * 1024 * 1024;

/**
 * Patch the WebM Duration header on a finalized recording file.
 *
 * MediaRecorder writes WebM with no Duration EBML element.
 *
 * Rather than reading the entire multi-gigabyte file into memory (which crashes
 * the main process on long recordings), we read only the first 2MB chunk containing
 * the metadata headers, patch the Info section, and stream the remaining clusters
 * from the original file using Node streams.
 *
 * NOTE: This optimization handles the saving/finalization phase. For issues related
 * to streaming large files during the editor/export phase, see also PR #74.
 */
export async function patchWebmDurationOnDisk(
	filePath: string,
	durationMs: number,
): Promise<DurationPatchResult> {
	let fileHandle: fs.FileHandle | null = null;
	const tmpPath = `${filePath}.duration-patch.tmp`;
	try {
		const stat = await fs.stat(filePath);
		if (stat.size < HEADER_CHUNK_SIZE) {
			// Fallback: If file is smaller than 2MB, just use the in-memory method.
			return await patchWebmDurationInMemory(filePath, durationMs);
		}

		fileHandle = await fs.open(filePath, "r");
		const buffer = Buffer.alloc(HEADER_CHUNK_SIZE);
		const { bytesRead } = await fileHandle.read(buffer, 0, HEADER_CHUNK_SIZE, 0);
		await fileHandle.close();
		fileHandle = null;

		const chunk = buffer.subarray(0, bytesRead);
		const webm = new WebmFile(new Uint8Array(chunk));

		if (!webm.data || !webm.source) {
			console.warn(
				`[webm-duration] Segment data or source is missing in chunk for ${filePath}; falling back to whole-file`,
			);
			return await patchWebmDurationInMemory(filePath, durationMs);
		}

		// Find Segment in webm.data
		const segmentSec = webm.data.find((sec) => sec.id === 0x8538067);
		if (!segmentSec || !segmentSec.data) {
			console.warn(
				`[webm-duration] Segment section is missing in chunk for ${filePath}; falling back to whole-file`,
			);
			return await patchWebmDurationInMemory(filePath, durationMs);
		}

		interface WebmContainerShape {
			start: number;
			isInfinite?: boolean;
			data: { id: number; data: unknown }[];
		}
		const segment = segmentSec.data as WebmContainerShape;

		const info = (
			segment as unknown as { getSectionById?: (id: number) => unknown }
		).getSectionById?.(0x549a966);
		if (!info) {
			console.warn(
				`[webm-duration] Info section is missing in chunk for ${filePath}; falling back to whole-file`,
			);
			return await patchWebmDurationInMemory(filePath, durationMs);
		}

		// Calculate the start of the Segment's payload (content) using EBML VINT length rules
		const segmentStart = segment.start;
		const idByte = webm.source[segmentStart];
		const idLen = 9 - idByte.toString(2).length;
		const lenByte = webm.source[segmentStart + idLen];
		const lenLen = 9 - lenByte.toString(2).length;
		const segmentPayloadStart = segmentStart + idLen + lenLen;

		// Find the first Cluster section. ID is 0xf43b675.
		const segmentData = segment.data;
		const clusterIdx = segmentData.findIndex((sec) => sec.id === 0xf43b675);
		if (clusterIdx === -1) {
			console.warn(
				`[webm-duration] No Cluster section found in header chunk for ${filePath}; falling back to whole-file`,
			);
			return await patchWebmDurationInMemory(filePath, durationMs);
		}

		const clusterSec = segmentData[clusterIdx];
		const clusterData = clusterSec.data as { start: number };
		const clusterOffset = segmentPayloadStart + clusterData.start;

		// Truncate the segment children to remove the Cluster and everything after it.
		// This forces updateByData() to only regenerate/write the metadata headers.
		segment.data = segmentData.slice(0, clusterIdx);

		// Segment length was likely infinite (-1) or matching the original file. Since we are patching
		// headers and appending the original stream, setting Segment length to infinite (-1) is safe and standard.
		segment.isInfinite = true;

		const patched = fixParsedWebmDuration(webm, durationMs, { logger: false });
		if (!patched) {
			const reason = inferUnpatchedReason(webm);
			return { patched: false, reason };
		}

		if (!webm.source) {
			console.error(`[webm-duration] patched but source missing for ${filePath}`);
			return { patched: false, reason: "internal" };
		}

		const patchedBytes = Buffer.from(
			webm.source.buffer,
			webm.source.byteOffset,
			webm.source.byteLength,
		);

		// Now write the patched headers and stream append the rest of the original file
		const ws = createWriteStream(tmpPath);
		const rs = createReadStream(filePath, { start: clusterOffset });

		await new Promise<void>((resolve, reject) => {
			ws.write(patchedBytes, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});

		try {
			await pipeline(rs, ws);
		} finally {
			rs.destroy();
			ws.destroy();
		}

		await fs.rename(tmpPath, filePath);
		return { patched: true };
	} catch (error) {
		console.error(`[webm-duration] failed to patch ${filePath} using optimized method:`, error);
		if (fileHandle) {
			await fileHandle.close().catch(() => undefined);
		}
		await fs.unlink(tmpPath).catch(() => undefined);
		return { patched: false, reason: "io-error" };
	}
}

async function patchWebmDurationInMemory(
	filePath: string,
	durationMs: number,
): Promise<DurationPatchResult> {
	const tmpPath = `${filePath}.duration-patch.tmp`;
	try {
		const fileBytes = await fs.readFile(filePath);
		const webm = new WebmFile(new Uint8Array(fileBytes));

		const patched = fixParsedWebmDuration(webm, durationMs, { logger: false });
		if (!patched) {
			const reason = inferUnpatchedReason(webm);
			if (reason === "no-section") {
				console.warn(
					`[webm-duration] no Segment/Info section in ${filePath}; file may be truncated`,
				);
			}
			return { patched: false, reason };
		}

		if (!webm.source) {
			console.error(`[webm-duration] patched but source missing for ${filePath}`);
			return { patched: false, reason: "internal" };
		}

		const patchedBytes = Buffer.from(
			webm.source.buffer,
			webm.source.byteOffset,
			webm.source.byteLength,
		);
		try {
			await fs.writeFile(tmpPath, patchedBytes);
			await fs.rename(tmpPath, filePath);
			return { patched: true };
		} catch (writeError) {
			console.error(`[webm-duration] failed to write patched ${filePath}:`, writeError);
			await fs.unlink(tmpPath).catch(() => undefined);
			return { patched: false, reason: "io-error" };
		}
	} catch (error) {
		console.error(`[webm-duration] failed to patch ${filePath} in memory:`, error);
		return { patched: false, reason: "io-error" };
	}
}

/**
 * Distinguish "no Segment/Info section" (malformed/truncated file) from "Info present
 * but Duration already valid" (patch unnecessary).
 */
function inferUnpatchedReason(webm: WebmFile): "no-section" | "already-valid" {
	const segment = webm.getSectionById?.(0x8538067);
	if (!segment) return "no-section";
	const info = (
		segment as unknown as { getSectionById?: (id: number) => unknown }
	).getSectionById?.(0x549a966);
	return info ? "already-valid" : "no-section";
}
