// The export runner's files, read and written through the main process in chunks, so that
// neither the render nor the output is ever whole in this renderer (issue #1385). The files are
// named by role: the main process knows their paths from the runner's own request.

import { StreamSource, StreamTarget, type StreamTargetChunk } from "mediabunny";
import type { CliExportFile } from "@/lib/cliContracts";

// Under the 64 MiB the main process accepts per call.
const READ_CHUNK_BYTES = 32 * 1024 * 1024;

async function readRange(file: CliExportFile, start: number, end: number): Promise<Uint8Array> {
	const bytes = new Uint8Array(end - start);
	let filled = 0;
	while (filled < bytes.length) {
		const length = Math.min(READ_CHUNK_BYTES, bytes.length - filled);
		const chunk = await window.electronAPI.cliExportFileRead(file, start + filled, length);
		// A short read would otherwise loop forever.
		if (chunk.byteLength === 0) throw new Error(`The export's ${file} file ended early`);
		bytes.set(new Uint8Array(chunk), filled);
		filled += chunk.byteLength;
	}
	return bytes;
}

/** A file of this export as a mediabunny source that reads only what is asked of it. */
export function exportFileSource(file: CliExportFile): StreamSource {
	return new StreamSource({
		getSize: () => window.electronAPI.cliExportFileSize(file),
		read: (start, end) => readRange(file, start, end),
		// Each read is an IPC round trip: fewer, larger ones.
		prefetchProfile: "network",
	});
}

/** A file of this export, whole. Only for what cannot be streamed. */
export async function readExportFile(file: CliExportFile): Promise<ArrayBuffer> {
	const size = await window.electronAPI.cliExportFileSize(file);
	return (await readRange(file, 0, size)).buffer as ArrayBuffer;
}

/** Writes this export's output as it is produced, then puts it in place. */
export async function writeExportOutput(
	produce: (target: StreamTarget) => Promise<void>,
): Promise<void> {
	const writable = new WritableStream<StreamTargetChunk>({
		write: (chunk) => window.electronAPI.cliExportFileWrite(chunk.data, chunk.position),
	});
	await produce(new StreamTarget(writable, { chunked: true }));
	await window.electronAPI.cliExportFileCommit();
}
