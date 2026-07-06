/**
 * Largest source file we are willing to read whole via the `read-binary-file`
 * IPC and hand around as a single in-memory `ArrayBuffer`/`Blob`.
 *
 * `read-binary-file` reads the file with Node's `fs.readFile` (which itself
 * throws above 2 GiB) and returns the bytes over IPC, where Electron
 * structured-clones them — copying the whole buffer in the main process. For a
 * large recording this transiently needs ~2× the file size in the main process
 * and crashes it on a memory-constrained machine (observed: a ~1 GB recording
 * hard-crashes a 16 GB Mac). So the safe cutoff is far below the 2 GiB read cap.
 *
 * Above this size, recordings are streamed on demand instead — into OPFS in
 * fixed-size chunks for demuxing (export/captions), and the in-memory
 * source-copy and waveform paths are skipped.
 */
export const MAX_IN_MEMORY_SOURCE_BYTES = 256 * 1024 * 1024;
